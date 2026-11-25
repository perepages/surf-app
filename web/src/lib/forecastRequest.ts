// What the app asks Open-Meteo for. Pure (no browser APIs, no imports) so vite.config.ts can
// use the same function to write the prefetch into index.html: the URLs always match.

export const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine'
export const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast'

/** Today + the next 3 days. */
const FORECAST_DAYS = 4
/** The last 14 days too: "yesterday" ratings need their conditions, and the
 *  forecast-vs-surfers chart recomputes the simple score for each past day. */
const PAST_DAYS = 14

/** A saved forecast younger than this is used without asking Open-Meteo again. */
export const CACHE_TTL_MS = 30 * 60 * 1000
/** Small localStorage key with the last fetch time (index.html reads it without parsing the forecast). */
export const FETCHED_AT_KEY = 'surf:forecast-fetched-at'

export const DEFAULT_MARINE_MODEL = 'best_match'
// The default marine model sometimes returns nulls near this coast; GFS wave fills the gaps.
// (Same fallback as the old collector/forecast.py.) Tide only exists in the default model.
export const FALLBACK_MARINE_MODEL = 'ncep_gfswave025'

export const WAVE_VARS = [
  'wave_height',
  'wave_period',
  'wave_direction',
  'swell_wave_height',
  'swell_wave_period',
  'swell_wave_direction',
  // Every wave train, for the physics score's cleanliness / crossed-swell checks.
  'secondary_swell_wave_height',
  'secondary_swell_wave_period',
  'secondary_swell_wave_direction',
  'wind_wave_height',
  'wind_wave_period',
  'wind_wave_direction',
] as const
const TIDE_VARS = ['sea_level_height_msl', 'sea_surface_temperature'] as const
const WIND_VARS = [
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'is_day',
  // Comfort + safety (physics score): rain, thunderstorms, cold.
  'precipitation',
  'precipitation_probability',
  'weather_code',
  'cape',
  'temperature_2m',
] as const

type Coords = { lat: number | string; lon: number | string }

export function baseParams(spot: Coords): Record<string, string> {
  return {
    latitude: String(spot.lat),
    longitude: String(spot.lon),
    timezone: 'auto', // days start at local midnight; times still come back as UTC unix seconds
    timeformat: 'unixtime',
    forecast_days: String(FORECAST_DAYS),
    past_days: String(PAST_DAYS),
  }
}

export const marineParams = (spot: Coords) => ({
  ...baseParams(spot),
  hourly: [...WAVE_VARS, ...TIDE_VARS].join(','),
  models: DEFAULT_MARINE_MODEL,
})

export const weatherParams = (spot: Coords) => ({
  ...baseParams(spot),
  hourly: WIND_VARS.join(','),
  daily: 'sunrise,sunset',
})

/** The two requests every forecast starts with (marine + weather). */
export function primaryRequestUrls(spot: Coords): string[] {
  return [
    `${MARINE_URL}?${new URLSearchParams(marineParams(spot))}`,
    `${WEATHER_URL}?${new URLSearchParams(weatherParams(spot))}`,
  ]
}
