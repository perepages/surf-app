// Open-Meteo Marine + Forecast APIs, fetched straight from the browser.
// No API key; non-commercial use only; the UI must credit "Weather data by Open-Meteo.com".
// The last answer is kept in localStorage: reused for 30 minutes, and shown when offline.

import type { Spot } from './spot'

import {
  CACHE_TTL_MS,
  DEFAULT_MARINE_MODEL,
  FALLBACK_MARINE_MODEL,
  FETCHED_AT_KEY,
  MARINE_URL,
  WAVE_VARS,
  WEATHER_URL,
  baseParams,
  marineParams,
  weatherParams,
} from './forecastRequest'
import { OPEN_METEO_TIMEOUT_MS, untilAbort, withTimeout } from './http'

const CACHE_VERSION = 3 // bump when the cached shape or request changes

export interface HourConditions {
  /** Unix seconds, UTC. */
  time: number
  waveHeight: number | null // m, combined sea state
  wavePeriod: number | null // s
  waveDirection: number | null // deg, where waves come from
  swellHeight: number | null
  swellPeriod: number | null
  swellDirection: number | null
  windSpeed: number | null // km/h
  windDirection: number | null // deg, where wind comes from
  windGusts: number | null
  tide: number | null // m relative to mean sea level
  isDay: boolean
}

export interface ForecastDay {
  /** Local date at the spot, YYYY-MM-DD. */
  date: string
  sunrise: number | null // unix s
  sunset: number | null
  hours: HourConditions[]
}

/** Days include yesterday (for ratings); the forecast UI starts at today. */
export interface Forecast {
  spotId: string
  /** Unix ms when Open-Meteo was fetched. */
  fetchedAt: number
  /** IANA time zone of the spot, used only for display. */
  timezone: string
  marineModel: string
  days: ForecastDay[]
}

type Hourly = Record<string, (number | null)[]> & { time: number[] }

interface ApiResponse {
  timezone: string
  hourly: Hourly
  daily?: { time: number[]; sunrise: number[]; sunset: number[] }
}

declare global {
  interface Window {
    /** Requests started by the inline script in index.html before the app's JavaScript arrived. */
    __surfPrefetch?: Record<string, Promise<Response | null> | undefined>
  }
}

/** Uses a response the page already started downloading for exactly this URL, if any (once). */
function takePrefetched(url: string): Promise<Response | null> | undefined {
  const store = window.__surfPrefetch
  if (!store) return undefined
  store.__started = Promise.resolve(null) // if the prefetch hasn't started yet, it never will
  const p = store[url]
  if (p) delete store[url]
  return p
}

async function getJson(url: string, params: Record<string, string>, outer?: AbortSignal): Promise<ApiResponse> {
  const full = `${url}?${new URLSearchParams(params)}`
  return withTimeout(outer, OPEN_METEO_TIMEOUT_MS, 'Open-Meteo', async (signal) => {
    // A prefetch started by index.html can't be cancelled, so stop waiting for it on timeout.
    const prefetched = takePrefetched(full)
    const res = (prefetched && (await untilAbort(prefetched, signal))) || (await fetch(full, { signal }))
    if (!res.ok) {
      let reason = ''
      try {
        reason = ((await res.json()) as { reason?: string }).reason ?? ''
      } catch {
        /* body was not JSON */
      }
      throw new Error(`Open-Meteo ${new URL(url).hostname}: HTTP ${res.status} ${reason}`.trim())
    }
    return (await res.json()) as ApiResponse
  })
}

const value = (h: Hourly, name: string, i: number): number | null => h[name]?.[i] ?? null

