import { FALLBACK_SPOTS, type SpotConfig } from './spots.config'
import { selectRows, supabaseConfigured } from './supabase'

export type Spot = SpotConfig
// Spots live in the Supabase `spots` table (config-driven); spots.config.ts has the offline copy.
export { DEFAULT_SPOT_ID, FALLBACK_SPOTS } from './spots.config'

interface SpotRow {
  id: string
  name: string
  lat: number
  lon: number
  beach_orientation: number
}

export async function loadSpot(id: string, signal?: AbortSignal): Promise<Spot> {
  const fallback = FALLBACK_SPOTS[id]
  if (supabaseConfigured) {
    try {
      const rows = await selectRows<SpotRow>(
        'spots',
        `select=id,name,lat,lon,beach_orientation&id=eq.${encodeURIComponent(id)}`,
        signal,
      )
      const r = rows[0]
      if (r) return { id: r.id, name: r.name, lat: r.lat, lon: r.lon, beachOrientation: r.beach_orientation }
    } catch (err) {
      if (signal?.aborted) throw err
      console.warn('Could not load spot from Supabase, using built-in copy', err)
    }
  }
  if (!fallback) throw new Error(`Unknown spot "${id}"`)
  return fallback
}
