import { memo } from 'react'
import { AnimatePresence, m } from 'framer-motion'
import { DirectionArrow } from './DirectionArrow'
import { ScoreChip } from './ScoreChip'
import { WaveScene } from './WaveScene'
import { WindDial } from './WindDial'
import { compass } from '../lib/geo'
import { hhmm, num, tideCm, weekday } from '../lib/format'
import type { HourConditions } from '../lib/openMeteo'
import type { Spot } from '../lib/spot'
import type { Score } from '../scoring/types'

interface Props {
  spot: Spot
  hour: HourConditions
  next: HourConditions | undefined
  score: Score
  timezone: string
  isNow: boolean
}

/** The selected hour, drawn: moving sea, wind dial, and the numbers behind them. */
export const ConditionsPanel = memo(function ConditionsPanel({ spot, hour, next, score, timezone, isNow }: Props) {
  const period = hour.swellPeriod ?? hour.wavePeriod
  const swellFrom = hour.swellDirection ?? hour.waveDirection
  const tideTrend = next?.tide != null && hour.tide != null ? (next.tide > hour.tide ? 'rising' : 'falling') : ''

  return (
    <section aria-label="Conditions for the selected hour" className="px-4 sm:px-8">
      <div className="mb-3 flex items-center gap-3">
        <ScoreChip score={score} />
        <h2 className="font-display text-2xl font-extrabold">
          {isNow ? 'Now' : `${weekday(hour.time, timezone)} ${hhmm(hour.time, timezone)}`}
        </h2>
        <span className="text-mist">{score.label}</span>
      </div>

      <WaveScene heightM={hour.waveHeight} periodS={period}>
        <p className="font-display text-3xl leading-none font-extrabold tabular-nums">
          {num(hour.waveHeight)} m
        </p>
        <p className="mt-1 text-sm text-mist">
          a wave every {num(period, 0)} s from the {compass(swellFrom ?? 0)}
          <DirectionArrow from={swellFrom} className="ml-1" />
        </p>
      </WaveScene>

      {/* Reason swaps with a short crossfade when the hour changes. */}
      <div className="relative mt-3 min-h-[1.5em]" aria-live="polite">
        <AnimatePresence mode="popLayout" initial={false}>
          <m.p
            key={hour.time}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="max-w-[46ch]"
          >
            {/* "Now" already has its reason under the verdict above. */}
            {isNow ? '' : score.reason}
          </m.p>
        </AnimatePresence>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-x-8 gap-y-5">
        <WindDial from={hour.windDirection} speed={hour.windSpeed} beachFaces={spot.beachOrientation} />
        <dl className="flex gap-8">
          <div>
            <dt className="text-sm text-mist">Swell period</dt>
            <dd className="font-display text-3xl font-extrabold tabular-nums">{num(period, 0)} s</dd>
          </div>
          <div>
            <dt className="text-sm text-mist">Tide</dt>
            <dd className="font-display text-3xl font-extrabold tabular-nums">
              {tideCm(hour.tide)} <span className="text-base">cm</span>
            </dd>
            {tideTrend && <dd className="text-sm text-mist">{tideTrend}</dd>}
          </div>
        </dl>
      </div>
    </section>
  )
})
