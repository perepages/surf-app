// Data for the home screen: every active spot with its conditions and score right now.
// Light on purpose: ONE forecast file for all spots (/api/forecast?spot=all, published hourly by
// jobs/collect_forecast.py; the app never calls Open-Meteo itself), one predictions query for
// all spots, and one small reports call per spot for crowd.
// The full 18-day forecast is only loaded when a spot is opened.

import { useCallback, useEffect, useRef, useState } from 'react'
import { decodeHours, getForecastFile, type FilePart, type HourConditions } from './forecast'
import { CACHE_TTL_MS, OLD_AFTER_MS, SPOT_LIST_URL } from './forecastRequest'
import { readLastGood, writeLastGood } from './lastGood'
import type { AiPrediction } from './predictions'
import type { Crowd } from './ratings'
import { FALLBACK_SPOTS, SPOT_COLUMNS, spotFromRow, type Spot, type SpotRow } from './spot'
import { rpc, selectRows, supabaseConfigured } from './supabase'

export interface SpotNow {
  spot: Spot
  /** Conditions for the current hour, null if Open-Meteo had nothing for this spot. */
  hour: HourConditions | null
  /** The model's Waves / Shape for the current hour, when a model exists for this spot. */
  ai: AiPrediction | null
  /** Most common crowd in today's surfer reports (null = no reports, or none said). */
  crowd: Crowd | null
  reports: number
}

export interface SpotListData {
  spots: Spot[]
  /** spot id -> the last 72 h (wind/rain history) and the next 4 (unix s -> conditions). */
  hours: Record<string, HourConditions[]>
  /** spot id -> (valid_at unix s -> AI prediction). */
  ai: Record<string, Record<number, AiPrediction>>
  crowd: Record<string, { crowd: Crowd | null; count: number }>
  /** Unix ms when the job asked Open-Meteo (oldest spot in the file). */
  fetchedAt: number
  /** Unix ms when this phone downloaded the file. */
  checkedAt: number
  /** Local date when crowd was read: a copy from another day isn't shown as today's. */
  crowdOn: string
}

export type SpotListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: SpotListData; stale: boolean; refreshing: boolean }

const SAVED_KEY = 'spot-list:v3'
const CHECK_EVERY_MS = 5 * 60 * 1000
const todayKey = () => new Date().toDateString()

// ---------- spots ----------

async function loadActiveSpots(signal: AbortSignal): Promise<Spot[]> {
  const rows = await selectRows<SpotRow>('spots', `select=${SPOT_COLUMNS}&active=eq.true&order=id`, signal)
  const spots = rows.map(spotFromRow)
  // Each spot's own key too, so opening it starts with the right coordinates at once.
  for (const s of spots) writeLastGood(`spot:${s.id}`, s)
  return spots
}

// ---------- forecast: all spots in one file ----------

/** The hours around now for every spot in the file (the history the score needs + a day ahead). */
async function loadHours(signal: AbortSignal): Promise<{ hours: Record<string, HourConditions[]>; fetchedAt: number }> {
  const file = await getForecastFile<{ fetchedAt: string; spots: Record<string, FilePart> }>(SPOT_LIST_URL, signal)
  const hours: Record<string, HourConditions[]> = {}
  for (const [id, part] of Object.entries(file.spots)) hours[id] = decodeHours(part)
  return { hours, fetchedAt: Date.parse(file.fetchedAt) || Date.now() }
}

// ---------- Supabase: AI scores + crowd ----------

async function loadAi(spots: Spot[], signal: AbortSignal): Promise<SpotListData['ai'] | null> {
  if (!supabaseConfigured || !spots.length) return {}
  const now = Date.now() / 1000
  const iso = (u: number) => encodeURIComponent(new Date(u * 1000).toISOString())
  try {
    const rows = await selectRows<{
      spot_id: string
      valid_at: string
      ai_score: number
      ai_waves: number | null
      ai_shape: number | null
    }>(
      'predictions',
      [
        'select=spot_id,valid_at,ai_score,ai_waves,ai_shape',
        `spot_id=in.(${spots.map((s) => encodeURIComponent(s.id)).join(',')})`,
        `valid_at=gte.${iso(now - 2 * 3600)}`,
        `valid_at=lte.${iso(now + 5 * 3600)}`,
        'ai_waves=not.is.null',
      ].join('&'),
      signal,
    )
    const out: SpotListData['ai'] = {}
    for (const r of rows) {
      const validAt = Math.round(Date.parse(r.valid_at) / 1000)
      ;(out[r.spot_id] ??= {})[validAt] = {
        validAt,
        aiScore: r.ai_score,
        aiWaves: r.ai_waves,
        aiShape: r.ai_shape,
        reason: null,
        modelVersion: null,
      }
    }
    return out
  } catch (err) {
    if (signal.aborted) throw err
    return null // keep the last copy
  }
}

async function loadCrowd(spots: Spot[], signal: AbortSignal): Promise<SpotListData['crowd'] | null> {
  if (!supabaseConfigured || !spots.length) return {}
  const results = await Promise.allSettled(
    spots.map((s) => rpc<{ count: number; crowd: Crowd | null }>('spot_reports_today', { p_spot_id: s.id }, signal)),
  )
  if (signal.aborted) return null
  if (results.every((r) => r.status === 'rejected')) return null
  const out: SpotListData['crowd'] = {}
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out[spots[i].id] = { crowd: r.value.crowd, count: r.value.count }
  })
  return out
}

