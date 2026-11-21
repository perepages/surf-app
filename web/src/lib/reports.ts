// Public summaries of surfer reports (database functions from migration 7).
// The raw ratings stay private; these return only counts, averages and recent comments.

import { useEffect, useState } from 'react'
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
const REFRESH_EVERY_MS = 15 * 60 * 1000

interface TodayRow {
  count: number
  avg_overall: number | null
  wave_size: WaveSize | null
  crowd: Crowd | null
  comments: { comment: string; overall: number; surfed_at: string }[]
}

async function loadToday(spotId: string, signal: AbortSignal): Promise<TodayReports> {
  const r = await rpc<TodayRow>('spot_reports_today', { p_spot_id: spotId }, signal)
  return {
    count: r.count,
    avgOverall: r.avg_overall == null ? null : Number(r.avg_overall),
    waveSize: r.wave_size,
    crowd: r.crowd,
    comments: r.comments.map((c) => ({ comment: c.comment, overall: c.overall, surfedAt: Date.parse(c.surfed_at) / 1000 })),
  }
}

async function loadDaily(spotId: string, signal: AbortSignal): Promise<DailyRating[]> {
  const rows = await rpc<{ day: string; reports: number; avg_overall: number | string }[]>(
    'spot_daily_ratings',
    { p_spot_id: spotId, p_days: CHART_DAYS },
    signal,
  )
  return rows.map((r) => ({ day: r.day, reports: r.reports, avgOverall: Number(r.avg_overall) }))
}

export type ReportsState =
  | { status: 'loading' }
  /** Supabase missing or the functions aren't there (migration 7 not applied): sections hide or say so. */
  | { status: 'unavailable' }
  | { status: 'ready'; today: TodayReports; daily: DailyRating[]; savedOn: string }

type Saved = { today: TodayReports; daily: DailyRating[]; savedOn: string }

/** A saved copy is only used on the day it was saved: "today's reports" from yesterday would mislead. */
const todayKey = () => new Date().toDateString()

/**
 * Loads both summaries, starting from the last saved copy (instant, and works offline);
 * `refreshKey` changes after the user sends a rating, so it shows up. Also reloads when the
 * phone comes back online and, while the app is on screen, every 15 minutes (an app left open
 * keeps up, also across midnight).
 */
export function useReports(spotId: string, refreshKey: number): ReportsState {
  const [state, setState] = useState<ReportsState>(() => {
    const saved = readLastGood<Saved>(`reports:${spotId}`)
    return saved && saved.savedOn === todayKey()
      ? { status: 'ready', today: saved.today, daily: saved.daily, savedOn: saved.savedOn }
      : { status: 'loading' }
  })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const bump = () => setTick((t) => t + 1)
    const timer = setInterval(() => document.visibilityState === 'visible' && bump(), REFRESH_EVERY_MS)
    window.addEventListener('online', bump)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', bump)
    }
  }, [])
  useEffect(() => {
    if (!supabaseConfigured) return
    const ac = new AbortController()
    Promise.all([loadToday(spotId, ac.signal), loadDaily(spotId, ac.signal)])
      .then(([today, daily]) => {
        const savedOn = todayKey()
        writeLastGood<Saved>(`reports:${spotId}`, { today, daily, savedOn })
        setState({ status: 'ready', today, daily, savedOn })
      })
      .catch((err) => {
        if (ac.signal.aborted) return
        console.warn('Could not load surfer reports', err)
        // Keep showing the copy on screen, unless it is from an earlier day (the app was left open
        // overnight): yesterday's "today" would mislead.
        setState((prev) => (prev.status === 'ready' && prev.savedOn === todayKey() ? prev : { status: 'unavailable' }))
      })
    return () => ac.abort()
  }, [spotId, refreshKey, tick])
  return supabaseConfigured ? state : { status: 'unavailable' }
}
