// Picks the score to show for an hour. Always starts from the physics rules (Waves, Shape,
// Comfort, Safety: scoring/physics.ts). When the predictions table has the model's Waves and
// Shape for that hour, those replace the rule-based ones; comfort and safety always stay rules
// and use YOUR preferences. This is the one place the UI asks for a score.

import type { HourConditions } from '../lib/openMeteo'
import type { AiPrediction } from '../lib/predictions'
import type { Spot } from '../lib/spot'
import { evaluate, overallScore, verdictFrom, type Prefs, type PhysicsResult, type Series } from './physics'
import { SCORE_LABELS, toScoreValue, type Score, type ScoreValue } from './types'

function label(value: ScoreValue, p: PhysicsResult): string {
  if (p.warnings.some((w) => w.kind === 'thunder')) return 'Storm'
  if (p.features.daylight === false) return 'Dark'
  // Capped by your level / max size: the waves are good, just not for you today.
  if (p.warnings.some((w) => w.kind === 'too_big' && w.cap != null && value <= w.cap)) return 'Too big'
  return SCORE_LABELS[value]
}

export function resolveScore(h: HourConditions, spot: Spot, ai?: AiPrediction, series?: Series, prefs?: Prefs): Score {
  const p = evaluate(h, spot, series, h.isDay, prefs)
  const pv = toScoreValue(p.verdict)
  const rules: Score = {
    value: pv,
    label: label(pv, p),
    reason: p.reason,
    source: 'simple',
    parts: { waves: p.waves, shape: p.shape, comfort: p.comfort },
    physics: p,
  }
  if (!ai || ai.aiWaves == null || ai.aiShape == null) return rules
  const value = toScoreValue(verdictFrom(overallScore(ai.aiWaves, ai.aiShape), p))
  const ruleOverrides = p.warnings.some((w) => w.skip) || p.features.daylight === false
  return {
    value,
    label: label(value, p),
    reason: ruleOverrides ? p.reason : ai.reason?.trim() || p.reason,
    source: 'ai',
    modelVersion: ai.modelVersion,
    simple: rules,
    parts: { waves: ai.aiWaves, shape: ai.aiShape, comfort: p.comfort },
    physics: p,
  }
}
