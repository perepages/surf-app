// "Today" (5 moments of the day) and "Next days" (best window per day). Both open the
// hour-by-hour sheet, where every hour is listed.

import { memo } from 'react'
import { PowerMeter, WindArrow, tideRangeCm } from './Glyphs'
import { SCORE_WORD, ScoreBadge } from './ScoreChip'
import { wavePower, windInfo } from '../lib/conditions'
import { dayOfMonth, hh, num, weekday } from '../lib/format'
import type { ForecastDay, HourConditions } from '../lib/openMeteo'
import type { Spot } from '../lib/spot'
import type { Score, ScoreValue } from '../scoring/types'

type Scores = Map<number, Score>
const scoreOf = (scores: Scores, h: HourConditions): ScoreValue => scores.get(h.time)?.value ?? 1

/** Daylight hours of a day (all hours if the day has no daylight data). */
export const daylight = (day: ForecastDay) => {
  const light = day.hours.filter((h) => h.isDay)
  return light.length ? light : day.hours
}

interface Moment {
  label: string
  hour: HourConditions
  now: boolean
}

/** Dawn, morning, now (or midday), afternoon, evening: one hour each, no duplicates. */
function pickMoments(day: ForecastDay, now: number, tz: string): Moment[] {
  const hours = daylight(day)
  const at = (h: number) => hours.find((x) => Number(hh(x.time, tz)) === h)
  const current = hours.find((x) => now >= x.time && now < x.time + 3600)
  const picks: (Moment | null)[] = [
    { label: 'Dawn', hour: hours[0], now: false },
    at(10) ? { label: 'Morning', hour: at(10)!, now: false } : null,
    current ? { label: 'Now', hour: current, now: true } : at(13) ? { label: 'Midday', hour: at(13)!, now: false } : null,
    at(16) ? { label: 'Afternoon', hour: at(16)!, now: false } : null,
    { label: 'Evening', hour: hours[hours.length - 1], now: false },
  ]
  const byTime = new Map<number, Moment>()
  for (const p of picks) {
    if (!p) continue
    const prev = byTime.get(p.hour.time)
    if (!prev || p.now) byTime.set(p.hour.time, p) // "Now" wins over the moment it falls on
  }
  return [...byTime.values()].sort((a, b) => a.hour.time - b.hour.time)
}

interface TodayProps {
  day: ForecastDay
  scores: Scores
  spot: Spot
  timezone: string
  now: number
  onOpenHours: () => void
}

export const TodayCard = memo(function TodayCard({ day, scores, spot, timezone, now, onOpenHours }: TodayProps) {
  const moments = pickMoments(day, now, timezone)
  const range = tideRangeCm(day.hours)
  return (
    <section aria-labelledby="today-title" className="mx-4 flex flex-col gap-3.5 rounded-3xl border border-line bg-card px-3.5 pt-5 pb-4 sm:mx-8">
      <div className="flex items-baseline justify-between px-2">
        <h2 id="today-title" className="font-display text-[26px] font-extrabold">
          Today
        </h2>
        <span className="text-xs text-mist">{moments.length} moments</span>
      </div>
      <ul className="grid gap-1 text-center" style={{ gridTemplateColumns: `repeat(${moments.length}, minmax(0, 1fr))` }}>
        {moments.map((mo) => {
          const h = mo.hour
          const value = scoreOf(scores, h)
          const power = wavePower(h)
          const wind = windInfo(h, spot.beachOrientation)
          return (
            <li key={h.time} className={`flex flex-col items-center gap-1.5 rounded-[14px] py-2 ${mo.now ? 'bg-sea' : ''}`}>
              <span className={`text-xs ${mo.now ? 'font-bold text-glass' : 'text-mist'}`}>{mo.label}</span>
              <span className="text-[13px] font-semibold">{hh(h.time, timezone)}h</span>
              <ScoreBadge value={value} />
              <span className="text-[13px] font-semibold tabular-nums">{num(h.waveHeight)} m</span>
              {power && <PowerMeter level={power.level} small />}
              {wind && (
                <>
                  <span className={`flex items-center gap-0.5 text-xs tabular-nums ${wind.textClass}`}>
                    <WindArrow rotate={wind.rotate} size={11} />
                    {num(h.windSpeed, 0)}
                  </span>
                  <span className={`rounded-full px-1.5 text-[11px] font-bold ${wind.tagClass}`}>{wind.short}</span>
                </>
              )}
            </li>
          )
        })}
      </ul>
      <button
        type="button"
        onClick={onOpenHours}
        className="mx-1 flex h-12 items-center justify-between rounded-[14px] border border-[#2e7183] px-4 text-[15px] font-semibold transition-colors hover:border-mist"
      >
        See every hour <span aria-hidden className="text-glass">→</span>
      </button>
      <p className="px-2 pt-1 text-xs text-mist">
        Bars under the height = wave power.{range != null && ` Tide range today only ${range} cm.`}
      </p>
    </section>
  )
})

