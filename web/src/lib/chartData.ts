// Data for the "Forecast vs surfers" chart: one row per day for the last 14 days.
//
// - simple:  the simple score, averaged over daylight hours. For past days it is recomputed
//            from Open-Meteo's numbers for that day (past_days), i.e. what the simple rules make
//            of the conditions, not necessarily what the app showed days ahead.
// - ai:      the AI score from the predictions table, averaged over daylight hours (null until
//            a model has written scores for that day).
// - surfers: the average community rating that day (null on days nobody rated).

import { dayOfMonth, weekday } from './format'
import type { Forecast } from './openMeteo'
import type { AiPrediction } from './predictions'
import type { DailyRating } from './reports'
import type { Spot } from './spot'
import { simpleScore } from '../scoring/simpleScore'

export interface ChartRow {
  day: string
  label: string
  simple: number | null
  ai: number | null
  surfers: number | null
  reports: number
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const round1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10)

export function buildChartRows(
  forecast: Forecast,
  spot: Spot,
  ai: Map<number, AiPrediction>,
  daily: DailyRating[],
  today: string,
  days: number,
): ChartRow[] {
  const byDay = new Map(daily.map((d) => [d.day, d]))
  return forecast.days
    .filter((d) => d.date <= today)
    .slice(-days)
    .map((d) => {
      const light = d.hours.filter((h) => h.isDay)
      const noon = d.hours[Math.floor(d.hours.length / 2)].time
      const rated = byDay.get(d.date)
      return {
        day: d.date,
        label: `${weekday(noon, forecast.timezone)} ${dayOfMonth(noon, forecast.timezone)}`,
        simple: round1(mean(light.map((h) => simpleScore(h, spot).value))),
        ai: round1(mean(light.flatMap((h) => (ai.has(h.time) ? [ai.get(h.time)!.aiScore] : [])))),
        surfers: rated ? round1(rated.avgOverall) : null,
        reports: rated?.reports ?? 0,
      }
    })
}

/** Average distance from the surfers' rating, on days where both exist. */
export function averageMiss(rows: ChartRow[], key: 'simple' | 'ai'): { miss: number; days: number } | null {
  const pairs = rows.filter((r) => r[key] != null && r.surfers != null)
  if (!pairs.length) return null
  const miss = mean(pairs.map((r) => Math.abs(r[key]! - r.surfers!)))!
  return { miss: Math.round(miss * 10) / 10, days: pairs.length }
}
