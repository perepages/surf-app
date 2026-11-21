// Shared shape of a surf score, whoever produced it (simple rules or a trained model).

export type ScoreValue = 1 | 2 | 3 | 4 | 5

export const SCORE_LABELS: Record<ScoreValue, string> = {
  1: 'Flat',
  2: 'Small',
  3: 'Fun',
  4: 'Good',
  5: 'Epic',
}

export interface Score {
  value: ScoreValue
  label: string
  /** One short line explaining the score. */
  reason: string
  source: 'simple' | 'ai'
  /** Only for AI scores. */
  modelVersion?: string | null
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
