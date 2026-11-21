import type { Score } from '../scoring/types'

const BG = ['', 'bg-s1 text-foam', 'bg-s2 text-foam', 'bg-s3 text-abyss', 'bg-s4 text-abyss', 'bg-s5 text-abyss']

export function ScoreChip({ score, size = 'sm' }: { score: Score; size?: 'sm' | 'lg' }) {
  const box = size === 'lg' ? 'size-14 text-4xl rounded-xl' : 'size-7 text-lg rounded-md'
  return (
    <span
      className={`relative grid shrink-0 place-items-center font-display font-extrabold tabular-nums ${box} ${BG[score.value]}`}
      title={`${score.value} ${score.label}${score.source === 'ai' ? ' (AI-corrected)' : ''}`}
    >
      {score.value}
      {score.source === 'ai' && (
        // Small notch marks an AI-corrected hour in the list.
        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-sand ring-2 ring-abyss" aria-hidden />
      )}
    </span>
  )
}

export function AiBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-sand/50 px-2.5 py-0.5 text-xs font-semibold text-sand">
      <span className="size-1.5 rounded-full bg-sand" aria-hidden />
      AI-corrected
    </span>
  )
}
