// The simple 1-5 score, used until a trained model exists for a spot.
// It is deliberately small and readable: rules of thumb for a Mediterranean beach break,
// where waves are usually small, short-period and very sensitive to wind.
// The nightly model replaces this through the predictions table (see resolveScore.ts).

import type { HourConditions } from '../lib/openMeteo'
import { angleDiff, compass, windRelation } from '../lib/geo'
import type { Spot } from '../lib/spot'
import { SCORE_LABELS, toScoreValue, type Score } from './types'

/** Below this effective height (m) there is nothing to ride. */
const FLAT_BELOW = 0.25
/** Effective height (m) at which each base score starts. */
const SIZE_STEPS: [number, number][] = [
  [1.3, 5],
  [0.8, 4],
  [0.45, 3],
  [0, 2],
]

/** How much of the waves reach the beach, from the angle between wave and beach direction. */
function exposure(waveFrom: number | null, beachFaces: number): number {
  if (waveFrom == null) return 1
  const d = angleDiff(waveFrom, beachFaces)
  if (d <= 45) return 1
  if (d <= 90) return 1 - ((d - 45) / 45) * 0.6 // 1 -> 0.4
  return 0.15 // coming from behind the coast
}

const m = (x: number) => `${x.toFixed(1)} m`

export function simpleScore(h: HourConditions, spot: Spot): Score {
  const height = h.waveHeight ?? h.swellHeight ?? 0
  const period = h.swellPeriod ?? h.wavePeriod ?? 0
  const waveFrom = h.waveDirection ?? h.swellDirection
  const wind = h.windSpeed ?? 0
  const rel = h.windDirection == null ? 'cross' : windRelation(h.windDirection, spot.beachOrientation)

  const make = (v: number, reason: string): Score => {
    const value = toScoreValue(v)
    return { value, label: SCORE_LABELS[value], reason, source: 'simple' }
  }

  const effective = height * exposure(waveFrom, spot.beachOrientation)
  if (height < FLAT_BELOW) return make(1, `Flat, only ${m(height)} of wave`)
  if (effective < FLAT_BELOW) {
    return make(1, `${m(height)} from the ${compass(waveFrom ?? 0)}, but it doesn't reach the beach`)
  }

  const base = SIZE_STEPS.find(([min]) => effective >= min)![1]

  // Period: short wind chop is weak, longer period has more push.
  const periodAdj = period > 0 && period < 5 ? -1 : period >= 8 ? 1 : 0

  // Wind: light wind is fine from anywhere; offshore grooms the waves; onshore ruins them.
  let windAdj = 0
  if (wind >= 10) {
    if (rel === 'offshore') windAdj = wind > 35 ? -1 : wind <= 25 ? 1 : 0
    else if (rel === 'cross') windAdj = wind >= 30 ? -2 : wind >= 15 ? -1 : 0
    else windAdj = wind >= 22 ? -2 : wind >= 12 ? -1 : 0
  }

  // Bonuses only add one point at most; penalties stack.
  const bonus = Math.min(1, Math.max(0, periodAdj) + Math.max(0, windAdj))
  const penalty = Math.min(0, periodAdj) + Math.min(0, windAdj)
  const total = base + bonus + penalty

  // Reason: say the thing that mattered most.
  const windWords = wind < 10 ? 'almost no wind' : `${Math.round(wind)} km/h ${rel === 'cross' ? 'cross-shore' : rel}`
  const swell = `${m(height)} at ${Math.round(period)} s from the ${compass(waveFrom ?? 0)}`
  let reason: string
  if (windAdj <= -1) reason = `${m(height)} but messed up by ${windWords} wind`
  else if (periodAdj < 0) reason = `${m(height)} of weak ${Math.round(period)} s wind chop, ${windWords}`
  else reason = `${swell}, ${windWords}${wind < 10 ? '' : ' wind'}`

  return make(total, reason)
}
