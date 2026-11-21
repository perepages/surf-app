import { compass } from '../lib/geo'

/** Arrow pointing where the wind/swell is going (it comes FROM `from` degrees). */
export function DirectionArrow({ from, className = '' }: { from: number | null; className?: string }) {
  if (from == null) return <span className={className}>–</span>
  return (
    <svg
      viewBox="0 0 12 12"
      className={`inline-block size-3 shrink-0 ${className}`}
      style={{ transform: `rotate(${from + 180}deg)` }}
      role="img"
      aria-label={`from ${compass(from)}`}
    >
      <title>{`from ${compass(from)} (${Math.round(from)}°)`}</title>
      <path d="M6 0.5 L10.5 10.5 L6 8 L1.5 10.5 Z" fill="currentColor" />
    </svg>
  )
}
