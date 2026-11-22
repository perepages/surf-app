// Small drawings used across the screen: wind arrow, wave-power meter, today's tide.

import { hh } from '../lib/format'
import type { PowerLevel } from '../lib/conditions'
import type { HourConditions } from '../lib/openMeteo'

/** Arrow pointing where the wind blows TO (rotate from windInfo). Colour from `currentColor`. */
export function WindArrow({ rotate, size = 14, className = '' }: { rotate: number; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={`shrink-0 ${className}`} style={{ transform: `rotate(${rotate}deg)` }}>
      <path d="M12 21 V4 M5.5 10.5 L12 4 L18.5 10.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 4 bars, `level` of them lit: weak / medium / strong / heavy. */
export function PowerMeter({ level, small = false }: { level: PowerLevel; small?: boolean }) {
  return (
    <span className="flex gap-0.5" aria-hidden>
      {[1, 2, 3, 4].map((i) => (
        <span key={i} className={`rounded-full ${small ? 'h-1 w-2' : 'h-1.5 w-3.5'} ${i <= level ? 'bg-foam' : 'bg-[#2e6676]'}`} />
      ))}
    </span>
  )
}

const W = 140
const H = 30

/** Today's sea level as a little curve with a dot at "now". Null when there is no tide data. */
export function TideMini({ hours, now, timezone }: { hours: HourConditions[]; now: number; timezone: string }) {
  const pts = hours.filter((h): h is HourConditions & { tide: number } => h.tide != null)
  if (pts.length < 3) return null
  const t0 = pts[0].time
  const t1 = pts[pts.length - 1].time
  const lo = Math.min(...pts.map((p) => p.tide))
  const hi = Math.max(...pts.map((p) => p.tide))
  const span = Math.max(hi - lo, 0.02)
  const x = (t: number) => 2 + ((t - t0) / Math.max(t1 - t0, 1)) * (W - 4)
  const y = (v: number) => 4 + (1 - (v - lo) / span) * (H - 14)
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.time).toFixed(1)} ${y(p.tide).toFixed(1)}`).join(' ')
  const nowPt = pts.reduce((a, b) => (Math.abs(b.time - now) < Math.abs(a.time - now) ? b : a))
  const ticks = pts.filter((p) => ['06', '12', '18'].includes(hh(p.time, timezone)))
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Tide today">
      <path d={line} fill="none" stroke="var(--color-mist)" strokeWidth="1.6" />
      {now >= t0 && now <= t1 + 3600 && <circle cx={x(nowPt.time)} cy={y(nowPt.tide)} r="3.5" fill="var(--color-foam)" />}
      {ticks.map((p) => (
        <text key={p.time} x={x(p.time)} y={H - 1} textAnchor="middle" fontSize="9" fill="var(--color-mist)">
          {hh(p.time, timezone)}h
        </text>
      ))}
    </svg>
  )
}

/** Tide range of a day in cm (high minus low), or null. */
export function tideRangeCm(hours: HourConditions[]): number | null {
  const t = hours.map((h) => h.tide).filter((v): v is number => v != null)
  return t.length < 2 ? null : Math.round((Math.max(...t) - Math.min(...t)) * 100)
}
