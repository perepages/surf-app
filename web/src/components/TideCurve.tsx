import { memo } from 'react'
import { m } from 'framer-motion'
import { hhmm } from '../lib/format'
import type { HourConditions } from '../lib/openMeteo'

const W = 400
const H = 64
const PAD_Y = 14

type TidePoint = HourConditions & { tide: number }

/** Sea level at any moment, linear between the hourly points. */
function tideAt(pts: TidePoint[], t: number): number | null {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (t >= a.time && t <= b.time) return a.tide + ((b.tide - a.tide) * (t - a.time)) / (b.time - a.time)
  }
  return null
}

interface Props {
  hours: HourConditions[]
  timezone: string
  /** Unix seconds. */
  now: number
  /** Hour picked in the strip (unix seconds), marked with a line. */
  selected: number
}

/** Sea level over one day, high/low tide times, a "now" dot that moves with the clock. */
export const TideCurve = memo(function TideCurve({ hours, timezone, now, selected }: Props) {
  const pts = hours.filter((h) => h.tide != null) as TidePoint[]
  if (pts.length < 3) return null

  const t0 = hours[0].time
  const t1 = hours[hours.length - 1].time
  const lo = Math.min(...pts.map((p) => p.tide))
  const hi = Math.max(...pts.map((p) => p.tide))
  const span = Math.max(hi - lo, 0.05)
  const x = (t: number) => ((t - t0) / Math.max(t1 - t0, 1)) * W
  const y = (v: number) => PAD_Y + (1 - (v - lo) / span) * (H - 2 * PAD_Y)

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.time).toFixed(1)} ${y(p.tide).toFixed(1)}`).join(' ')
  const area = `${line} L${x(pts[pts.length - 1].time).toFixed(1)} ${H} L${x(pts[0].time).toFixed(1)} ${H} Z`

  // Turning points = high and low tides. Small wiggles close together would overlap their
  // labels, so a turning point within 4 h of the last kept one is skipped.
  const turns: TidePoint[] = []
  pts.forEach((p, i) => {
    const a = pts[i - 1]
    const b = pts[i + 1]
    if (!a || !b) return
    const isTurn = (p.tide > a.tide && p.tide >= b.tide) || (p.tide < a.tide && p.tide <= b.tide)
    const last = turns[turns.length - 1]
    if (isTurn && (!last || p.time - last.time >= 4 * 3600)) turns.push(p)
  })

  const nowTide = tideAt(pts, now)
  const showSelected = selected >= t0 && selected <= t1 && !(now >= selected && now < selected + 3600)

  return (
    <figure className="relative h-16">
      {/* Day changes fade the curve in (opacity only, cheap to composite). */}
      <m.svg
        key={t0}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block size-full"
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.35 }}
      >
        <path d={area} fill="#0f5257" fillOpacity="0.45" />
        <path d={line} fill="none" stroke="#8fb3bc" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {showSelected && (
          <line x1={x(selected)} x2={x(selected)} y1="0" y2={H} stroke="#e6f2ee" strokeOpacity="0.6" strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
        )}
      </m.svg>

      {/* HTML overlays so text and the dot aren't stretched with the curve. */}
      {turns.map((p) => {
        const high = p.tide >= (hi + lo) / 2
        return (
          <span
            key={p.time}
            className="absolute -translate-x-1/2 text-xs whitespace-nowrap text-mist"
            style={{ left: `${(x(p.time) / W) * 100}%`, top: high ? -4 : H - 14 }}
          >
            {high ? 'High' : 'Low'} {hhmm(p.time, timezone)}
          </span>
        )
      })}

      {nowTide != null && (
        // Moves once a minute with the clock; the ring pulse is CSS (transform + opacity only).
        <m.span
          className="absolute size-3 -translate-x-1/2 -translate-y-1/2"
          initial={false}
          animate={{ left: `${(x(now) / W) * 100}%`, top: y(nowTide) }}
          transition={{ duration: 1, ease: 'easeInOut' }}
          role="img"
          aria-label={`Now, tide ${Math.round(nowTide * 100)} cm`}
        >
          <span className="absolute inset-0 rounded-full bg-glass opacity-60 motion-safe:animate-ping" />
          <span className="absolute inset-0 rounded-full bg-glass ring-2 ring-abyss" />
        </m.span>
      )}

      <figcaption className="sr-only">
        Tide: {turns.map((p) => `${p.tide >= (hi + lo) / 2 ? 'high' : 'low'} at ${hhmm(p.time, timezone)}`).join(', ')}
      </figcaption>
    </figure>
  )
})
