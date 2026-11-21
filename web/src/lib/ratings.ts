// Community ratings: "how was it really?" Each rating is the ground truth the nightly model
// trains on, so it is stored with a copy of exactly what the app showed for that hour.

import { hh, localDate } from './format'
import type { Forecast, HourConditions } from './openMeteo'
import type { Spot } from './spot'
import { insertRow } from './supabase'
import type { Score } from '../scoring/types'

// ---------- when ----------

export type SlotId = 'morning' | 'midday' | 'afternoon' | 'evening'
export type DayId = 'today' | 'yesterday'

/** Local hours at the spot. `start` decides whether a slot can be picked yet; `hour` is the hour stored. */
export const SLOTS: { id: SlotId; label: string; start: number; hour: number }[] = [
  { id: 'morning', label: 'Morning', start: 6, hour: 9 },
  { id: 'midday', label: 'Midday', start: 11, hour: 12 },
  { id: 'afternoon', label: 'Afternoon', start: 14, hour: 16 },
  { id: 'evening', label: 'Evening', start: 18, hour: 19 },
]

export interface WhenOption {
  day: DayId
  slot: SlotId
  label: string
  /** Unix seconds (UTC) stored as surfed_at; never in the future. */
  surfedAt: number
  /** Forecast hour the rating is compared against; null when the forecast doesn't cover it. */
  hour: HourConditions | null
  available: boolean
}

/** The 8 day/slot choices. Slots that haven't started yet today are unavailable. */
export function whenOptions(forecast: Forecast, now: number): WhenOption[] {
  const tz = forecast.timezone
  const today = localDate(now, tz)
  const idx = forecast.days.findIndex((d) => d.date === today)
  const out: WhenOption[] = []
  for (const [day, offset] of [['today', 0], ['yesterday', -1]] as const) {
    const d = idx >= 0 ? forecast.days[idx + offset] : undefined
    for (const s of SLOTS) {
      const at = (h: number) => d?.hours.find((x) => Number(hh(x.time, tz)) === h)
      const start = at(s.start)
      const rep = at(s.hour)
      const available = !!start && !!rep && start.time <= now
      const surfedAt = rep ? Math.min(rep.time, now) : now
      // Compare against the hour the session was in (the current hour if it's still going on).
      const hour =
        rep && surfedAt < rep.time ? (d?.hours.find((x) => surfedAt >= x.time && surfedAt < x.time + 3600) ?? rep) : (rep ?? null)
      out.push({ day, slot: s.id, label: s.label, surfedAt, hour, available: available && hour != null })
    }
  }
  return out
}

// ---------- answers ----------

export const WAVE_SIZES = [
  { id: 'flat', label: 'Flat' },
  { id: 'knee', label: 'Knee' },
  { id: 'waist', label: 'Waist' },
  { id: 'chest', label: 'Chest' },
  { id: 'head', label: 'Head' },
  { id: 'overhead', label: 'Overhead' },
] as const

// The database uses glassy/clean/choppy/messy; the app offers three plain choices.
export const SURFACES = [
  { id: 'glassy', label: 'Glassy' },
  { id: 'choppy', label: 'A bit choppy' },
  { id: 'messy', label: 'Blown out' },
] as const

export const CROWDS = [
  { id: 'empty', label: 'Empty' },
  { id: 'few', label: 'A few' },
  { id: 'busy', label: 'Busy' },
  { id: 'packed', label: 'Packed' },
] as const

export type WaveSize = (typeof WAVE_SIZES)[number]['id']
export type Surface = (typeof SURFACES)[number]['id']
export type Crowd = (typeof CROWDS)[number]['id']

export const COMMENT_MAX = 280 // the database allows 500

export interface RatingInput {
  when: WhenOption
  overall: 1 | 2 | 3 | 4 | 5
  waveSize: WaveSize | null
  surface: Surface | null
  crowd: Crowd | null
  comment: string
  /** true only when the device checked it was within 3 km; otherwise left empty. */
  nearBeach: true | null
}

/** Answers that contradict each other (the database rejects them too: ratings_flat_not_good). */
export function contradiction(waveSize: WaveSize | null, overall: number | null): string | null {
  if (waveSize === 'flat' && overall != null && overall >= 3) {
    return 'Flat waves and a 3 or more don’t go together. Change the wave size or the score.'
  }
  return null
}

// ---------- 3 per device per day ----------
// The database enforces this (trigger ratings_rate_limit, rolling 24 h). The local log only
// lets the app say so before you fill in the form.

export const MAX_PER_DAY = 3
const DAY_MS = 24 * 60 * 60 * 1000
const LOG_KEY = 'surf:rating-log'

function readLog(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is number => typeof x === 'number') : []
  } catch {
    return []
  }
}

/** Send times (unix ms) in the last 24 hours, oldest first. */
export function recentSends(nowMs: number): number[] {
  return readLog()
    .filter((t) => nowMs - t < DAY_MS)
    .sort((a, b) => a - b)
}

