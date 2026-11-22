// A small looping wave for the spot list: taller for bigger waves, slower for longer periods,
// coloured by the score. Pure CSS animation of one transform (runs on the compositor, cheap
// for many rows); stopped under "reduce motion" (index.css).

import type { ScoreValue } from '../scoring/types'

const COLOUR: Record<ScoreValue, string> = {
  1: 'var(--color-s1)',
  2: 'var(--color-s2)',
  3: 'var(--color-s3)',
  4: 'var(--color-s4)',
  5: 'var(--color-s5)',
}

const W = 72 // visible width (px)
const H = 30
const LEN = 24 // wavelength (px): the path scrolls by one wavelength per loop, so it repeats seamlessly

/** A sine-like path from x = 0 to 2 * W, using quadratic curves (one hump up, one down). */
function wavePath(amp: number): string {
  const mid = H / 2 + 3
  let d = `M0 ${mid}`
  for (let x = 0; x < W * 2 + LEN; x += LEN) {
    d += ` Q${x + LEN / 4} ${mid - amp} ${x + LEN / 2} ${mid} T${x + LEN} ${mid}`
  }
  return d
}

export function MiniWave({ height, period, score }: { height: number | null; period: number | null; score: ScoreValue }) {
  // 0.2 m barely moves, 2 m+ fills the box.
  const amp = Math.max(1, Math.min(1, (height ?? 0) / 2) * (H / 2 - 3))
  // Real periods (4-14 s) are too slow to read at this size; keep the ratio, speed it up.
  const seconds = Math.max(4, Math.min(14, period ?? 6)) * 0.35
  const d = wavePath(amp)
  const colour = COLOUR[score]
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden className="shrink-0 overflow-hidden">
      <g className="mini-wave" style={{ animationDuration: `${seconds}s`, ['--wave-len' as string]: `${-LEN}px` }}>
        <path d={`${d} L${W * 2 + LEN} ${H} L0 ${H} Z`} fill={colour} opacity={0.18} />
        <path d={d} fill="none" stroke={colour} strokeWidth={2} strokeLinecap="round" />
      </g>
    </svg>
  )
}