/** The best window of a day: highest score, its first run of hours, and the hour it starts. */
export function bestWindow(day: ForecastDay, scores: Scores, tz: string) {
  const hours = daylight(day)
  const best = Math.max(...hours.map((h) => scoreOf(scores, h))) as ScoreValue
  const i0 = hours.findIndex((h) => scoreOf(scores, h) === best)
  let i1 = i0
  while (i1 + 1 < hours.length && scoreOf(scores, hours[i1 + 1]) === best) i1++
  const allDay = i0 === 0 && i1 === hours.length - 1
  const when = allDay ? 'all day' : `${hh(hours[i0].time, tz)}–${hh(hours[i1].time + 3600, tz)}h`
  return { best, peak: hours[i0], when, allDay }
}

interface NextProps {
  days: ForecastDay[]
  scores: Scores
  spot: Spot
  timezone: string
  /** Opens the hour-by-hour sheet on day i of `days`. */
  onOpenDay: (i: number) => void
}

export const NextDays = memo(function NextDays({ days, scores, spot, timezone, onOpenDay }: NextProps) {
  if (!days.length) return null
  return (
    <section aria-labelledby="next-title" className="mx-4 flex flex-col gap-3 rounded-3xl border border-line bg-card px-6 py-5 sm:mx-8">
      <h2 id="next-title" className="font-display text-[26px] font-extrabold">
        Next days
      </h2>
      <p className="text-xs text-mist">Surf score 1 (flat) to 5 (epic), corrected by surfers’ ratings</p>
      <ul className="flex flex-wrap gap-x-3 gap-y-1.5 text-xs font-semibold" aria-label="Colour key">
        <li className="flex items-center gap-1.5"><span className="size-3 rounded bg-s1" />Skip</li>
        <li className="flex items-center gap-1.5"><span className="size-3 rounded bg-s2" />Maybe</li>
        <li className="flex items-center gap-1.5"><span className="size-3 rounded bg-s4" />Go</li>
        <li className="flex items-center gap-1.5"><span className="size-3 rounded bg-s5 shadow-[0_0_8px_rgba(167,139,250,0.8)]" />Epic</li>
      </ul>
      <ul>
        {days.map((day, i) => {
          const { best, peak, when, allDay } = bestWindow(day, scores, timezone)
          const power = wavePower(peak)
          const wind = windInfo(peak, spot.beachOrientation)
          const noon = day.hours[Math.floor(day.hours.length / 2)].time
          const text =
            best <= 1
              ? `Flat · ${num(peak.waveHeight)} m`
              : `${allDay ? 'Same all day' : `Best ${when}`} · ${num(peak.waveHeight)} m${power ? ` · ${power.word.toLowerCase()}` : ''}`
          return (
            <li key={day.date} className="border-t border-line">
              <button type="button" onClick={() => onOpenDay(i)} className="flex w-full items-center gap-3.5 py-3 text-left">
                <span className="flex w-[54px] flex-col">
                  <span className="text-[15px] font-bold">{weekday(noon, timezone)}</span>
                  <span className="text-xs text-mist">{dayOfMonth(noon, timezone)}</span>
                </span>
                <span className="flex flex-1 flex-col gap-1.5">
                  <span className="text-[13px]">{text}</span>
                  {wind && <span className={`self-start rounded-full px-2 text-[11px] font-bold ${wind.tagClass}`}>{wind.label}</span>}
                </span>
                <span className="flex flex-col items-center gap-1">
                  <ScoreBadge value={best} />
                  <span className={`text-[10px] font-bold tracking-wider ${SCORE_WORD[best].className}`}>{SCORE_WORD[best].word}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
})
