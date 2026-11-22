// Data for the home screen: every active spot with its conditions and score right now.
// Light on purpose: one Open-Meteo request per API for ALL spots (multi-location, ~4 hours
// each), one predictions query for all spots, and one small reports call per spot for crowd.
// The full 18-day forecast is only loaded when a spot is opened.

import { useCallback, useEffect, useRef, useState } from 'react'
import { MARINE_URL, WEATHER_URL, FALLBACK_MARINE_MODEL } from './forecastRequest'
import { OPEN_METEO_TIMEOUT_MS, withTimeout } from './http'
import { readLastGood, writeLastGood } from './lastGood'
import type { HourConditions } from './openMeteo'
import type { Crowd } from './ratings'
import { FALLBACK_SPOTS, type Spot } from './spot'
import { rpc, selectRows, supabaseConfigured } from './supabase'

export interface SpotNow {
  spot: Spot
  /** Conditions for the current hour, null if Open-Meteo had nothing for this spot. */
  hour: HourConditions | null
  /** AI score for the current hour, when a model exists for this spot. */
  aiScore: number | null
  /** Most common crowd in today's surfer reports (null = no reports, or none said). */
  crowd: Crowd | null
  reports: number
}

export interface SpotListData {
  spots: Spot[]
  /** spot id -> a few hours around now (unix s -> conditions). */
  hours: Record<string, HourConditions[]>
  /** spot id -> (valid_at unix s -> AI score). */
  ai: Record<string, Record<number, number>>
  crowd: Record<string, { crowd: Crowd | null; count: number }>
  /** Unix ms of the Open-Meteo fetch. */
  fetchedAt: number
  /** Local date when crowd was read: a copy from another day isn't shown as today's. */
  crowdOn: string
}

export type SpotListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: SpotListData; stale: boolean; refreshing: boolean }

const SAVED_KEY = 'spot-list:v1'
const REFRESH_AFTER_MS = 30 * 60 * 1000
const CHECK_EVERY_MS = 5 * 60 * 1000
const todayKey = () => new Date().toDateString()

// ---------- spots ----------

interface SpotRow {
  id: string
  name: string
  lat: number
  lon: number
  beach_orientation: number
}

async function loadActiveSpots(signal: AbortSignal): Promise<Spot[]> {
  const rows = await selectRows<SpotRow>('spots', 'select=id,name,lat,lon,beach_orientation&active=eq.true&order=id', signal)
  const spots = rows.map((r) => ({ id: r.id, name: r.name, lat: r.lat, lon: r.lon, beachOrientation: r.beach_orientation }))
  // Each spot's own key too, so opening it starts with the right coordinates at once.
  for (const s of spots) writeLastGood(`spot:${s.id}`, s)
  return spots
}

// ---------- Open-Meteo, all spots in one request ----------

const MARINE_VARS = ['wave_height', 'wave_period', 'wave_direction', 'swell_wave_height', 'swell_wave_period', 'swell_wave_direction', 'sea_level_height_msl']
const WAVE_ONLY = MARINE_VARS.slice(0, 6)
const WIND_VARS = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'is_day']

type Hourly = Record<string, (number | null)[]> & { time: number[] }
interface Located {
  hourly: Hourly
}

async function getMany(url: string, spots: Spot[], params: Record<string, string>, signal: AbortSignal): Promise<Located[]> {
  const q = new URLSearchParams({
    latitude: spots.map((s) => s.lat).join(','),
    longitude: spots.map((s) => s.lon).join(','),
    timeformat: 'unixtime',
    past_hours: '1',
    forecast_hours: '4',
    ...params,
  })
  return withTimeout(signal, OPEN_METEO_TIMEOUT_MS, 'Open-Meteo', async (s) => {
    const res = await fetch(`${url}?${q}`, { signal: s })
    if (!res.ok) throw new Error(`Open-Meteo ${new URL(url).hostname}: HTTP ${res.status}`)
    const body = (await res.json()) as Located | Located[]
    return Array.isArray(body) ? body : [body] // one location comes back as an object
  })
}

const v = (h: Hourly | undefined, name: string, i: number | undefined): number | null =>
  h && i !== undefined ? (h[name]?.[i] ?? null) : null

