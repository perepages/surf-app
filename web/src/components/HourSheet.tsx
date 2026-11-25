// "See every hour": a sheet over the page with day tabs and one compact row per daylight hour.
// Loaded only when first opened (React.lazy in App).

import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { WindArrow, tideRangeCm } from './Glyphs'
import { ScoreBadge } from './ScoreChip'
import { bestWindow } from './DayPlan'
import { wavePower, windInfo } from '../lib/conditions'
import { dayOfMonth, hh, hhmm, num, weekday } from '../lib/format'
import type { ForecastDay, HourConditions } from '../lib/openMeteo'
import type { Spot } from '../lib/spot'
import type { Score } from '../scoring/types'

/** Brighter background = stronger waves (weak, medium, strong, heavy). */
const POWER_BG = ['', 'bg-foam/5', 'bg-foam/15', 'bg-foam/25', 'bg-foam/40']

interface Props {
  open: boolean
  onClose: () => void
  /** From today on. */
  days: ForecastDay[]
  /** Day shown first (index into `days`). */
  initialDay: number
  scores: Map<number, Score>
  spot: Spot
  timezone: string
  now: number
}

export function HourSheet(props: Props) {
  return <AnimatePresence>{props.open && <Sheet {...props} />}</AnimatePresence>
}

/** Daylight hours plus the hour after sunset (dimmed), so the evening session is covered. */
function rowsFor(day: ForecastDay): { hour: HourConditions; dark: boolean }[] {
  const first = day.hours.findIndex((h) => h.isDay)
  if (first < 0) return day.hours.map((hour) => ({ hour, dark: false }))
  let last = first
  day.hours.forEach((h, i) => h.isDay && (last = i))
  return day.hours.slice(first, Math.min(day.hours.length, last + 2)).map((hour) => ({ hour, dark: !hour.isDay }))
}

