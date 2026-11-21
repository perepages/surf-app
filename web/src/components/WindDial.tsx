import { animate, m, useMotionValue, useReducedMotion } from 'framer-motion'
import { useEffect } from 'react'
import { compass, windRelation, type WindRelation } from '../lib/geo'

const COLOR: Record<WindRelation, string> = { offshore: '#5fe3c0', cross: '#8fb3bc', onshore: '#ff7a66' }
const WORD: Record<WindRelation, string> = { offshore: 'offshore', cross: 'cross-shore', onshore: 'onshore' }

/** Shortest signed turn from a to b, -180..180. */
const turn = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180

interface Props {
  from: number | null
  speed: number | null
  beachFaces: number
}

/**
 * Compass with the sea side marked. The arrow points where the wind blows to, turns the
 * short way round when the direction changes, and is green offshore / red onshore.
 */
export function WindDial({ from, speed, beachFaces }: Props) {
  const reduce = useReducedMotion()
  const rel = from == null ? null : windRelation(from, beachFaces)
  const color = rel ? COLOR[rel] : '#8fb3bc'

  const rotate = useMotionValue(from == null ? 0 : from + 180)
  useEffect(() => {
    if (from == null) return
    const target = rotate.get() + turn(rotate.get(), from + 180)
    if (reduce) {
      rotate.set(target)
      return
    }
    const c = animate(rotate, target, { type: 'spring', stiffness: 80, damping: 13 })
    return () => c.stop()
  }, [from, reduce, rotate])

  // Sea arc: +-60 deg around the direction the beach faces.
  const arc = (deg: number) => {
    const r = ((deg - 90) * Math.PI) / 180
    return `${50 + 44 * Math.cos(r)} ${50 + 44 * Math.sin(r)}`
  }

  return (
    <div className="flex items-center gap-3">
      <div
        className="relative size-24 shrink-0"
        role="img"
        aria-label={from == null ? 'No wind data' : `Wind from ${compass(from)}, ${rel ? WORD[rel] : ''}`}
      >
        <svg viewBox="0 0 100 100" className="absolute inset-0 size-full" aria-hidden>
          <circle cx="50" cy="50" r="44" fill="none" stroke="#0f5257" strokeWidth="1.5" />
          <path d={`M ${arc(beachFaces - 60)} A 44 44 0 0 1 ${arc(beachFaces + 60)}`} fill="none" stroke="#3fa79a" strokeWidth="5" strokeLinecap="round" opacity="0.5" />
          <text x="50" y="13" textAnchor="middle" fontSize="9" fill="#8fb3bc">N</text>
        </svg>
        <m.div className="absolute inset-0" style={{ rotate }}>
          <svg viewBox="0 0 100 100" className="size-full" aria-hidden>
            <m.path
              d="M50 16 L62 40 L54 37 L54 84 L46 84 L46 37 L38 40 Z"
              initial={false}
              animate={{ fill: color }}
              transition={{ duration: reduce ? 0 : 0.5 }}
            />
          </svg>
        </m.div>
      </div>
      <div>
        <p className="font-display text-3xl leading-none font-extrabold tabular-nums">
          {speed == null ? '–' : Math.round(speed)} <span className="text-base">km/h</span>
        </p>
        <m.p className="mt-1 text-sm font-semibold" initial={false} animate={{ color }} transition={{ duration: reduce ? 0 : 0.5 }}>
          {rel ? WORD[rel] : 'no data'}
          {from != null && <span className="font-normal text-mist"> from the {compass(from)}</span>}
        </m.p>
        <p className="mt-0.5 text-xs text-mist">Green arc = the sea</p>
      </div>
    </div>
  )
}
