import { m, useReducedMotion } from 'framer-motion'
import { memo, useEffect, useRef, type KeyboardEvent } from 'react'
import { hh, num, weekday } from '../lib/format'
import type { HourConditions } from '../lib/openMeteo'
import type { Score } from '../scoring/types'

const TILE_BG = ['', 'bg-s1 text-foam', 'bg-s2 text-foam', 'bg-s3 text-abyss', 'bg-s4 text-abyss', 'bg-s5 text-abyss']
const BAR_BG = ['', 'bg-s1', 'bg-s2', 'bg-s3', 'bg-s4', 'bg-s5']

interface Props {
  hours: HourConditions[]
  scores: Map<number, Score>
  /** Unix seconds of the selected hour. */
  selected: number
  onSelect: (time: number) => void
  timezone: string
  now: number
}

/**
 * Swipeable row of every forecast hour, coloured by score. Swiping is native scrolling
 * with scroll-snap (smoothest on phones); tapping or the arrow keys pick an hour.
 */
export const HourStrip = memo(function HourStrip({ hours, scores, selected, onSelect, timezone, now }: Props) {
  const reduce = useReducedMotion()
  const scroller = useRef<HTMLDivElement>(null)
  const firstScroll = useRef(true)

  // Keep the selected hour in view (e.g. after picking a day tab).
  useEffect(() => {
    const box = scroller.current
    const el = box?.querySelector<HTMLElement>(`[data-time="${selected}"]`)
    if (!box || !el) return
    const left = el.offsetLeft - (box.clientWidth - el.offsetWidth) / 2
    box.scrollTo({ left, behavior: reduce || firstScroll.current ? 'auto' : 'smooth' })
    firstScroll.current = false
  }, [selected, reduce])

  const onKeyDown = (e: KeyboardEvent) => {
    const i = hours.findIndex((h) => h.time === selected)
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : -1
    if (next < 0 || next >= hours.length || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return
    e.preventDefault()
    onSelect(hours[next].time)
    scroller.current?.querySelector<HTMLElement>(`[data-time="${hours[next].time}"]`)?.focus({ preventScroll: true })
  }

  return (
    <m.div
      ref={scroller}
      layoutScroll // lets the sliding selection ring account for the strip's scroll position
      role="listbox"
      aria-label="Pick an hour"
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-1 overflow-x-auto overscroll-x-contain px-4 pt-1 pb-3 [scrollbar-width:none] sm:-mx-8 sm:scroll-px-8 sm:px-8 [&::-webkit-scrollbar]:hidden"
    >
      {hours.map((h, i) => {
        const s = scores.get(h.time)!
        const isSel = h.time === selected
        const isNow = now >= h.time && now < h.time + 3600
        const past = h.time + 3600 <= now
        const hour = hh(h.time, timezone)
        const dayStart = i === 0 || hour === '00'
        return (
          <button
            key={h.time}
            type="button"
            role="option"
            aria-selected={isSel}
            tabIndex={isSel ? 0 : -1}
            data-time={h.time}
            onClick={() => onSelect(h.time)}
            // Past and night hours: dark tile with the score as a coloured bar (readable, but quiet).
            // Full-strength text everywhere, so it passes contrast checks.
            className={`relative flex w-12 shrink-0 snap-start flex-col items-center overflow-hidden rounded-lg pt-1 pb-1.5 transition-colors duration-300 ${
              past || !h.isDay ? 'bg-deep text-mist' : TILE_BG[s.value]
            } ${dayStart ? 'ml-2 first:ml-0' : ''}`}
          >
            {(past || !h.isDay) && <span className={`absolute inset-x-0 top-0 h-1 ${BAR_BG[s.value]}`} aria-hidden />}
            {/* The accessible name is the visible text plus a few hidden words, e.g. "Sat 4 Good, 07h 0.8m waves". */}
            {(isNow || !dayStart) && <span className="sr-only">{weekday(h.time, timezone)} </span>}
            <span className="h-4 text-[0.7rem] leading-4 font-semibold">
              {isNow ? 'Now' : dayStart ? weekday(h.time, timezone) : ''}
            </span>
            <span className="font-display text-2xl leading-none font-extrabold">
              {s.value}
              <span className="sr-only">
                {' '}
                {s.label}
                {s.source === 'ai' ? ', AI-corrected' : ''},
              </span>
            </span>
            <span className="mt-1 text-xs tabular-nums">{hour}h</span>
            <span className="text-[0.7rem] tabular-nums">
              {num(h.waveHeight)}m<span className="sr-only"> waves</span>
            </span>
            {s.source === 'ai' && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-sand" aria-hidden />}
            {isSel && (
              <m.span
                layoutId="strip-selected"
                className="pointer-events-none absolute -inset-0.5 rounded-[0.6rem] ring-2 ring-foam"
                transition={{ type: 'spring', stiffness: 500, damping: 40 }}
              />
            )}
          </button>
        )
      })}
    </m.div>
  )
})