/** When the next rating is allowed (unix ms), or null if one is allowed now. */
export function nextAllowedAt(nowMs: number): number | null {
  const recent = recentSends(nowMs)
  return recent.length >= MAX_PER_DAY ? recent[recent.length - MAX_PER_DAY] + DAY_MS : null
}

function logSend(nowMs: number) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify([...recentSends(nowMs), nowMs]))
  } catch {
    /* storage blocked: the database still enforces the limit */
  }
}

export type RatingErrorKind = 'limit' | 'contradiction' | 'too_old' | 'other'

export class RatingError extends Error {
  readonly kind: RatingErrorKind
  constructor(kind: RatingErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

/** Turns a database refusal into something a surfer can act on. */
function explain(raw: string): RatingError {
  if (raw.includes('rate_limit')) {
    return new RatingError('limit', 'You’ve already sent 3 ratings in the last 24 hours. Thanks! Try again tomorrow.')
  }
  if (raw.includes('ratings_flat_not_good')) {
    return new RatingError('contradiction', 'Flat waves and a 3 or more don’t go together.')
  }
  if (raw.includes('took too long')) {
    return new RatingError(
      'other',
      'The connection is too slow right now. Your rating may not have been saved; send it again when you have a better signal.',
    )
  }
  if (raw.includes('row-level security')) {
    return new RatingError('too_old', 'Only sessions from today or yesterday can be rated.')
  }
  return new RatingError('other', `Couldn’t save your rating (${raw}). Check your connection and send again.`)
}

// ---------- device id + version ----------

const DEVICE_KEY = 'surf:device-id'
let sessionDeviceId: string | null = null

/** crypto.randomUUID needs HTTPS and iOS 15.4+; getRandomValues works everywhere (32 hex chars). */
function randomId(): string {
  if (typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID()
    } catch {
      /* not allowed here (plain http): fall through */
    }
  }
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Random id kept on this device. Not linked to any account; lets training spot repeat raters. */
export function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY)
    if (existing) return existing
    const id = randomId()
    localStorage.setItem(DEVICE_KEY, id)
    return id
  } catch {
    // Storage blocked (private mode): one id for this visit.
    sessionDeviceId ??= randomId()
    return sessionDeviceId
  }
}

/** The saved device id, or null if this device hasn't rated yet. */
export function storedDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY)
  } catch {
    return sessionDeviceId
  }
}

/** Drops the device id; the next rating creates a new one. */
export function forgetDeviceId() {
  try {
    localStorage.removeItem(DEVICE_KEY)
  } catch {
    /* nothing stored */
  }
  sessionDeviceId = null
}

export const APP_VERSION = __APP_VERSION__

// ---------- save ----------

const iso = (unix: number) => new Date(unix * 1000).toISOString()

/** The forecast numbers and score the app showed for that hour. Kept well under the 16 KB cap. */
function forecastShown(spot: Spot, forecast: Forecast, hour: HourConditions, score: Score) {
  return {
    valid_at: iso(hour.time),
    fetched_at: new Date(forecast.fetchedAt).toISOString(),
    // true when the hour was already over when the numbers were fetched (e.g. "yesterday"):
    // then these are Open-Meteo's latest numbers for that hour, not a forecast seen in advance.
    past_at_fetch: hour.time + 3600 <= forecast.fetchedAt / 1000,
    timezone: forecast.timezone,
    marine_model: forecast.marineModel,
    beach_orientation: spot.beachOrientation,
    conditions: {
      wave_height: hour.waveHeight,
      wave_period: hour.wavePeriod,
      wave_direction: hour.waveDirection,
      swell_wave_height: hour.swellHeight,
      swell_wave_period: hour.swellPeriod,
      swell_wave_direction: hour.swellDirection,
      wind_speed: hour.windSpeed,
      wind_direction: hour.windDirection,
      wind_gusts: hour.windGusts,
      sea_level_height: hour.tide,
      is_day: hour.isDay,
    },
    score: {
      value: score.value,
      label: score.label,
      reason: score.reason,
      source: score.source,
      model_version: score.modelVersion ?? null,
    },
  }
}

export async function saveRating(spot: Spot, forecast: Forecast, score: Score, r: RatingInput): Promise<void> {
  const comment = r.comment.trim().slice(0, COMMENT_MAX)
  if (!r.when.hour) throw new RatingError('other', 'There’s no forecast for that time.')
  const clash = contradiction(r.waveSize, r.overall)
  if (clash) throw new RatingError('contradiction', clash)
  const row = {
    spot_id: spot.id,
    surfed_at: iso(r.when.surfedAt),
    overall: r.overall,
    wave_size: r.waveSize,
    surface: r.surface,
    crowd: r.crowd,
    comment: comment || null,
    source: 'community',
    device_id: deviceId(),
    forecast_shown: forecastShown(spot, forecast, r.when.hour, score),
    app_version: APP_VERSION,
    near_beach: r.nearBeach,
  }
  try {
    await insertRow('ratings', row)
  } catch (err) {
    throw explain(err instanceof Error ? err.message : String(err))
  }
  logSend(Date.now())
}
