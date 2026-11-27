// The forecast for one spot, from our own file (never from Open-Meteo directly).
// The hourly job (jobs/collect_forecast.py) asks Open-Meteo once per spot and publishes a compact
// file; /api/forecast serves it through Vercel's CDN. The UI must still credit
// "Weather data by Open-Meteo.com" (non-commercial use).
// The last answer is kept in localStorage: reused for 15 minutes, and shown when offline.

import type { SpotExtras } from './extras'
import type { Spot } from './spot'

import { CACHE_TTL_MS, FETCHED_AT_KEY, FILE_VERSION, OLD_AFTER_MS, forecastUrl } from './forecastRequest'
import { FORECAST_TIMEOUT_MS, untilAbort, withTimeout } from './http'

const CACHE_VERSION = 5 // bump when the cached shape or request changes
/** Spots whose full forecast stays saved on the phone (opens offline). */
const MAX_SAVED_SPOTS = 6
/** Today + the next 3 days (the file has one more, so a late file still covers them). */
const SHOWN_DAYS = 4

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
  // Optional: copies saved by older versions don't have them (treated as unknown).
  secondarySwellHeight?: number | null
  secondarySwellPeriod?: number | null
  secondarySwellDirection?: number | null
  windWaveHeight?: number | null
  windWavePeriod?: number | null
  windWaveDirection?: number | null
  seaTemp?: number | null // °C
  precipitation?: number | null // mm in the preceding hour
  precipProb?: number | null // %
  weatherCode?: number | null // WMO; 95/96/99 = thunderstorm
  cape?: number | null // J/kg
  airTemp?: number | null // °C
}

export interface ForecastDay {
  /** Local date at the spot, YYYY-MM-DD. */
  date: string
  sunrise: number | null // unix s
  sunset: number | null
  hours: HourConditions[]
}

/** Days include the last 14 (ratings, chart); the forecast UI starts at today. */
export interface Forecast {
  spotId: string
  /** Unix ms when the job asked Open-Meteo (what "Updated HH:MM" shows). */
  fetchedAt: number
  /** Unix ms when this phone downloaded the file (decides when to ask again). Missing in old copies. */
  checkedAt?: number
  /** IANA time zone of the spot, used only for display. */
  timezone: string
  marineModel: string
  days: ForecastDay[]
}

// ---------- the file (columns of numbers; see jobs/collect_forecast.py build_file) ----------

type Column = (number | null)[]
/** One spot's hours as published by the job: `hours` hourly values from `start` (unix s). */
export interface FilePart {
  fetchedAt: string
  timezone: string
  marineModel: string
  start: number
  hours: number
  hourly: Record<string, Column>
}
interface SpotFile extends FilePart {
  v: number
  spotId: string
  daily: { date: string[]; sunrise: (number | null)[]; sunset: (number | null)[] }
  /** The page's other public data (web/api/forecast.ts); missing from older servers. */
  extras?: SpotExtras
}

const NUMBER_FIELDS = [
  'waveHeight', 'wavePeriod', 'waveDirection', 'swellHeight', 'swellPeriod', 'swellDirection',
  'windSpeed', 'windDirection', 'windGusts', 'tide',
  'secondarySwellHeight', 'secondarySwellPeriod', 'secondarySwellDirection',
  'windWaveHeight', 'windWavePeriod', 'windWaveDirection',
  'seaTemp', 'precipitation', 'precipProb', 'weatherCode', 'cape', 'airTemp',
] as const

