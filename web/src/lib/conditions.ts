// Derived numbers shown next to the raw forecast: wave power and how the wind hits the beach.

import { windRelation, type WindRelation } from './geo'
import type { HourConditions } from './forecast'

export type PowerLevel = 1 | 2 | 3 | 4

export interface WavePower {
  /** kW per metre of wave front. */
  kw: number
  level: PowerLevel
  word: 'Weak' | 'Medium' | 'Strong' | 'Heavy'
}

const POWER_WORDS = ['', 'Weak', 'Medium', 'Strong', 'Heavy'] as const

/**
 * Wave power (energy flux) ≈ 0.49 × height² × period, in kW per metre of wave front: the standard
 * deep-water estimate (ρg²/64π × Hs² × Te), from the wave height and period we already fetch.
 * Near the beach the real number is lower, but it ranks hours and days correctly.
 * Levels for a Mediterranean beach break: under 2 weak, 2-5 medium, 5-10 strong, 10+ heavy.
 */
export function wavePower(h: HourConditions): WavePower | null {
  const height = h.waveHeight ?? h.swellHeight
  const period = h.wavePeriod ?? h.swellPeriod
  if (height == null || period == null) return null
  const kw = 0.49 * height * height * period
  const level: PowerLevel = kw < 2 ? 1 : kw < 5 ? 2 : kw < 10 ? 3 : 4
  return { kw, level, word: POWER_WORDS[level] }
}

export interface WindInfo {
  relation: WindRelation
  label: 'Offshore' | 'Cross-shore' | 'Onshore'
  short: 'off' | 'cross' | 'on'
  /** Tailwind classes for the tag: text colour + soft background. */
  tagClass: string
  /** Text colour class alone (arrow, speed). */
  textClass: string
  /** Rotation for an arrow drawn pointing up, so it points where the wind blows TO. */
  rotate: number
}

const WIND: Record<WindRelation, Omit<WindInfo, 'rotate'>> = {
  offshore: { relation: 'offshore', label: 'Offshore', short: 'off', tagClass: 'bg-glass/15 text-glass', textClass: 'text-glass' },
  cross: { relation: 'cross', label: 'Cross-shore', short: 'cross', tagClass: 'bg-sand/15 text-sand', textClass: 'text-sand' },
  onshore: { relation: 'onshore', label: 'Onshore', short: 'on', tagClass: 'bg-coral/20 text-coral-text', textClass: 'text-coral-text' },
}

/** How the wind hits a beach facing `beachFaces` degrees; null without a direction. */
export function windInfo(h: HourConditions, beachFaces: number): WindInfo | null {
  if (h.windDirection == null) return null
  return { ...WIND[windRelation(h.windDirection, beachFaces)], rotate: (h.windDirection + 180) % 360 }
}
