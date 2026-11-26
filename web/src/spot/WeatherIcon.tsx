// Small weather icons (inline SVG, same 20 px grid and stroke as Icons.tsx; no emoji, no package).
// Colour says the kind at a glance: sun = accent, rain/drizzle/snow = foam, storm = coral,
// clouds/fog/moon = muted.

import type { Sky } from '../lib/weather'

const sun = (
  <>
    <circle cx="10" cy="10" r="3.6" />
    <path d="M10 2.2v1.9M10 15.9v1.9M2.2 10h1.9M15.9 10h1.9M4.5 4.5l1.3 1.3M14.2 14.2l1.3 1.3M4.5 15.5l1.3-1.3M14.2 5.8l1.3-1.3" />
  </>
)
const moon = <path d="M14.8 12.6A6 6 0 0 1 7.4 5.2a6 6 0 1 0 7.4 7.4Z" />
const cloud = <path d="M6 15.2h8.2a3.2 3.2 0 0 0 .2-6.4 4.4 4.4 0 0 0-8.5 1.1A2.7 2.7 0 0 0 6 15.2Z" />
const cloudHigh = <path d="M6 12.4h8.2a3.2 3.2 0 0 0 .2-6.4 4.4 4.4 0 0 0-8.5 1.1A2.7 2.7 0 0 0 6 12.4Z" />

const COLOR: Record<Sky, string> = {
  clear: 'text-accent',
  partly: 'text-accent',
  cloudy: 'text-mist',
  fog: 'text-mist',
  drizzle: 'text-foam',
  rain: 'text-foam',
  snow: 'text-foam',
  storm: 'text-coral',
}

function shape(sky: Sky, night: boolean) {
  switch (sky) {
    case 'clear':
      return night ? moon : sun
    case 'partly':
      return (
        <>
          {night ? (
            <path d="M10.6 7.6A3.6 3.6 0 0 1 6.3 3.3a3.6 3.6 0 1 0 4.3 4.3Z" />
          ) : (
            <>
              <circle cx="7" cy="6.6" r="2.4" />
              <path d="M7 1.8v1M2.2 6.6h1M3.6 3.2l.7.7M10.4 3.2l-.7.7" />
            </>
          )}
          <path d="M7.6 16.2h7a2.7 2.7 0 0 0 .2-5.4 3.8 3.8 0 0 0-7.3.9 2.3 2.3 0 0 0 .1 4.5Z" />
        </>
      )
    case 'cloudy':
      return cloud
    case 'fog':
      return <path d="M3.5 7h13M2.5 10.5h15M4.5 14h11" />
    case 'drizzle':
      return (
        <>
          {cloudHigh}
          <path d="M7 15.6v.1M10 16.6v.1M13 15.6v.1" strokeWidth={2.2} />
        </>
      )
    case 'rain':
      return (
        <>
          {cloudHigh}
          <path d="M7.2 14.4l-.9 2.6M10.2 14.4l-.9 2.6M13.2 14.4l-.9 2.6" />
        </>
      )
    case 'snow':
      return (
        <>
          {cloudHigh}
          <path d="M7 15.8h.01M10 17h.01M13 15.8h.01" strokeWidth={2.4} />
        </>
      )
    case 'storm':
      return (
        <>
          {cloudHigh}
          <path d="M10.6 12.6 8.6 15.6h2.6l-1.6 2.8" />
        </>
      )
  }
}

export function WeatherIcon({ sky, night = false, size = 16, className = '' }: { sky: Sky; night?: boolean; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`${night && (sky === 'clear' || sky === 'partly') ? 'text-mist' : COLOR[sky]} ${className}`}
    >
      {shape(sky, night)}
    </svg>
  )
}
