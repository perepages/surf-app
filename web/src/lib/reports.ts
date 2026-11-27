// Public summaries of surfer reports (database functions from migration 7).
// The raw ratings stay private; these return only counts, averages and recent comments.

import { useEffect, useState } from 'react'
import { EXTRAS_FRESH_MS, EXTRAS_WAIT_MS, onExtras } from './extras'
import { readLastGood, writeLastGood } from './lastGood'
import { rpc, supabaseConfigured } from './supabase'
import type { Crowd, WaveSize } from './ratings'

export interface TodayReports {
  count: number
  avgOverall: number | null
  waveSize: WaveSize | null
  crowd: Crowd | null
  comments: { comment: string; overall: number; surfedAt: number }[]
}

export interface DailyRating {
  /** Spot local date, YYYY-MM-DD. */
  day: string
  reports: number
  avgOverall: number
}

export const CHART_DAYS = 14

interface TodayRow {
  count: number
  avg_overall: number | null
  wave_size: WaveSize | null
  crowd: Crowd | null
  comments: { comment: string; overall: number; surfed_at: string }[]
}

function toToday(r: TodayRow): TodayReports {
  return {
    count: r.count,
    avgOverall: r.avg_overall == null ? null : Number(r.avg_overall),
    waveSize: r.wave_size,
    crowd: r.crowd,
    comments: r.comments.map((c) => ({ comment: c.comment, overall: c.overall, surfedAt: Date.parse(c.surfed_at) / 1000 })),
  }
}

type DailyRow = { day: string; reports: number; avg_overall: number | string }
const toDaily = (rows: DailyRow[]): DailyRating[] => rows.map((r) => ({ day: r.day, reports: r.reports, avgOverall: Number(r.avg_overall) }))

async function loadToday(spotId: string, signal: AbortSignal): Promise<TodayReports> {
  return toToday(await rpc<TodayRow>('spot_reports_today', { p_spot_id: spotId }, signal))
}

async function loadDaily(spotId: string, signal: AbortSignal): Promise<DailyRating[]> {
  return toDaily(await rpc<DailyRow[]>('spot_daily_ratings', { p_spot_id: spotId, p_days: CHART_DAYS }, signal))
}

export type ReportsState =
  | { status: 'loading' }
  /** Supabase missing or the functions aren't there (migration 7 not applied): sections hide or say so. */
  | { status: 'unavailable' }
  | { status: 'ready'; today: TodayReports; daily: DailyRating[]; savedOn: string }

type Saved = { today: TodayReports; daily: DailyRating[]; savedOn: string; savedAt?: number }

/** A saved copy is only used on the day it was saved: "today's reports" from yesterday would mislead. */
const todayKey = () => new Date().toDateString()

/**
 * Both summaries, starting from the last saved copy (instant, and works offline). New copies
 * normally arrive with the forecast (its `extras`, lib/extras.ts), which the forecast hook
 * re-downloads every 15 min while the app is on screen and when back online. Supabase is read
 * directly only when the extras lack them, when none arrived within EXTRAS_WAIT_MS and the saved
 * copy is old, or after the user sent a rating (`refreshKey` changes), so it shows at once; the
 * CDN's copy (up to 10 min old) is then ignored for a while so it can't hide the new rating.
 */
export function useReports(spotId: string, refreshKey: number): ReportsState {
  const [state, setState] = useState<ReportsState>(() => {
    const saved = readLastGood<Saved>(`reports:${spotId}`)
    return saved && saved.savedOn === todayKey()
      ? { status: 'ready', today: saved.today, daily: saved.daily, savedOn: saved.savedOn }
      : { status: 'loading' }
  })
  useEffect(() => {
    if (!supabaseConfigured) return
    const ac = new AbortController()
    const save = (today: TodayReports, daily: DailyRating[]) => {
      const savedOn = todayKey()
      writeLastGood<Saved>(`reports:${spotId}`, { today, daily, savedOn, savedAt: Date.now() })
      setState({ status: 'ready', today, daily, savedOn })
    }
    let readDirect = false
    let ignoreExtrasUntil = 0
    const direct = () => {
      if (readDirect) return
      readDirect = true
      Promise.all([loadToday(spotId, ac.signal), loadDaily(spotId, ac.signal)])
        .then(([today, daily]) => save(today, daily))
        .catch((err) => {
          if (ac.signal.aborted) return
          console.warn('Could not load surfer reports', err)
          // Keep showing the copy on screen, unless it is from an earlier day (the app was left open
          // overnight): yesterday's "today" would mislead.
          setState((prev) => (prev.status === 'ready' && prev.savedOn === todayKey() ? prev : { status: 'unavailable' }))
        })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = onExtras(spotId, (x) => {
      clearTimeout(timer)
      if (Date.now() < ignoreExtrasUntil) return
      if (x.reports && Array.isArray(x.daily)) save(toToday(x.reports as TodayRow), toDaily(x.daily as DailyRow[]))
      else direct()
    })
    if (refreshKey > 0) {
      // Just rated: straight from the database, and the CDN's older copy can't overwrite it.
      ignoreExtrasUntil = Date.now() + EXTRAS_FRESH_MS
      direct()
    } else {
      const saved = readLastGood<Saved>(`reports:${spotId}`)
      const fresh = saved?.savedOn === todayKey() && Date.now() - (saved.savedAt ?? 0) < EXTRAS_FRESH_MS
      if (!fresh) timer = setTimeout(direct, EXTRAS_WAIT_MS)
    }
    return () => {
      off()
      clearTimeout(timer)
      ac.abort()
    }
  }, [spotId, refreshKey])
  return supabaseConfigured ? state : { status: 'unavailable' }
}