/** The file's columns -> one HourConditions per hour. */
export function decodeHours(part: FilePart): HourConditions[] {
  const out: HourConditions[] = []
  for (let i = 0; i < part.hours; i++) {
    const h = { time: part.start + i * 3600 } as HourConditions
    for (const k of NUMBER_FIELDS) h[k] = part.hourly[k]?.[i] ?? null
    const day = part.hourly.isDay?.[i]
    h.isDay = day == null ? true : day === 1
    out.push(h)
  }
  return out
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

/** GET one of our forecast files (JSON), with a time limit. */
export async function getForecastFile<T>(url: string, outer?: AbortSignal, prefetched = false): Promise<T> {
  return withTimeout(outer, FORECAST_TIMEOUT_MS, 'The forecast', async (signal) => {
    // A prefetch started by index.html can't be cancelled, so stop waiting for it on timeout.
    const early = prefetched ? takePrefetched(url) : undefined
    const res = (early && (await untilAbort(early, signal))) || (await fetch(url, { signal }))
    if (!res.ok) {
      let reason = ''
      try {
        reason = ((await res.json()) as { error?: string }).error ?? ''
      } catch {
        /* body was not JSON */
      }
      throw new Error(`Forecast: HTTP ${res.status} ${reason}`.trim())
    }
    const body = (await res.json()) as T & { v?: number }
    if (body.v !== FILE_VERSION) throw new Error('The forecast file is in a newer format: reload the app.')
    return body
  })
}

async function fetchFromServer(spotId: string, signal?: AbortSignal): Promise<{ forecast: Forecast; extras: SpotExtras }> {
  const file = await getForecastFile<SpotFile>(forecastUrl(spotId), signal, true)
  const hours = decodeHours(file)
  const timezone = file.timezone || 'UTC'
  const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const localDate = (unix: number) => dateFmt.format(unix * 1000)
  const sun = new Map(file.daily.date.map((d, i) => [d, { sunrise: file.daily.sunrise[i] ?? null, sunset: file.daily.sunset[i] ?? null }]))

  const days: ForecastDay[] = []
  for (const h of hours) {
    const date = localDate(h.time)
    let day = days[days.length - 1]
    if (!day || day.date !== date) {
      day = { date, sunrise: sun.get(date)?.sunrise ?? null, sunset: sun.get(date)?.sunset ?? null, hours: [] }
      days.push(day)
    }
    day.hours.push(h)
  }
  // Up to today + 3 days (the file's 5th day is only there in case the job runs late).
  const today = localDate(Date.now() / 1000)
  const first = days.findIndex((d) => d.date >= today)
  const shown = first < 0 ? days : days.slice(0, first + SHOWN_DAYS)

  const forecast: Forecast = {
    spotId,
    fetchedAt: Date.parse(file.fetchedAt) || Date.now(),
    checkedAt: Date.now(),
    timezone,
    marineModel: file.marineModel,
    days: shown,
  }
  return { forecast, extras: file.extras ?? {} }
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
    // At most MAX_SAVED_SPOTS forecasts (each is tens of KB): a full storage would also stop
    // the device id and the rating limit from being saved. Oldest fetch goes first.
    const saved = Object.keys(localStorage).filter((k) => k.startsWith(current) && k !== cacheKey(spot))
    if (saved.length >= MAX_SAVED_SPOTS) {
      const age = (k: string) => Number(localStorage.getItem(`${FETCHED_AT_KEY}:${k.slice(current.length).split(':')[0]}`) || 0)
      saved.sort((a, b) => age(a) - age(b))
      for (const k of saved.slice(0, saved.length - MAX_SAVED_SPOTS + 1)) localStorage.removeItem(k)
    }
    localStorage.setItem(cacheKey(spot), JSON.stringify(f))
    // Small companion key: lets index.html decide whether to prefetch without parsing the forecast.
    localStorage.setItem(`${FETCHED_AT_KEY}:${spot.id}`, String(f.checkedAt ?? f.fetchedAt))
    localStorage.removeItem(FETCHED_AT_KEY) // the single-spot key used up to 0.3.0
  } catch {
    /* storage full or blocked: the app still works, just without a cache */
  }
}

/** Downloaded less than 15 minutes ago: no need to ask again. */
export function isFresh(f: Forecast): boolean {
  return Date.now() - (f.checkedAt ?? f.fetchedAt) < CACHE_TTL_MS
}

/** The job last asked Open-Meteo hours ago (it runs hourly when GitHub runs it on time). */
export function isOld(f: Forecast): boolean {
  return Date.now() - f.fetchedAt > OLD_AFTER_MS
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

/** Downloads the spot's file: the forecast + the page's other public data (`extras`). Not saved
 *  yet: the caller saves it with saveForecast once it knows the spot (the extras may carry it). */
export function downloadForecast(spotId: string, signal?: AbortSignal): Promise<{ forecast: Forecast; extras: SpotExtras }> {
  return fetchFromServer(spotId, signal)
}

/** Saves a downloaded forecast as the spot's new last-known copy. */
export function saveForecast(spot: Spot, f: Forecast): void {
  writeCache(spot, f)
}
