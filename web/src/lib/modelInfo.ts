// What the app shows about the spot's AI model (database function from migration 12):
// how many surfer reports it learned from, and how often it beat the raw forecast lately.
// Only counts come back; ratings and model files stay private.

import { useEffect, useState } from 'react'
import { readLastGood, writeLastGood } from './lastGood'
import { CHART_DAYS } from './reports'
import { rpc, supabaseConfigured } from './supabase'

export interface ModelInfo {
  /** A trained model is in use at this spot. */
  active: boolean
  version: string | null
  /** 'general' = trained on all spots (this spot has too few ratings of its own). */
  scope: 'spot' | 'general' | null
  /** Ratings it learned from; null for a model saved before migration 12. */
  nRatings: number | null
  nSpots: number | null
  /** The comparison window, in days (same as the chart). */
  days: number
  /** Rated hours (last `days` days) that had an AI score, and who was closer on each. */
  compared: number
  aiCloser: number
  simpleCloser: number
}

interface Row {
  active: boolean
  version: string | null
  scope: 'spot' | 'general' | null
  n_ratings: number | null
  n_spots: number | null
  days: number
  compared: number
  ai_closer: number
  simple_closer: number
}

const REFRESH_EVERY_MS = 15 * 60 * 1000

async function load(spotId: string, signal: AbortSignal): Promise<ModelInfo> {
  const r = await rpc<Row>('spot_model_info', { p_spot_id: spotId, p_days: CHART_DAYS }, signal)
  return {
    active: r.active,
    version: r.version,
    scope: r.scope,
    nRatings: r.n_ratings,
    nSpots: r.n_spots,
    days: r.days,
    compared: r.compared,
    aiCloser: r.ai_closer,
    simpleCloser: r.simple_closer,
  }
}

/**
 * The spot's model info, starting from the last saved copy (instant, works offline). Null while
 * unknown, or when the function isn't there (migration 12 not applied): the app then just
 * doesn't show these lines. Reloads when back online and every 15 minutes while on screen.
 */
export function useModelInfo(spotId: string): ModelInfo | null {
  const [info, setInfo] = useState<ModelInfo | null>(() => readLastGood<ModelInfo>(`model:${spotId}`))
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
    load(spotId, ac.signal)
      .then((i) => {
        writeLastGood(`model:${spotId}`, i)
        setInfo(i)
      })
      .catch((err) => {
        if (!ac.signal.aborted) console.warn('Could not load model info, keeping the last copy', err)
      })
    return () => ac.abort()
  }, [spotId, tick])
  return info
}

const nf = new Intl.NumberFormat('en')

/** "Learned from 212 surfer reports" (+ " across 3 spots" for a general model). */
export function learnedFrom(info: ModelInfo | null): string | null {
  if (!info?.active) return null
  if (info.nRatings == null) return 'Learned from surfers’ reports'
  const n = info.nRatings
  const spots = info.scope === 'general' && (info.nSpots ?? 1) > 1 ? ` across ${info.nSpots} spots` : ''
  return `Learned from ${nf.format(n)} surfer ${n === 1 ? 'report' : 'reports'}${spots}`
}
