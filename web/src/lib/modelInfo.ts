// What the app shows about the spot's AI model (database function from migration 12):
// how many surfer reports it learned from, and how often it beat the raw forecast lately.
// Only counts come back; ratings and model files stay private.

import { useEffect, useState } from 'react'
import { EXTRAS_WAIT_MS, extrasRecent, onExtras } from './extras'
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

function fromRow(r: Row): ModelInfo {
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

async function load(spotId: string, signal: AbortSignal): Promise<ModelInfo> {
  return fromRow(await rpc<Row>('spot_model_info', { p_spot_id: spotId, p_days: CHART_DAYS }, signal))
}

/**
 * The spot's model info, starting from the last saved copy (instant, works offline). Null while
 * unknown, or when the function isn't there (migration 12 not applied): the app then just
 * doesn't show these lines. New copies arrive with the forecast (`extras`, lib/extras.ts); read
 * from Supabase directly only when the extras lack it or none arrived within EXTRAS_WAIT_MS.
 */
export function useModelInfo(spotId: string): ModelInfo | null {
  const [info, setInfo] = useState<ModelInfo | null>(() => readLastGood<ModelInfo>(`model:${spotId}`))
  useEffect(() => {
    if (!supabaseConfigured) return
    const ac = new AbortController()
    let readDirect = false
    const keep = (i: ModelInfo) => {
      writeLastGood(`model:${spotId}`, i)
      setInfo(i)
    }
    const direct = () => {
      if (readDirect) return
      readDirect = true
      load(spotId, ac.signal)
        .then(keep)
        .catch((err) => {
          if (!ac.signal.aborted) console.warn('Could not load model info, keeping the last copy', err)
        })
    }
    // A copy saved with a forecast downloaded minutes ago is current: no read needed.
    const timer = readLastGood<ModelInfo>(`model:${spotId}`) && extrasRecent(spotId) ? undefined : setTimeout(direct, EXTRAS_WAIT_MS)
    const off = onExtras(spotId, (x) => {
      clearTimeout(timer)
      if (x.model) keep(fromRow(x.model as Row))
      else direct()
    })
    return () => {
      off()
      clearTimeout(timer)
      ac.abort()
    }
  }, [spotId])
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
