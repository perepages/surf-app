// AI-corrected scores written by the nightly job into the `predictions` table.
// Only rows with an ai_score are used; until a model exists this returns nothing.

import { selectRows, supabaseConfigured } from './supabase'

export interface AiPrediction {
  /** Unix seconds, UTC. */
  validAt: number
  aiScore: number
  reason: string | null
  modelVersion: string | null
}

interface PredictionRow {
  valid_at: string
  ai_score: number
  reason: string | null
  model_version: string | null
}

/**
 * Map of unix seconds -> prediction, or null if they couldn't be loaded (offline, Supabase
 * down), so the caller can keep its last copy. Never throws.
 */
export async function getAiPredictions(
  spotId: string,
  fromUnix: number,
  toUnix: number,
  signal?: AbortSignal,
): Promise<Map<number, AiPrediction> | null> {
  const out = new Map<number, AiPrediction>()
  if (!supabaseConfigured) return out
  const iso = (u: number) => encodeURIComponent(new Date(u * 1000).toISOString())
  try {
    const rows = await selectRows<PredictionRow>(
      'predictions',
      [
        'select=valid_at,ai_score,reason,model_version',
        `spot_id=eq.${encodeURIComponent(spotId)}`,
        `valid_at=gte.${iso(fromUnix)}`,
        `valid_at=lte.${iso(toUnix)}`,
        'ai_score=not.is.null',
      ].join('&'),
      signal,
    )
    for (const r of rows) {
      const validAt = Math.round(Date.parse(r.valid_at) / 1000)
      out.set(validAt, { validAt, aiScore: r.ai_score, reason: r.reason, modelVersion: r.model_version })
    }
  } catch (err) {
    if (!signal?.aborted) console.warn('Could not load AI predictions, keeping the last copy', err)
    return null
  }
  return out
}
