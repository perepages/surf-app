// Small angle helpers. All directions are degrees, 0 = N, 90 = E, and mean
// "where it comes FROM" (the meteorological convention Open-Meteo uses).

/** Smallest difference between two directions, 0..180. */
export function angleDiff(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180)
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

/** 8-point compass name, e.g. 160 -> "SE". */
export function compass(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]
}

export type WindRelation = 'offshore' | 'cross' | 'onshore'

/**
 * Offshore = wind blows from the land out to sea, i.e. it comes from the opposite
 * of the direction the beach faces. Within 45 deg of that is offshore, within 45 deg
 * of straight onshore is onshore, the rest is cross-shore.
 */
export function windRelation(windFrom: number, beachFaces: number): WindRelation {
  const fromLand = (beachFaces + 180) % 360
  const d = angleDiff(windFrom, fromLand)
  if (d <= 45) return 'offshore'
  if (d >= 135) return 'onshore'
  return 'cross'
}
