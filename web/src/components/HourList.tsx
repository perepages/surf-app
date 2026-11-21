import { memo } from 'react'
import { DirectionArrow } from './DirectionArrow'
import { ScoreChip } from './ScoreChip'
import { hh, num, tideCm } from '../lib/format'
import { windRelation } from '../lib/geo'
import type { HourConditions } from '../lib/openMeteo'
import type { Spot } from '../lib/spot'
import type { Score } from '../scoring/types'

const COLS = 'grid grid-cols-[1.75rem_1.75rem_minmax(0,1fr)_3.25rem_5.25rem_2.25rem] items-center gap-x-2.5 sm:gap-x-4'
const BAR_MAX_M = 2 // a 2 m wave fills the bar

const REL_SHORT = { offshore: 'off', cross: 'cross', onshore: 'on' } as const
const REL_COLOR = { offshore: 'text-glass', cross: 'text-mist', onshore: 'text-coral' } as const

interface Props {
  spot: Spot
  hours: HourConditions[]
  scores: Map<number, Score>
  timezone: string
  now: number
  /** Unix seconds of the hour picked in the strip. */
  selected: number
}

export const HourList = memo(function HourList({ spot, hours, scores, timezone, now, selected }: Props) {
  return (
    <div role="table" aria-label="Hourly forecast" className="text-[0.95rem]">
      <div role="row" className={`${COLS} border-b border-kelp pb-2 text-xs text-mist`}>
        <span role="columnheader" className="pl-1">Hour</span>
        <span role="columnheader">
          <span className="sr-only">Score</span>
        </span>
        <span role="columnheader">Waves (m)</span>
        <span role="columnheader">Swell</span>
        <span role="columnheader">Wind (km/h)</span>
        <span role="columnheader" className="pr-1 text-right">Tide</span>
      </div>

      {hours.map((h) => {
        const score = scores.get(h.time)!
        const isNow = now >= h.time && now < h.time + 3600
        const past = h.time + 3600 <= now
        const rel = h.windDirection == null ? null : windRelation(h.windDirection, spot.beachOrientation)
        const height = h.waveHeight ?? 0
        return (
          <div
            role="row"
            key={h.time}
            aria-current={isNow ? 'time' : undefined}
            title={score.reason}
            className={`${COLS} border-b border-kelp/40 py-1.5 tabular-nums ${
              isNow ? 'relative shadow-[inset_3px_0_0_var(--color-glass)]' : ''
            } ${h.time === selected ? 'bg-deep' : ''} transition-colors duration-300 ${past || !h.isDay ? 'text-mist' : ''}`}
          >
            <span role="cell" className={`pl-1 font-display text-lg font-bold ${isNow ? 'text-glass' : ''}`}>
              {hh(h.time, timezone)}
            </span>
            <span role="cell">
              <ScoreChip score={score} />
            </span>
            <span role="cell" className="flex items-center gap-2">
              <span className="w-7 font-semibold">{num(h.waveHeight)}</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-kelp/50" aria-hidden>
                <span
                  className="block h-full rounded-full bg-foam/80"
                  style={{ width: `${Math.min(height / BAR_MAX_M, 1) * 100}%` }}
                />
              </span>
            </span>
            <span role="cell" className="flex items-center gap-1">
              {num(h.swellPeriod ?? h.wavePeriod, 0)}s
              <DirectionArrow from={h.swellDirection ?? h.waveDirection} className="text-mist" />
            </span>
            <span role="cell" className="flex items-center gap-1">
              {num(h.windSpeed, 0)}
              <DirectionArrow from={h.windDirection} className="text-mist" />
              {rel && <span className={`text-xs font-semibold ${REL_COLOR[rel]}`}>{REL_SHORT[rel]}</span>}
            </span>
            <span role="cell" className="pr-1 text-right text-mist" title="Tide in cm">
              {tideCm(h.tide)}
            </span>
          </div>
        )
      })}
    </div>
  )
})
