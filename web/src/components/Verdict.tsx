import { memo } from 'react'
import { m, useReducedMotion } from 'framer-motion'
import { AiBadge } from './ScoreChip'
import { hhmm } from '../lib/format'
import { verdictFor, type Score, type Verdict as VerdictWord } from '../scoring/types'

const COLOR: Record<VerdictWord, string> = { GO: 'text-glass', MAYBE: 'text-sand', SKIP: 'text-coral' }
const STROKE: Record<VerdictWord, string> = { GO: '#5fe3c0', MAYBE: '#f4c95d', SKIP: '#ff7a66' }

interface Props {
  score: Score
  timezone: string
  /** Next sunrise, when it is dark now. */
  firstLight: number | null
  /** Unix seconds. */
  now: number
  /** "Learned from 212 surfer reports", shown under an AI score; null = not shown. */
  learnedFrom?: string | null
}

/** GO / MAYBE / SKIP for the current hour. */
export const Verdict = memo(function Verdict({ score, timezone, firstLight, now, learnedFrom }: Props) {
  const word = verdictFor(score.value)
  const still = useReducedMotion()

  return (
    <section aria-label="Right now" className="px-4 pt-6 pb-8 sm:px-8">
      <p className="text-mist">Right now at {hhmm(now, timezone)}</p>

      {/* Page-load moment: the wave line draws under the verdict. The word itself appears at once:
          it is the page's main content, and hiding it while it slides in delayed when phones
          (and Lighthouse) count the page as shown by over a second. */}
      <div className="relative">
        <h1 className={`font-display leading-[0.78] font-black tracking-[-0.01em] ${COLOR[word]} text-[clamp(7rem,40vw,17rem)]`}>
          {word}
        </h1>
        <svg viewBox="0 0 400 20" preserveAspectRatio="none" className="mt-2 block h-4 w-full" aria-hidden>
          <m.path
            d="M0 10 Q 25 0 50 10 T 100 10 T 150 10 T 200 10 T 250 10 T 300 10 T 350 10 T 400 10"
            fill="none"
            stroke={STROKE[word]}
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
            initial={still ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1.1, delay: 0.2, ease: 'easeOut' }}
          />
        </svg>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-display text-3xl font-extrabold">
          {score.value}
          <span className="text-mist">/5</span> {score.label}
        </span>
        {score.source === 'ai' && <AiBadge />}
        {score.simple && (
          // What the plain forecast rules said, smaller: the gap is the AI's correction.
          <span className="text-sm text-mist tabular-nums">
            Forecast alone {score.simple.value}/5 {score.simple.label}
          </span>
        )}
      </div>
      <p className="mt-1 max-w-[38ch] text-lg leading-snug">{score.reason}</p>
      {score.source === 'ai' && learnedFrom && <p className="mt-1 text-sm text-mist">{learnedFrom}</p>}
      {firstLight != null && <p className="mt-1 text-mist">It's dark. First light at {hhmm(firstLight, timezone)}.</p>}
    </section>
  )
})
