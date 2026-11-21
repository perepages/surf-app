// Picks the score to show for an hour: the AI-corrected one when the predictions table
// has it, otherwise the simple score. This is the one place the UI asks for a score.

import type { HourConditions } from '../lib/openMeteo'
import type { AiPrediction } from '../lib/predictions'
import type { Spot } from '../lib/spot'
import { simpleScore } from './simpleScore'
import { SCORE_LABELS, toScoreValue, type Score } from './types'

export function resolveScore(h: HourConditions, spot: Spot, ai?: AiPrediction): Score {
  const simple = simpleScore(h, spot)
  if (!ai) return simple
  const value = toScoreValue(ai.aiScore)
  return {
    value,
    label: SCORE_LABELS[value],
    reason: ai.reason?.trim() || simple.reason,
    source: 'ai',
    modelVersion: ai.modelVersion,
  }
}
