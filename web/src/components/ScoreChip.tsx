import type { ScoreValue } from '../scoring/types'

/**
 * Score colours say what to do: 1 SKIP coral, 2 MAYBE sand, 3-4 GO greens, 5 EPIC purple (with a
 * glow, so an epic hour jumps out). Text colours keep at least 4.5:1 (EPIC: white on purple,
 * always shown large).
 */
export const SCORE_CLASS: Record<ScoreValue, string> = {
  1: 'bg-s1 text-abyss',
  2: 'bg-s2 text-abyss',
  3: 'bg-s3 text-abyss',
  4: 'bg-s4 text-abyss',
  5: 'bg-s5 text-white shadow-[0_0_0_2px_var(--color-epic-soft),0_0_16px_rgba(167,139,250,0.6)]',
}

/** The word under a score: SKIP / MAYBE / GO / EPIC, and its text colour on a dark card. */
export const SCORE_WORD: Record<ScoreValue, { word: string; className: string }> = {
  1: { word: 'SKIP', className: 'text-coral-text' },
  2: { word: 'MAYBE', className: 'text-sand' },
  3: { word: 'GO', className: 'text-glass' },
  4: { word: 'GO', className: 'text-glass' },
  5: { word: 'EPIC', className: 'text-epic-soft' },
}

export function AiBadge() {
  return (
    <span className="inline-flex items-center rounded-full border-[1.5px] border-sand px-2.5 py-0.5 text-xs font-semibold text-sand">
      AI-corrected
    </span>
  )
}

/** A score in a rounded square. `size` sm = hour rows, md = moments and days, lg = right now. */
export function ScoreBadge({ value, size = 'md', label }: { value: ScoreValue; size?: 'sm' | 'md' | 'lg'; label?: string }) {
  const box =
    size === 'lg'
      ? 'size-24 rounded-[30px] text-[66px]'
      : size === 'md'
        ? 'size-10 rounded-[14px] text-2xl'
        : 'size-[30px] rounded-[10px] text-lg'
  return (
    <span
      className={`grid shrink-0 place-items-center font-display leading-none font-black tabular-nums ${box} ${SCORE_CLASS[value]}`}
      aria-label={label ?? `score ${value} of 5, ${SCORE_WORD[value].word.toLowerCase()}`}
    >
      {value}
    </span>
  )
}