async function loadHours(spots: Spot[], signal: AbortSignal): Promise<Record<string, HourConditions[]>> {
  if (!spots.length) return {}
  const [marine, weather] = await Promise.all([
    getMany(MARINE_URL, spots, { hourly: MARINE_VARS.join(',') }, signal),
    getMany(WEATHER_URL, spots, { hourly: WIND_VARS.join(',') }, signal),
  ])
  // Same null fallback as the full forecast: GFS wave fills hours the default model leaves empty.
  const gaps = spots.filter((_, i) => marine[i]?.hourly.wave_height?.some((x) => x == null))
  if (gaps.length) {
    try {
      const fb = await getMany(MARINE_URL, gaps, { hourly: WAVE_ONLY.join(','), models: FALLBACK_MARINE_MODEL }, signal)
      gaps.forEach((spot, gi) => {
        const m = marine[spots.indexOf(spot)]?.hourly
        const f = fb[gi]?.hourly
        if (!m || !f) return
        const idx = new Map(f.time.map((t, j) => [t, j]))
        m.time.forEach((t, i) => {
          for (const name of WAVE_ONLY) if (m[name] && m[name][i] == null) m[name][i] = v(f, name, idx.get(t))
        })
      })
    } catch (err) {
      if (signal.aborted) throw err
    }
  }
  const out: Record<string, HourConditions[]> = {}
  spots.forEach((spot, i) => {
    const m = marine[i]?.hourly
    const w = weather[i]?.hourly
    if (!m) return
    const wi = new Map((w?.time ?? []).map((t, j) => [t, j]))
    out[spot.id] = m.time.map((t, j) => {
      const k = wi.get(t)
      return {
        time: t,
        waveHeight: v(m, 'wave_height', j),
        wavePeriod: v(m, 'wave_period', j),
        waveDirection: v(m, 'wave_direction', j),
        swellHeight: v(m, 'swell_wave_height', j),
        swellPeriod: v(m, 'swell_wave_period', j),
        swellDirection: v(m, 'swell_wave_direction', j),
        tide: v(m, 'sea_level_height_msl', j),
        windSpeed: v(w, 'wind_speed_10m', k),
        windDirection: v(w, 'wind_direction_10m', k),
        windGusts: v(w, 'wind_gusts_10m', k),
        isDay: k === undefined ? true : v(w, 'is_day', k) === 1,
      }
    })
  })
  return out
}

// ---------- Supabase: AI scores + crowd ----------

async function loadAi(spots: Spot[], signal: AbortSignal): Promise<Record<string, Record<number, number>> | null> {
  if (!supabaseConfigured || !spots.length) return {}
  const now = Date.now() / 1000
  const iso = (u: number) => encodeURIComponent(new Date(u * 1000).toISOString())
  try {
    const rows = await selectRows<{ spot_id: string; valid_at: string; ai_score: number }>(
      'predictions',
      [
        'select=spot_id,valid_at,ai_score',
        `spot_id=in.(${spots.map((s) => encodeURIComponent(s.id)).join(',')})`,
        `valid_at=gte.${iso(now - 2 * 3600)}`,
        `valid_at=lte.${iso(now + 5 * 3600)}`,
        'ai_score=not.is.null',
      ].join('&'),
      signal,
    )
    const out: Record<string, Record<number, number>> = {}
    for (const r of rows) (out[r.spot_id] ??= {})[Math.round(Date.parse(r.valid_at) / 1000)] = r.ai_score
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
      aiScore: hour ? (data.ai[spot.id]?.[hour.time] ?? null) : null,
      crowd: c?.crowd ?? null,
      reports: c?.count ?? 0,
    }
  })
}

const coversNow = (d: SpotListData) => {
  const nowS = Date.now() / 1000
  return d.spots.every((s) => (d.hours[s.id] ?? []).some((h) => nowS >= h.time && nowS < h.time + 3600))
}
const fresh = (d: SpotListData) => Date.now() - d.fetchedAt < REFRESH_AFTER_MS && coversNow(d)
const sameSpots = (a: Spot[], b: Spot[]) =>
  a.length === b.length && a.every((s, i) => s.id === b[i].id && s.lat === b[i].lat && s.lon === b[i].lon && s.name === b[i].name && s.beachOrientation === b[i].beachOrientation)

function savedState(): SpotListState {
  const saved = readLastGood<SpotListData>(SAVED_KEY)
  if (!saved) return { status: 'loading' }
  const ok = fresh(saved)
  return { status: 'ready', data: saved, stale: !ok, refreshing: !ok }
}

/**
 * Shows the saved list at once (instant, offline), then refreshes: spots, conditions, AI and
 * crowd in parallel. Conditions start with the spots already known (saved or built-in) so they
 * don't wait for the spot list; if the database has other spots, they're fetched again.
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
    const hoursP = reuse ? Promise.resolve(saved.hours) : loadHours(known, signal)
    const [spotsR, hoursR, aiR, crowdR] = await Promise.allSettled([
      spotsP,
      hoursP,
      spotsP.catch(() => known).then((s) => loadAi(s, signal)),
      spotsP.catch(() => known).then((s) => loadCrowd(s, signal)),
    ])
    if (signal.aborted) return

    const spots = spotsR.status === 'fulfilled' ? spotsR.value : known
    if (spotsR.status === 'fulfilled') writeLastGood('spots:list', spots)
    let hours = hoursR.status === 'fulfilled' ? hoursR.value : null
    let fetchedAt = reuse || hoursR.status === 'rejected' ? (saved?.fetchedAt ?? 0) : Date.now()
    if (!sameSpots(spots, known)) {
      // The database has spots the first request didn't cover (or moved one).
      try {
        hours = await loadHours(spots, signal)
        fetchedAt = Date.now()
      } catch {
        if (signal.aborted) return
      }
    }
    if (signal.aborted) return
    if (!hours) hours = saved?.hours ?? null

    if (!hours) {
      const reason = hoursR.status === 'rejected' ? hoursR.reason : null
      setState({
        status: 'error',
        message: !navigator.onLine
          ? 'You’re offline and there’s no saved forecast on this phone yet.'
          : reason instanceof Error
            ? reason.message
            : 'Open-Meteo didn’t answer.',
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
    }
    writeLastGood(SAVED_KEY, data)
    setState({ status: 'ready', data, stale: !fresh(data), refreshing: false })
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