function Sheet({ onClose, days, initialDay, scores, spot, timezone, now }: Props) {
  const [dayIdx, setDayIdx] = useState(initialDay)
  const day = days[dayIdx] ?? days[0]
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    heading.current?.focus()
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKey)
      opener?.focus()
    }
  }, [onClose])

  const rows = rowsFor(day)
  const noon = day.hours[Math.floor(day.hours.length / 2)].time
  const { best, when } = bestWindow(day, scores, timezone)
  const range = tideRangeCm(day.hours)

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <m.div
        className="absolute inset-0 bg-abyss/70"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        aria-hidden
      />
      <m.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hours-title"
        className="relative flex max-h-[92dvh] w-full max-w-3xl flex-col rounded-t-[28px] border-t border-[#2e7183] bg-card"
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 380, damping: 38 }}
      >
        <span aria-hidden className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-[#3e6c7a]" />
        <div className="flex items-center justify-between px-5 pt-2 sm:px-8">
          <h2 id="hours-title" ref={heading} tabIndex={-1} className="font-display text-[28px] font-extrabold outline-none">
            Hour by hour
          </h2>
          <button type="button" onClick={onClose} className="px-1 py-2.5 text-[15px] font-semibold text-glass">
            Done
          </button>
        </div>

        <div role="tablist" aria-label="Day" className="flex gap-1.5 px-4 pt-2 sm:px-8">
          {days.map((d, i) => {
            const active = i === dayIdx
            const dNoon = d.hours[Math.floor(d.hours.length / 2)].time
            return (
              <button
                key={d.date}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setDayIdx(i)}
                className={`h-11 flex-1 rounded-xl text-[13px] ${
                  active ? 'bg-glass font-bold text-abyss' : 'border border-[#2e7183] hover:border-mist'
                }`}
              >
                {i === 0 ? 'Today' : weekday(dNoon, timezone)}
              </button>
            )
          })}
        </div>
        <p className="px-5 pt-3 text-[13px] text-mist sm:px-8">
          {weekday(noon, timezone)} {dayOfMonth(noon, timezone)}
          {best >= 2 && ` · best ${when}`}
          {range != null && ` · tide range ${range} cm`}
        </p>

        <div className="mt-2 overflow-y-auto px-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
          <table className="w-full border-collapse text-left">
            <thead className="text-[11px] text-mist">
              <tr className="border-b border-line">
                <th scope="col" className="py-1.5 pl-1.5 font-normal">Hour</th>
                <th scope="col" className="py-1.5 font-normal">Score</th>
                <th scope="col" className="py-1.5 font-normal">Waves</th>
                <th scope="col" className="py-1.5 font-normal">Power</th>
                <th scope="col" className="py-1.5 font-normal">Wind</th>
                <th scope="col" className="py-1.5 pr-1 text-right font-normal">Sky</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ hour: h, dark }) => {
                const isNow = now >= h.time && now < h.time + 3600
                const power = wavePower(h)
                const wind = windInfo(h, spot.beachOrientation)
                const score = scores.get(h.time)
                const value = score?.value ?? 1
                const warnings = score?.physics?.warnings.filter((w) => w.kind !== 'thunder') ?? []
                const thunder = score?.physics?.warnings.some((w) => w.kind === 'thunder')
                const rainy = (h.precipProb ?? 0) > 20 || (h.precipitation ?? 0) >= 0.1
                return (
                  <tr
                    key={h.time}
                    className={`h-10 border-b border-[#1a5566] ${isNow ? 'bg-sea shadow-[inset_3px_0_0_var(--color-glass)]' : ''} ${dark ? 'opacity-55' : ''}`}
                  >
                    <th scope="row" className={`pl-1.5 text-[13px] ${isNow ? 'font-bold text-glass' : 'font-medium'}`}>
                      {isNow ? 'Now' : `${hh(h.time, timezone)}h`}
                    </th>
                    <td>
                      <ScoreBadge value={value} size="sm" />
                    </td>
                    <td className="text-sm whitespace-nowrap tabular-nums">
                      <b>{num(h.waveHeight)} m</b> <span className="text-xs text-mist">{num(h.wavePeriod ?? h.swellPeriod, 0)} s</span>
                    </td>
                    <td>
                      {power && (
                        <span className={`rounded-lg px-1.5 py-0.5 text-[13px] font-semibold tabular-nums ${POWER_BG[power.level]}`} title={power.word}>
                          {power.kw.toFixed(1)}
                        </span>
                      )}
                    </td>
                    <td>
                      {wind && (
                        <span className="flex items-center gap-1.5 text-sm tabular-nums">
                          <WindArrow rotate={wind.rotate} className={wind.textClass} />
                          <b>{num(h.windSpeed, 0)}</b>
                          <span className={`rounded-full px-1.5 text-[11px] font-bold ${wind.tagClass}`}>{wind.short}</span>
                        </span>
                      )}
                    </td>
                    <td className="pr-1 text-right text-[12px] whitespace-nowrap tabular-nums">
                      {thunder ? (
                        <span title="Thunderstorm risk" aria-label="thunderstorm risk">⛈</span>
                      ) : rainy ? (
                        <span title={`${h.precipProb ?? '?'}% chance of rain`} className="text-mist">
                          <span aria-hidden>🌧</span>
                          {h.precipProb != null ? `${h.precipProb}%` : ''}
                        </span>
                      ) : null}
                      {warnings.length > 0 && (
                        <span title={warnings.map((w) => w.text).join('. ')} aria-label={warnings.map((w) => w.text).join('. ')} className="ml-0.5 text-coral-text">
                          ⚠
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="px-1 pt-2 text-[11px] leading-snug text-mist">
            Power = wave strength in kW per metre (brighter = stronger). Wind: off = offshore (clean), cross = cross-shore, on =
            onshore (messy). Sky: 🌧 chance of rain, ⛈ thunderstorm (score forced to 1), ⚠ safety warning (rip currents, too big for your level, polluted water).
            {day.sunset != null && ` Greyed hour is after sunset (${hhmm(day.sunset, timezone)}).`}
          </p>
        </div>
      </m.div>
    </div>
  )
}
