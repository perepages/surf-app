// AI-corrected scores written by the jobs into the `predictions` table.
// Only rows with the model's Waves and Shape are used; until a model exists this returns nothing.

import { selectRows, supabaseConfigured } from './supabase'

export interface AiPrediction {
  /** Unix seconds, UTC. */
  validAt: number
  /** overall(aiWaves, aiShape): wave quality without comfort (the app adds comfort per user). */
  aiScore: number
  aiWaves: number | null
  aiShape: number | null
  reason: string | null
  modelVersion: string | null
}

interface PredictionRow {
  valid_at: string
  ai_score: number
  ai_waves: number | null
  ai_shape: number | null
  reason: string | null
  model_version: string | null
}

/** Rows as the database returns them (also inside the forecast answer's extras) -> map. */
export function aiFromRows(rows: unknown[]): Map<number, AiPrediction> {
  const out = new Map<number, AiPrediction>()
  for (const r of rows as PredictionRow[]) {
    const validAt = Math.round(Date.parse(r.valid_at) / 1000)
    out.set(validAt, {
      validAt,
      aiScore: r.ai_score,
      aiWaves: r.ai_waves,
      aiShape: r.ai_shape,
      reason: r.reason,
      modelVersion: r.model_version,
    })
  }
  return out
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
  if (!supabaseConfigured) return new Map()
  const iso = (u: number) => encodeURIComponent(new Date(u * 1000).toISOString())
  try {
    const rows = await selectRows<PredictionRow>(
      'predictions',
      [
        'select=valid_at,ai_score,ai_waves,ai_shape,reason,model_version',
        `spot_id=eq.${encodeURIComponent(spotId)}`,
        `valid_at=gte.${iso(fromUnix)}`,
        `valid_at=lte.${iso(toUnix)}`,
        'ai_waves=not.is.null',
      ].join('&'),
      signal,
    )
    return aiFromRows(rows)
  } catch (err) {
    if (!signal?.aborted) console.warn('Could not load AI predictions, keeping the last copy', err)
    return null
  }
}
