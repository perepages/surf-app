// Shared shape of a surf score, whoever produced it (physics rules or the trained model).

import type { PhysicsResult } from './physics'

export type ScoreValue = 1 | 2 | 3 | 4 | 5

export const SCORE_LABELS: Record<ScoreValue, string> = {
  1: 'Flat',
  2: 'Small',
  3: 'Fun',
  4: 'Good',
  5: 'Epic',
}

export interface Score {
  /** The verdict 1-5: wave quality adjusted by comfort (your preferences) and safety. */
  value: ScoreValue
  label: string
  /** One short line explaining the score. */
  reason: string
  /** 'simple' = the physics rules alone; 'ai' = Waves and Shape corrected by the model. */
  source: 'simple' | 'ai'
  /** Only for AI scores. */
  modelVersion?: string | null
  /** Only for AI scores: what the physics rules alone said, shown smaller next to it. */
  simple?: Score
  /** Waves / Shape / Comfort (1-5), shown as three bars. AI values when the model has them. */
  parts?: { waves: number; shape: number; comfort: number }
  /** The rule-based details: messy-waves text, rain, warnings, wetsuit. */
  physics?: PhysicsResult
}

export type Verdict = 'GO' | 'MAYBE' | 'SKIP'

export function verdictFor(value: ScoreValue): Verdict {
  if (value >= 3) return 'GO'
  if (value === 2) return 'MAYBE'
  return 'SKIP'
}

export function toScoreValue(x: number): ScoreValue {
  return Math.min(5, Math.max(1, Math.round(x))) as ScoreValue
}
