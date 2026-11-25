import { memo } from 'react'
import { m, useReducedMotion } from 'framer-motion'
import { AiBadge, ScoreBadge } from './ScoreChip'
import { ScoreDetails } from './ScoreDetails'
import { PowerMeter, TideMini, WindArrow } from './Glyphs'
import { wavePower, windInfo } from '../lib/conditions'
import { compass } from '../lib/geo'
import { hhmm, num, tideCm } from '../lib/format'
import type { HourConditions } from '../lib/openMeteo'
import type { Spot } from '../lib/spot'
import { verdictFor, type Score, type Verdict as VerdictWord } from '../scoring/types'

const COLOR: Record<VerdictWord, string> = { GO: 'text-glass', MAYBE: 'text-sand', SKIP: 'text-coral' }
const STROKE: Record<VerdictWord, string> = { GO: '#5fe3c0', MAYBE: '#f4c95d', SKIP: '#ff7a66' }
const PILL: Record<VerdictWord, { text: string; className: string }> = {
  GO: { text: 'Worth paddling out', className: 'bg-glass/15 text-glass' },
  MAYBE: { text: 'Maybe worth a look', className: 'bg-sand/15 text-sand' },
  SKIP: { text: 'Not worth it now', className: 'bg-coral/20 text-coral-text' },
}

interface Props {
  score: Score
  hour: HourConditions
  /** The hour after, for "rising" / "falling". */
  next: HourConditions | undefined
  /** Today's hours, for the tide drawing. */
  dayHours: HourConditions[]
  spot: Spot
  timezone: string
  /** Next sunrise, when it is dark now. */
  firstLight: number | null
  /** Unix seconds. */
  now: number
  /** "Learned from 212 surfer reports", shown under an AI score; null = not shown. */
  learnedFrom?: string | null
}

/** The current hour: GO / MAYBE / SKIP, the score, why, and the four readings that matter. */
export const Verdict = memo(function Verdict({ score, hour, next, dayHours, spot, timezone, firstLight, now, learnedFrom }: Props) {
  const word = verdictFor(score.value)
  const still = useReducedMotion()
  const pill = score.value === 5 ? { text: 'Don’t miss it', className: 'bg-epic/25 text-epic-soft' } : PILL[word]
  const power = wavePower(hour)
  const wind = windInfo(hour, spot.beachOrientation)
  const period = hour.swellPeriod ?? hour.wavePeriod
  const from = hour.swellDirection ?? hour.waveDirection
  const tideTrend = next?.tide != null && hour.tide != null ? (next.tide > hour.tide ? 'rising' : 'falling') : ''

  return (
    <section aria-label="Right now" className="mx-4 flex flex-col gap-4 rounded-3xl border border-line bg-card p-6 sm:mx-8">
      <p className="text-xs font-semibold tracking-[0.08em] text-mist">RIGHT NOW · {hhmm(now, timezone)}</p>

      {/* Page-load moment: the wave line draws under the verdict. The word itself appears at once:
          it is the page's main content, and hiding it while it slides in delayed when phones
          (and Lighthouse) count the page as shown by over a second. */}
      <div className="-mt-1.5">
        <h1 className={`font-display text-[clamp(6rem,32vw,10rem)] leading-[0.8] font-black ${COLOR[word]}`}>{word}</h1>
        <svg viewBox="0 0 400 20" preserveAspectRatio="none" className="mt-1 block h-3.5 w-full" aria-hidden>
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

      <div className="flex items-center gap-4">
        <ScoreBadge value={score.value} size="lg" />
        <div className="flex flex-col gap-2">
          <span className="font-display text-4xl leading-none font-extrabold">{score.label}</span>
          <span className={`self-start rounded-full px-2.5 py-1 text-[13px] font-semibold ${pill.className}`}>{pill.text}</span>
        </div>
      </div>

      {score.source === 'ai' && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <AiBadge />
          {score.simple && (
            <span className="text-[13px] text-mist">
              Rules alone said {score.simple.value} · {score.simple.label}
            </span>
          )}
        </div>
      )}
      <p className="max-w-[38ch] text-lg leading-snug font-medium">{score.reason}</p>
      {score.source === 'ai' && learnedFrom && <p className="-mt-2 text-[13px] text-mist">{learnedFrom}</p>}
      {firstLight != null && <p className="-mt-2 text-mist">It's dark. First light at {hhmm(firstLight, timezone)}.</p>}
      <ScoreDetails score={score} hour={hour} />

      <dl className="grid grid-cols-2 gap-x-3 gap-y-4 border-t border-line pt-4">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-mist">Waves</dt>
          <dd className="font-display text-[28px] leading-tight font-extrabold tabular-nums">{num(hour.waveHeight)} m</dd>
          <dd className="text-xs text-mist">
            every {num(period, 0)} s{from != null && ` · from ${compass(from)}`}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-mist">Wave power</dt>
          <dd className="font-display text-[28px] leading-tight font-extrabold tabular-nums">
            {power ? power.kw.toFixed(1) : '–'} <span className="text-[15px] font-bold text-mist">kW/m</span>
          </dd>
          {power && (
            <dd className="flex items-center gap-1.5">
              <PowerMeter level={power.level} />
              <span className="text-xs font-semibold">{power.word}</span>
            </dd>
          )}
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-mist">Wind</dt>
          <dd className="flex items-center gap-1.5 font-display text-[28px] leading-tight font-extrabold tabular-nums">
            {wind && <WindArrow rotate={wind.rotate} size={16} className={wind.textClass} />}
            {num(hour.windSpeed, 0)} km/h
          </dd>
          {wind && <dd className={`self-start rounded-full px-2 py-0.5 text-xs font-bold ${wind.tagClass}`}>{wind.label}</dd>}
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-mist">Tide</dt>
          <dd className="pt-1 text-base font-semibold text-[#cfe1e5] tabular-nums">
            {tideCm(hour.tide)} cm <span className="text-xs font-normal text-mist">{tideTrend}</span>
          </dd>
          <dd>
            <TideMini hours={dayHours} now={now} timezone={timezone} />
          </dd>
        </div>
      </dl>
    </section>
  )
})