// ---------- picking "now" ----------

/** The hour that contains `nowS` (or the closest one we have). */
export function currentHour(hours: HourConditions[] | undefined, nowS: number): HourConditions | null {
  if (!hours?.length) return null
  return hours.find((h) => nowS < h.time + 3600 && nowS >= h.time) ?? hours.find((h) => nowS < h.time + 3600) ?? hours.at(-1)!
}

export function spotsNow(data: SpotListData, nowS: number): SpotNow[] {
  const crowdToday = data.crowdOn === todayKey()
  return data.spots.map((spot) => {
    const hour = currentHour(data.hours[spot.id], nowS)
    const c = crowdToday ? data.crowd[spot.id] : undefined
    return {
      spot,
      hour,
      ai: hour ? (data.ai[spot.id]?.[hour.time] ?? null) : null,
      crowd: c?.crowd ?? null,
      reports: c?.count ?? 0,
    }
  })
}

const coversNow = (d: SpotListData) => {
  const nowS = Date.now() / 1000
  return d.spots.every((s) => (d.hours[s.id] ?? []).some((h) => nowS >= h.time && nowS < h.time + 3600))
}
const fresh = (d: SpotListData) => Date.now() - (d.checkedAt ?? d.fetchedAt) < CACHE_TTL_MS && coversNow(d)
/** "Old" (banner) when the job hasn't published for hours, even if just downloaded. */
const isOld = (d: SpotListData) => Date.now() - d.fetchedAt > OLD_AFTER_MS

function savedState(): SpotListState {
  const saved = readLastGood<SpotListData>(SAVED_KEY)
  if (!saved) return { status: 'loading' }
  const ok = fresh(saved)
  return { status: 'ready', data: saved, stale: !ok || isOld(saved), refreshing: !ok }
}

/**
 * Shows the saved list at once (instant, offline), then refreshes: spots, conditions, AI and
 * crowd in parallel. The forecast file covers every active spot, so it doesn't wait for the
 * spot list.
 */
export function useSpotList() {
  const [state, setState] = useState<SpotListState>(savedState)
  const controller = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    controller.current?.abort()
    const ac = new AbortController()
    controller.current = ac
    const { signal } = ac
    const saved = readLastGood<SpotListData>(SAVED_KEY)
    const known = saved?.spots ?? readLastGood<Spot[]>('spots:list') ?? Object.values(FALLBACK_SPOTS)

    const spotsP = supabaseConfigured ? loadActiveSpots(signal) : Promise.resolve(known)
    const reuse = saved != null && fresh(saved)
    const hoursP = reuse ? Promise.resolve({ hours: saved.hours, fetchedAt: saved.fetchedAt }) : loadHours(signal)
    const [spotsR, hoursR, aiR, crowdR] = await Promise.allSettled([
      spotsP,
      hoursP,
      spotsP.catch(() => known).then((s) => loadAi(s, signal)),
      spotsP.catch(() => known).then((s) => loadCrowd(s, signal)),
    ])
    if (signal.aborted) return

    const spots = spotsR.status === 'fulfilled' ? spotsR.value : known
    if (spotsR.status === 'fulfilled') writeLastGood('spots:list', spots)
    // The file has every active spot, so a spot list that differs from the saved one needs nothing more.
    const hours = hoursR.status === 'fulfilled' ? hoursR.value.hours : (saved?.hours ?? null)
    const fetchedAt = hoursR.status === 'fulfilled' ? hoursR.value.fetchedAt : (saved?.fetchedAt ?? 0)
    const checkedAt = hoursR.status === 'fulfilled' && !reuse ? Date.now() : (saved?.checkedAt ?? 0)

    if (!hours) {
      const reason = hoursR.status === 'rejected' ? hoursR.reason : null
      setState({
        status: 'error',
        message: !navigator.onLine
          ? 'You’re offline and there’s no saved forecast on this phone yet.'
          : reason instanceof Error
            ? reason.message
            : 'The forecast didn’t load.',
      })
      return
    }
    const data: SpotListData = {
      spots,
      hours,
      ai: (aiR.status === 'fulfilled' && aiR.value) || saved?.ai || {},
      crowd: (crowdR.status === 'fulfilled' && crowdR.value) || (saved?.crowdOn === todayKey() ? saved.crowd : {}),
      crowdOn: crowdR.status === 'fulfilled' && crowdR.value ? todayKey() : (saved?.crowdOn ?? todayKey()),
      fetchedAt,
      checkedAt,
    }
    writeLastGood(SAVED_KEY, data)
    setState({ status: 'ready', data, stale: !fresh(data) || isOld(data), refreshing: false })
  }, [])

  useEffect(() => {
    void load()
    return () => controller.current?.abort()
  }, [load])

  // Same rhythm as a spot's forecast: refresh when older than 30 min or the hour moved on,
  // checked every 5 min while visible, and when back online.
  const fetchedAt = state.status === 'ready' ? state.data.fetchedAt : 0
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return
      const saved = readLastGood<SpotListData>(SAVED_KEY)
      if (!saved || !fresh(saved)) void load()
    }
    const onOnline = () => void load()
    document.addEventListener('visibilitychange', check)
    window.addEventListener('online', onOnline)
    const timer = setInterval(check, CHECK_EVERY_MS)
    return () => {
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('online', onOnline)
      clearInterval(timer)
    }
  }, [fetchedAt, load])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    void load()
  }, [load])

  return { state, retry }
}