async function fetchFromApi(spot: Spot, signal?: AbortSignal): Promise<Forecast> {
  const base = baseParams(spot)
  const [marine, weather] = await Promise.all([
    getJson(MARINE_URL, marineParams(spot), signal),
    getJson(WEATHER_URL, weatherParams(spot), signal),
  ])

  // Fill wave nulls from the fallback model, hour by hour.
  let marineModel = DEFAULT_MARINE_MODEL
  const hasGaps = WAVE_VARS.some((v) => marine.hourly[v]?.some((x) => x == null))
  if (hasGaps) {
    try {
      const fb = await getJson(MARINE_URL, { ...base, hourly: WAVE_VARS.join(','), models: FALLBACK_MARINE_MODEL }, signal)
      const fbIndex = new Map(fb.hourly.time.map((t, i) => [t, i]))
      marine.hourly.time.forEach((t, i) => {
        const j = fbIndex.get(t)
        if (j === undefined) return
        for (const v of WAVE_VARS) {
          const col = marine.hourly[v]
          if (col && col[i] == null) col[i] = value(fb.hourly, v, j)
        }
      })
      marineModel = `${DEFAULT_MARINE_MODEL}+${FALLBACK_MARINE_MODEL}`
    } catch (err) {
      if (signal?.aborted) throw err
      console.warn('Fallback marine model failed', err)
    }
  }

  const windIndex = new Map(weather.hourly.time.map((t, i) => [t, i]))
  const hours: HourConditions[] = marine.hourly.time.map((t, i) => {
    const w = windIndex.get(t)
    const m = marine.hourly
    return {
      time: t,
      waveHeight: value(m, 'wave_height', i),
      wavePeriod: value(m, 'wave_period', i),
      waveDirection: value(m, 'wave_direction', i),
      swellHeight: value(m, 'swell_wave_height', i),
      swellPeriod: value(m, 'swell_wave_period', i),
      swellDirection: value(m, 'swell_wave_direction', i),
      tide: value(m, 'sea_level_height_msl', i),
      windSpeed: w === undefined ? null : value(weather.hourly, 'wind_speed_10m', w),
      windDirection: w === undefined ? null : value(weather.hourly, 'wind_direction_10m', w),
      windGusts: w === undefined ? null : value(weather.hourly, 'wind_gusts_10m', w),
      isDay: w === undefined ? true : value(weather.hourly, 'is_day', w) === 1,
    }
  })

  const timezone = weather.timezone || marine.timezone || 'UTC'
  const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const localDate = (unix: number) => dateFmt.format(unix * 1000)

  const daily = weather.daily
  const days: ForecastDay[] = []
  for (const h of hours) {
    const date = localDate(h.time)
    let day = days[days.length - 1]
    if (!day || day.date !== date) {
      const di = daily ? daily.time.findIndex((d) => localDate(d) === date) : -1
      day = {
        date,
        sunrise: di >= 0 ? (daily!.sunrise[di] ?? null) : null,
        sunset: di >= 0 ? (daily!.sunset[di] ?? null) : null,
        hours: [],
      }
      days.push(day)
    }
    day.hours.push(h)
  }

  return { spotId: spot.id, fetchedAt: Date.now(), timezone, marineModel, days }
}

// ---------- cache (localStorage; can be unavailable, so every access is guarded) ----------

const cacheKey = (spot: Spot) => `surf:forecast:v${CACHE_VERSION}:${spot.id}:${spot.lat},${spot.lon}`

function readCache(spot: Spot): Forecast | null {
  try {
    const raw = localStorage.getItem(cacheKey(spot))
    return raw ? (JSON.parse(raw) as Forecast) : null
  } catch {
    return null
  }
}

function writeCache(spot: Spot, f: Forecast) {
  try {
    // One saved forecast per spot (each spot opens offline). Drop copies from older cache
    // versions and this spot's old coordinates; other spots' copies stay.
    const current = `surf:forecast:v${CACHE_VERSION}:`
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith('surf:forecast:') || k === cacheKey(spot)) continue
      if (!k.startsWith(current) || k.startsWith(`${current}${spot.id}:`)) localStorage.removeItem(k)
    }
    localStorage.setItem(cacheKey(spot), JSON.stringify(f))
    // Small companion key: lets index.html decide whether to prefetch without parsing the forecast.
    localStorage.setItem(`${FETCHED_AT_KEY}:${spot.id}`, String(f.fetchedAt))
    localStorage.removeItem(FETCHED_AT_KEY) // the single-spot key used up to 0.3.0
  } catch {
    /* storage full or blocked: the app still works, just without a cache */
  }
}

/** Younger than 30 minutes: no need to ask Open-Meteo again. */
export function isFresh(f: Forecast): boolean {
  return Date.now() - f.fetchedAt < CACHE_TTL_MS
}

/**
 * The last saved forecast for this spot, however old, as long as it still reaches into the
 * future (otherwise there's nothing useful to show). Used to paint the screen instantly and
 * when offline.
 */
export function readCachedForecast(spot: Spot): Forecast | null {
  const f = readCache(spot)
  if (!f) return null
  const last = f.days.at(-1)?.hours.at(-1)?.time ?? 0
  return last * 1000 > Date.now() ? f : null
}

/** Asks Open-Meteo and saves the answer as the new last-known copy. */
export async function fetchForecast(spot: Spot, signal?: AbortSignal): Promise<Forecast> {
  const fresh = await fetchFromApi(spot, signal)
  writeCache(spot, fresh)
  return fresh
}
