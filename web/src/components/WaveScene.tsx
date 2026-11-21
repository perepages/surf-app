import {
  animate,
  m,
  useAnimationFrame,
  useInView,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'framer-motion'
import { useEffect, useRef, type ReactNode } from 'react'

// A side view of the sea. Wave height sets how tall the crests are; the swell period sets
// how often a crest passes (one wavelength every `period` seconds, like the real sea).
//
// Performance: the only per-frame work is writing one `transform` per layer from a motion
// value (no React re-render, no path morphing), so the browser can composite it on the GPU.
// The loop stops when the scene is off screen or the tab is hidden (rAF pauses).

const WAVELENGTH = 100 // viewBox units
const TILE = 400 // one tile = 4 wavelengths; the SVG is 2 tiles wide and loops
const BAND = 60 // height of the crest band in viewBox units
const MAX_HEIGHT_M = 2.5 // crests fill the band at this height

function crestPath(closed: boolean): string {
  let d = `M0 ${BAND}`
  for (let x = 0; x < 2 * TILE; x += WAVELENGTH) {
    // Steeper front face, longer back: reads as a wave moving left (towards the beach).
    d += ` C ${x + 28} ${BAND} ${x + 36} 6 ${x + 52} 3 C ${x + 64} 1 ${x + 76} ${BAND} ${x + WAVELENGTH} ${BAND}`
  }
  return closed ? `${d} L${2 * TILE} ${BAND + 2} L0 ${BAND + 2} Z` : d
}
const FILLED = crestPath(true)
const LINE = crestPath(false)

/** 0.06 (almost flat) .. 1 (band full) */
function crestScale(heightM: number | null): number {
  const h = Math.max(0, Math.min(heightM ?? 0, MAX_HEIGHT_M))
  return 0.06 + (h / MAX_HEIGHT_M) * 0.94
}

interface Props {
  heightM: number | null
  periodS: number | null
  /** Overlay content, e.g. a caption. */
  children?: ReactNode
}

export function WaveScene({ heightM, periodS, children }: Props) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref)

  // Phases in tiles (0..1). Back layer drifts slower for a bit of depth.
  const front = useMotionValue(0)
  const back = useMotionValue(0.37)
  const tilesPerSecond = useRef(0)
  useEffect(() => {
    const p = periodS && periodS > 0 ? periodS : 6
    tilesPerSecond.current = WAVELENGTH / TILE / p
  }, [periodS])

  useAnimationFrame((_, delta) => {
    if (reduce || !inView) return
    const step = (Math.min(delta, 100) / 1000) * tilesPerSecond.current // cap: no jump after a stall
    front.set((front.get() + step) % 1)
    back.set((back.get() + step * 0.72) % 1)
  })
  const xFront = useTransform(front, (p) => `${-p * 50}%`)
  const xBack = useTransform(back, (p) => `${-p * 50}%`)

  // Crest height eases to the new value when you pick another hour.
  const scale = useMotionValue(crestScale(heightM))
  const scaleBack = useTransform(scale, (s) => s * 0.65)
  useEffect(() => {
    const target = crestScale(heightM)
    if (reduce) {
      scale.set(target)
      return
    }
    const c = animate(scale, target, { type: 'spring', stiffness: 70, damping: 16 })
    return () => c.stop()
  }, [heightM, reduce, scale])

  return (
    <div ref={ref} className="relative h-44 overflow-hidden rounded-2xl bg-deep/60" aria-hidden>
      {/* back swell line */}
      <m.div className="absolute inset-x-0 bottom-[4.25rem] h-16" style={{ scaleY: scaleBack, originY: 1 }}>
        <m.svg
          viewBox={`0 0 ${2 * TILE} ${BAND}`}
          preserveAspectRatio="none"
          className="h-full w-[200%] will-change-transform"
          style={{ x: xBack }}
        >
          <path d={FILLED} fill="#0a3542" />
        </m.svg>
      </m.div>
      {/* fills the gap between the back line's troughs and the water, so it reads as one sea */}
      <div className="absolute inset-x-0 bottom-[3.45rem] h-[0.85rem] bg-[#0a3542]" />

      {/* front wave */}
      <m.div className="absolute inset-x-0 bottom-[3.45rem] h-20" style={{ scaleY: scale, originY: 1 }}>
        <m.svg
          viewBox={`0 0 ${2 * TILE} ${BAND}`}
          preserveAspectRatio="none"
          className="h-full w-[200%] will-change-transform"
          style={{ x: xFront }}
        >
          <path d={FILLED} fill="#0c4150" />
          <path d={LINE} fill="none" stroke="#e6f2ee" strokeOpacity="0.85" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </m.svg>
      </m.div>

      {/* water body */}
      <div className="absolute inset-x-0 bottom-0 h-14 bg-[#0c4150]" />

      {children && <div className="absolute inset-x-0 top-0 p-3">{children}</div>}
    </div>
  )
}
