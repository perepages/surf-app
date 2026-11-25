// Built-in copy of the spots, used when Supabase can't be reached (and by vite.config.ts to
// prefetch the forecast from index.html). The real list lives in the Supabase `spots` table.
// No imports here on purpose: vite.config.ts loads this file at build time.

export interface SpotConfig {
  id: string
  name: string
  lat: number
  lon: number
  /** Beach normal: degrees the beach faces, towards the sea (0 = N, 90 = E). */
  beachOrientation: number
  /** Swell window, clockwise from min to max (degrees swell comes from); null = normal ± 90. */
  swellWindowMin?: number | null
  swellWindowMax?: number | null
}

export const FALLBACK_SPOTS: Record<string, SpotConfig> = {
  vilanova: {
    id: 'vilanova',
    name: 'Vilanova i la Geltrú (Platja de Vilanova)',
    lat: 41.2097,
    lon: 1.7128,
    beachOrientation: 165,
    swellWindowMin: 105,
    swellWindowMax: 240,
  },
}

export const DEFAULT_SPOT_ID = 'vilanova'
