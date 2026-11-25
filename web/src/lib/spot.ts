import { FALLBACK_SPOTS, type SpotConfig } from './spots.config'
import { selectRows, supabaseConfigured } from './supabase'

export type Spot = SpotConfig
// Spots live in the Supabase `spots` table (config-driven); spots.config.ts has the offline copy.
export { DEFAULT_SPOT_ID, FALLBACK_SPOTS } from './spots.config'

export interface SpotRow {
  id: string
  name: string
  lat: number
  lon: number
  beach_orientation: number
  swell_window_min: number | null
  swell_window_max: number | null
}

export const SPOT_COLUMNS = 'id,name,lat,lon,beach_orientation,swell_window_min,swell_window_max'

export function spotFromRow(r: SpotRow): Spot {
  return {
    id: r.id,
    name: r.name,
    lat: r.lat,
    lon: r.lon,
    beachOrientation: r.beach_orientation,
    swellWindowMin: r.swell_window_min,
    swellWindowMax: r.swell_window_max,
  }
}

export async function loadSpot(id: string, signal?: AbortSignal): Promise<Spot> {
  const fallback = FALLBACK_SPOTS[id]
  if (supabaseConfigured) {
    try {
      const rows = await selectRows<SpotRow>(
        'spots',
        `select=${SPOT_COLUMNS}&id=eq.${encodeURIComponent(id)}`,
        signal,
      )
      const r = rows[0]
      if (r) return spotFromRow(r)
    } catch (err) {
      if (signal?.aborted) throw err
      console.warn('Could not load spot from Supabase, using built-in copy', err)
    }
  }
  if (!fallback) throw new Error(`there’s no spot called "${id}" (it may have been removed)`)
  return fallback
}
