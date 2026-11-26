// The sky for an hour (or a day) as one of a few kinds, for the small weather icons in
// "Hour by hour" and "Next days". From Open-Meteo's WMO weather code, plus the rain numbers so
// the icon agrees with the score's rain/thunder checks (scoring/physics.ts): a storm is code
// 95/96/99, or CAPE >= 1000 J/kg with rain, the same rule as the thunderstorm warning.

import type { HourConditions } from './forecast'

export type Sky = 'clear' | 'partly' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm'

/** Worst first: a day shows the worst sky of its daylight hours. */
const SEVERITY: Sky[] = ['storm', 'snow', 'rain', 'drizzle', 'fog', 'cloudy', 'partly', 'clear']

/** Rain chance shown under an icon from this %. */
export const SHOW_RAIN_FROM = 20

export function skyOf(h: HourConditions): Sky | null {
  const code = h.weatherCode
  const rain = h.precipitation ?? 0
  if (code == null && h.precipitation == null) return null // old saved copy: nothing to show
  if (code === 95 || code === 96 || code === 99 || ((h.cape ?? 0) >= 1000 && rain > 0)) return 'storm'
  if (code != null && ((code >= 71 && code <= 77) || code === 85 || code === 86)) return 'snow'
  if ((code != null && ((code >= 61 && code <= 67) || (code >= 80 && code <= 82))) || rain >= 0.5) return 'rain'
  if ((code != null && code >= 51 && code <= 57) || rain > 0) return 'drizzle'
  if (code === 45 || code === 48) return 'fog'
  if (code === 3) return 'cloudy'
  if (code === 1 || code === 2) return 'partly'
  return 'clear'
}

/** The day's sky = the worst daylight hour, and the highest rain chance among those hours. */
export function daySky(hours: HourConditions[]): { sky: Sky | null; rainChance: number | null } {
  let worst: Sky | null = null
  let chance: number | null = null
  for (const h of hours) {
    const s = skyOf(h)
    if (s && (worst == null || SEVERITY.indexOf(s) < SEVERITY.indexOf(worst))) worst = s
    if (h.precipProb != null) chance = Math.max(chance ?? 0, h.precipProb)
  }
  return { sky: worst, rainChance: chance }
}
