// Physics score (docs/surf_theory.md): Waves, Shape, Comfort + Safety flags, with reasons.
// A line-by-line copy of jobs/physics.py (same constant names): keep the two in sync.
// `npm run physics-parity` checks this file against the Python one on generated cases.

import type { HourConditions } from '../lib/forecast'

export interface PhysicsSpot {
  beachOrientation: number
  swellWindowMin?: number | null
  swellWindowMax?: number | null
}

export interface Prefs {
  dontMindRain?: boolean
  level?: Level | null
  /** Largest breaking wave the user wants, m. */
  maxWaveM?: number | null
}
export type Level = 'beginner' | 'intermediate' | 'advanced'

export interface Warning {
  kind: 'thunder' | 'water_quality' | 'rip' | 'too_big'
  text: string
  /** Forces the verdict to 1. */
  skip: boolean
  /** The verdict is at most this (too big for your level). */
  cap?: number
}

export interface Features {
  mainPart: 'swell' | 'secondary_swell' | 'wind' | null
  mainHeight: number
  mainPeriod: number
  mainDirection: number | null
  mainAngle: number | null
  mainWindowFactor: number
  breakingHeight: number
  cleanliness: number | null
  conflictPenalty: number
  windSpeed: number | null
  windGusts: number | null
  windRel: number | null
  windOnshore: number | null
  gustRatio: number | null
  windOnshore6h: number | null
  precipitation: number | null
  precipitationProbability: number | null
  weatherCode: number | null
  cape: number | null
  temperature2m: number | null
  seaSurfaceTemperature: number | null
  rain24h: number | null
  rainMax24h72h: number | null
  daylight: boolean | null
}

export interface PhysicsResult {
  waves: number
  shape: number
  overall: number
  comfort: number
  verdict: number
  reason: string
  /** "Secondary swell from the SE is crossing …", or null. */
  mess: string | null
  warnings: Warning[]
  wetsuit: string | null
  /** Comfort causes for the UI: rain / drizzle / cold_air / cold_water. */
  comfortCauses: string[]
  features: Features
}

const G = 9.81
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

// ---- swell window ----
const WINDOW_TAPER_DEG = 15
const WINDOW_LEAK = 0.25
/** Open-Meteo's wave height is ~0.10 m below the buoy (12-month backtest); forecasts only. */
const FORECAST_HEIGHT_BIAS_M = 0.1
const BIAS_FULL_FROM_M = 0.3
const BLOCKED_BELOW = 0.3
const MIN_TRAIN_HEIGHT = 0.05
// ---- waves ----
export const WAVES_STEPS: [number, number][] = [[0.3, 1], [0.45, 2], [0.7, 3], [1.05, 4], [1.6, 5]]
const SHORT_PERIOD_S: [number, number] = [4, 6]
const SHORT_PERIOD_FACTOR = 0.8
const PERIOD_BONUS: [number, number][] = [[5, -0.5], [8, 0.5]]
const SAME_FAMILY_DEG = 30
const CROSSED_DEG = 120
// ---- shape ----
const WIND_BANDS = [5, 12, 20, 30]
const WIND_TABLE: Record<Relation, number[]> = {
  offshore: [5, 5, 4, 2, 1],
  cross: [5, 4, 2.5, 2, 1],
  onshore: [4.5, 3, 2, 1, 1],
}
const OFFSHORE_DEG = 135
const ONSHORE_DEG = 45
const CONFLICT_WEIGHT = 1.5
const CONFLICT_MAX = 2
const CLEAN_RATIO: [number, number] = [0.5, 0.75]
const GUSTY_RATIO = 1.6
const GUSTY_MIN_KMH = 8
const LEFTOVER_ONSHORE_KMH = 20
const MESS_SHOWN_FROM = 0.5
// ---- comfort / safety ----
const RAIN_HEAVY: [number, number] = [60, 1]
const RAIN_LIGHT: [number, number] = [40, 0.1]
const COLD_AIR_C = 10
const COLD_WATER_C = 14
const THUNDER_CODES = new Set([95, 96, 99])
const THUNDER_CAPE = 1000
const POLLUTION_RAIN_MM = 20
const RIP_BREAKING_M = 1.5
const RIP_FRONTAL_DEG = 20
export const LEVEL_MAX_M: Record<Level, number | null> = { beginner: 0.8, intermediate: 1.5, advanced: null }
const TOO_BIG_CAP = 2
const TOO_BIG_SKIP_RATIO = 1.5
const COMFORT_WEIGHT = 0.5

type Relation = 'offshore' | 'cross' | 'onshore'
type Part = 'swell' | 'secondary_swell' | 'wind'
interface Train {
  part: Part
  height: number
  period: number
  direction: number | null
  factor: number
  energy: number
  energyEff: number
}
interface Other extends Train {
  angle: number
  share: number
  weight: number
}
interface Mix {
  main: Train | null
  outside: Train | null
  others: Other[]
  cleanliness: number | null
  conflictPenalty: number
  familyHeight: number
  otherEnergy: number
}

// ---------- small helpers ----------

export const diff = (a: number, b: number) => ((((a - b + 180) % 360) + 360) % 360) - 180
export const compass = (deg: number) => COMPASS[Math.floor((((deg % 360) + 360) % 360 + 11.25) / 22.5) % 16]
export const clamp = (x: number, lo = 1, hi = 5) => Math.max(lo, Math.min(hi, x))
const r2 = (x: number) => Math.round(x * 100) / 100
/** Number for text, halves rounded up (same as fmt in jobs/physics.py), e.g. fmt(10.5) = '11'. */
export const fmt = (x: number, digits = 0) => (Math.floor(x * 10 ** digits + 0.5) / 10 ** digits).toFixed(digits)
/** JS Math.round = round half up, same as the Python round_half_up. */
export const roundHalfUp = (x: number) => Math.floor(x + 0.5)

export function interp(x: number, steps: [number, number][]): number {
  if (x <= steps[0][0]) return steps[0][1]
  for (let i = 0; i + 1 < steps.length; i++) {
    const [x0, y0] = steps[i]
    const [x1, y1] = steps[i + 1]
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
  }
  return steps[steps.length - 1][1]
}

function geometry(spot: PhysicsSpot): [number, number, number] {
  const n = spot.beachOrientation
  if (spot.swellWindowMin == null || spot.swellWindowMax == null) return [n, (n + 270) % 360, (n + 90) % 360]
  return [n, spot.swellWindowMin, spot.swellWindowMax]
}

const mod360 = (x: number) => ((x % 360) + 360) % 360

export function windowFactor(direction: number | null, spot: PhysicsSpot): number {
  if (direction == null) return 1
  const [n, lo, hi] = geometry(spot)
  const cosPart = Math.max(0, Math.cos((diff(direction, n) * Math.PI) / 180))
  const width = mod360(hi - lo)
  const into = mod360(direction - lo)
  if (into > width) return cosPart * WINDOW_LEAK
  const edge = Math.min(into, width - into)
  return cosPart * Math.max(WINDOW_LEAK, Math.min(1, edge / WINDOW_TAPER_DEG))
}

export function komarBreakingHeight(h0: number, period: number): number {
  if (h0 <= 0 || period <= 0) return 0
  const hb = 0.39 * G ** 0.2 * (period * h0 ** 2) ** 0.4
  const [lo, hi] = SHORT_PERIOD_S
  const short = SHORT_PERIOD_FACTOR + (1 - SHORT_PERIOD_FACTOR) * Math.min(1, Math.max(0, (period - lo) / (hi - lo)))
  return hb * short
}

const conflictWeight = (angle: number) => (angle < SAME_FAMILY_DEG ? 0 : angle <= CROSSED_DEG ? 0.5 : 1)

export function windRelation(windFrom: number, normal: number): Relation {
  const a = Math.abs(diff(windFrom, normal))
  return a >= OFFSHORE_DEG ? 'offshore' : a <= ONSHORE_DEG ? 'onshore' : 'cross'
}

function windTableScore(speed: number, rel: Relation): number {
  return WIND_TABLE[rel][WIND_BANDS.filter((b) => speed >= b).length]
}

// ---------- wave trains ----------

// How a train that is NOT the main one is named ('swell' = Open-Meteo's primary partition, which
// isn't the main one when another swell brings more energy into this beach's window).
const TRAIN_NAMES: Record<Part, string> = { swell: 'Another swell', secondary_swell: 'Secondary swell', wind: 'Wind waves' }

function trains(h: HourConditions, spot: PhysicsSpot): Train[] {
  const raw: [Part, number | null | undefined, number | null | undefined, number | null | undefined][] = [
    ['swell', h.swellHeight, h.swellPeriod, h.swellDirection],
    ['secondary_swell', h.secondarySwellHeight, h.secondarySwellPeriod, h.secondarySwellDirection],
    ['wind', h.windWaveHeight, h.windWavePeriod, h.windWaveDirection],
  ]
  const out: Train[] = []
  for (const [part, height, period, dir] of raw) {
    if (height == null || height < MIN_TRAIN_HEIGHT || !period) continue
    const direction = dir ?? null
    const factor = windowFactor(direction, spot)
    const energy = height * height * period
    out.push({ part, height, period, direction, factor, energy, energyEff: energy * factor })
  }
  return out
}

function mix(list: Train[]): Mix {
  const swells = list.filter((t) => t.part !== 'wind')
  let pool = swells.filter((t) => t.energyEff > 0)
  if (!pool.length) pool = list.filter((t) => t.energyEff > 0)
  if (!pool.length) {
    const biggest = list.reduce<Train | null>((b, t) => (!b || t.energy > b.energy ? t : b), null)
    return { main: null, outside: biggest, others: [], cleanliness: null, conflictPenalty: 0, familyHeight: 0, otherEnergy: 0 }
  }
  const main = pool.reduce((b, t) => (t.energyEff > b.energyEff ? t : b))
  const others: Other[] = []
  let familyH2 = main.height ** 2 * main.factor
  let otherE = 0
  let penalty = 0
  for (const t of list) {
    if (t === main || t.energyEff <= 0) continue
    const angle = t.direction != null && main.direction != null ? Math.abs(diff(t.direction, main.direction)) : 0
    const share = t.energyEff / main.energyEff
    const w = conflictWeight(angle)
    if (w === 0) familyH2 += t.height ** 2 * t.factor
    else {
      otherE += t.energyEff
      penalty += share * w
    }
    others.push({ ...t, angle, share, weight: w })
  }
  const total = main.energyEff + otherE
  return {
    main,
    outside: null,
    others,
    cleanliness: total ? main.energyEff / total : null,
    conflictPenalty: penalty,
    familyHeight: Math.sqrt(familyH2),
    otherEnergy: otherE,
  }
}

// ---------- history ----------

export type Series = Map<number, HourConditions>

function windHistory(series: Series, t: number, hours: number, normal: number): number | null {
  const onshore: number[] = []
  for (let k = 1; k <= hours; k++) {
    const r = series.get(t - k * 3600)
    if (!r || r.windSpeed == null || r.windDirection == null) continue
    onshore.push(r.windSpeed * Math.cos((diff(r.windDirection, normal) * Math.PI) / 180))
  }
  if (onshore.length < hours / 2) return null
  return onshore.reduce((a, b) => a + b, 0) / onshore.length
}

function rainSum(series: Series, t: number, hours: number): number | null {
  const vals: number[] = []
  for (let k = 0; k < hours; k++) {
    const v = series.get(t - k * 3600)?.precipitation
    if (v != null) vals.push(v)
  }
  return vals.length >= hours / 2 ? vals.reduce((a, b) => a + b, 0) : null
}

function maxRain24h(series: Series, t: number, back = 72): number | null {
  const sums: number[] = []
  for (let k = 0; k < back - 23; k += 6) {
    const s = rainSum(series, t - k * 3600, 24)
    if (s != null) sums.push(s)
  }
  return sums.length ? Math.max(...sums) : null
}

// ---------- features ----------

export function features(h: HourConditions, spot: PhysicsSpot, series: Series = new Map(), daylight: boolean | null = null): Features {
  // (Always a forecast in the app: FORECAST_HEIGHT_BIAS_M is added.)
  const normal = geometry(spot)[0]
  const m = mix(trains(h, spot))
  const main = m.main
  const ws = h.windSpeed
  const wd = h.windDirection
  const rel = wd != null ? diff(wd, normal) : null
  return {
    mainPart: main ? main.part : null,
    mainHeight: main ? main.height : 0,
    mainPeriod: main ? main.period : 0,
    mainDirection: main ? main.direction : null,
    mainAngle: main && main.direction != null ? diff(main.direction, normal) : null,
    mainWindowFactor: main ? main.factor : 0,
    breakingHeight: komarBreakingHeight(
      main && m.familyHeight > 0
        ? m.familyHeight + FORECAST_HEIGHT_BIAS_M * Math.sqrt(main.factor) * Math.min(1, m.familyHeight / BIAS_FULL_FROM_M)
        : m.familyHeight,
      main ? main.period : 0,
    ),
    cleanliness: m.cleanliness,
    conflictPenalty: m.conflictPenalty,
    windSpeed: ws,
    windGusts: h.windGusts,
    windRel: rel,
    windOnshore: ws != null && rel != null ? ws * Math.cos((rel * Math.PI) / 180) : null,
    gustRatio: h.windGusts != null && ws ? h.windGusts / ws : null,
    windOnshore6h: windHistory(series, h.time, 6, normal),
    precipitation: h.precipitation ?? null,
    precipitationProbability: h.precipProb ?? null,
    weatherCode: h.weatherCode ?? null,
    cape: h.cape ?? null,
    temperature2m: h.airTemp ?? null,
    seaSurfaceTemperature: h.seaTemp ?? null,
    rain24h: rainSum(series, h.time, 24),
    rainMax24h72h: maxRain24h(series, h.time),
    daylight,
  }
}

// ---------- scores ----------

export function wavesScore(f: Features): number {
  if (!f.mainPart || f.breakingHeight <= 0) return 1
  let s = interp(f.breakingHeight, WAVES_STEPS)
  if (s > 1) {
    if (f.mainPeriod < PERIOD_BONUS[0][0]) s += PERIOD_BONUS[0][1]
    else if (f.mainPeriod >= PERIOD_BONUS[1][0]) s += PERIOD_BONUS[1][1]
  }
  return clamp(s)
}

function shapeParts(f: Features): [string, number][] {
  const parts: [string, number][] = []
  if (f.windSpeed != null && f.windRel != null) {
    const a = Math.abs(f.windRel)
    const rel: Relation = a >= OFFSHORE_DEG ? 'offshore' : a <= ONSHORE_DEG ? 'onshore' : 'cross'
    parts.push(['wind', 5 - windTableScore(f.windSpeed, rel)])
    if ((f.gustRatio ?? 0) > GUSTY_RATIO && f.windSpeed >= GUSTY_MIN_KMH) parts.push(['gusts', 0.5])
  }
  if (f.conflictPenalty) parts.push(['crossed', Math.min(CONFLICT_MAX, CONFLICT_WEIGHT * f.conflictPenalty)])
  const c = f.cleanliness
  if (c != null && c <= CLEAN_RATIO[1]) parts.push(['mixed', c < CLEAN_RATIO[0] ? 1 : 0.5])
  const leftover = f.windOnshore6h
  if (leftover != null && leftover >= LEFTOVER_ONSHORE_KMH && (f.windOnshore ?? 0) < 10) parts.push(['leftover', 0.5])
  return parts.filter(([, p]) => p > 0)
}

const messPoints = (f: Features) => shapeParts(f).filter(([k]) => k === 'crossed' || k === 'mixed').reduce((a, [, v]) => a + v, 0)
export const shapeScore = (f: Features) => clamp(5 - shapeParts(f).reduce((a, [, v]) => a + v, 0))
export const overallScore = (waves: number, shape: number) => clamp(1 + (waves - 1) * (0.4 + (0.6 * (shape - 1)) / 4))

function comfortParts(f: Features, mindRain: boolean): [string, number][] {
  const parts: [string, number][] = []
  const prob = f.precipitationProbability
  const mm = f.precipitation
  if (!mindRain && (prob != null || mm != null)) {
    const p = prob ?? 0
    const r = mm ?? 0
    if (p > RAIN_HEAVY[0] && r > RAIN_HEAVY[1]) parts.push(['rain', 2.5])
    else if (r >= RAIN_LIGHT[1] || p > RAIN_LIGHT[0]) parts.push(['drizzle', 1])
  }
  if (f.temperature2m != null && f.temperature2m < COLD_AIR_C) parts.push(['cold_air', 0.5])
  if (f.seaSurfaceTemperature != null && f.seaSurfaceTemperature < COLD_WATER_C) parts.push(['cold_water', 0.5])
  return parts
}

function comfortScore(f: Features, mindRain: boolean): number {
  if (f.daylight === false) return 1
  return clamp(5 - comfortParts(f, mindRain).reduce((a, [, v]) => a + v, 0))
}

export function wetsuit(sst: number | null): string | null {
  if (sst == null) return null
  if (sst < 13) return '5/4 mm + boots'
  if (sst < 16) return '4/3 mm'
  if (sst < 20) return '3/2 mm'
  return 'shorty or none'
}

export function sizeLimit(prefs: Prefs | null | undefined): number | null {
  if (!prefs) return null
  const limits = [prefs.level ? LEVEL_MAX_M[prefs.level] : null, prefs.maxWaveM ?? null].filter((v): v is number => v != null)
  return limits.length ? Math.min(...limits) : null
}

function safety(f: Features, prefs?: Prefs | null): Warning[] {
  const out: Warning[] = []
  const rainy = (f.precipitation ?? 0) >= 0.5 || (f.precipitationProbability ?? 0) >= 60
  if ((f.weatherCode != null && THUNDER_CODES.has(Math.round(f.weatherCode))) || ((f.cape ?? 0) >= THUNDER_CAPE && rainy)) {
    out.push({ kind: 'thunder', skip: true, text: 'Thunderstorm risk: lightning, stay out of the water' })
  }
  if ((f.rainMax24h72h ?? 0) >= POLLUTION_RAIN_MM) {
    out.push({
      kind: 'water_quality',
      skip: false,
      text: `${fmt(f.rainMax24h72h!, 0)} mm of rain in a day recently: water near drains and river mouths may be polluted for 2-3 days`,
    })
  }
  const hb = f.breakingHeight
  if (hb >= RIP_BREAKING_M && f.mainAngle != null && Math.abs(f.mainAngle) < RIP_FRONTAL_DEG) {
    out.push({ kind: 'rip', skip: false, text: 'Big waves straight onto the beach: strong rip currents likely' })
  }
  const limit = sizeLimit(prefs)
  if (limit != null && hb > limit) {
    out.push({ kind: 'too_big', skip: false, cap: hb > TOO_BIG_SKIP_RATIO * limit ? 1 : TOO_BIG_CAP, text: `Waves around ${fmt(hb, 1)} m: above your limit of ${fmt(limit, 1)} m` })
  }
  return out
}

// ---------- reason text ----------

function windWords(f: Features): string {
  const ws = f.windSpeed
  const rel = f.windRel
  if (ws == null || rel == null) return 'wind unknown'
  const a = Math.abs(rel)
  const kind = a >= OFFSHORE_DEG ? 'offshore' : a <= ONSHORE_DEG ? 'onshore' : 'cross-shore'
  if (ws < 5) return 'no wind'
  if (ws < 12) return `light ${kind}`
  return `${fmt(ws, 0)} km/h ${kind}`
}

export function messText(h: HourConditions, spot: PhysicsSpot): string | null {
  const m = mix(trains(h, spot))
  if (!m.main || m.main.direction == null) return null
  const worst = m.others
    .filter((o) => o.weight > 0)
    .reduce<Other | null>((b, o) => (!b || o.share * o.weight > b.share * b.weight ? o : b), null)
  if (!worst || worst.share * worst.weight < 0.15) return null
  const mainDir = compass(m.main.direction)
  const what = TRAIN_NAMES[worst.part]
  const from = worst.direction != null ? compass(worst.direction) : 'another direction'
  if (worst.weight >= 1) return `${what} from the ${from} is running against the main ${mainDir} swell: bumpy faces, sets break unpredictably`
  if (worst.part === 'wind') return `Wind waves from the ${from} on top of the ${mainDir} swell: choppy surface`
  return `${what} from the ${from} is crossing the main ${mainDir} swell at ${fmt(worst.angle, 0)}°: peaky and inconsistent`
}

function reason(f: Features, h: HourConditions, spot: PhysicsSpot, flags: Warning[], comfort: [string, number][], waves: number, shape: number): string {
  if (flags.some((x) => x.kind === 'thunder')) return 'Thunderstorm risk: don’t go in the water'
  if (f.daylight === false) return 'After dark'
  if (!f.mainPart) {
    const out = mix(trains(h, spot)).outside
    if (out && out.height >= 0.3 && out.direction != null) {
      return `${fmt(out.height, 1)} m from the ${compass(out.direction)}, but it can’t reach this beach`
    }
    return 'Flat'
  }
  let size = `${fmt(f.breakingHeight, 1)} m at ${fmt(f.mainPeriod, 0)} s from the ${compass(f.mainDirection ?? 0)}`
  if (f.mainWindowFactor < BLOCKED_BELOW) size += ' (mostly blocked here)'
  let text: string
  if (overallScore(waves, shape) < 1.5) text = `Too small: ${size}`
  else {
    const parts = shapeParts(f)
    const worst = parts.reduce<[string, number] | null>((b, p) => (!b || p[1] > b[1] ? p : b), null)
    const clean = shape >= 4.5 ? 'Clean' : shape >= 3.5 ? 'Fairly clean' : shape >= 2.5 ? 'Bumpy' : 'Messy'
    text = `${clean} ${size}, ${windWords(f)}`
    if (worst?.[0] === 'leftover') text += ', still choppy from the earlier onshore wind'
    else if ((worst?.[0] === 'crossed' || worst?.[0] === 'mixed') && worst[1] >= 0.5) text += ', other swells mixing in'
    else if (worst?.[0] === 'gusts') text += ', gusty'
  }
  const causes = comfort.map(([k]) => k)
  const prob = f.precipitationProbability
  if (causes.includes('rain') || causes.includes('drizzle')) text += prob ? `, but ${fmt(prob, 0)}% chance of rain` : ', but some rain'
  return text
}

// ---------- entry points ----------

export function evaluate(h: HourConditions, spot: PhysicsSpot, series?: Series, daylight: boolean | null = null, prefs?: Prefs | null): PhysicsResult {
  const f = features(h, spot, series, daylight)
  const waves = wavesScore(f)
  const shape = shapeScore(f)
  const overall = overallScore(waves, shape)
  const mindRain = !!prefs?.dontMindRain
  const cparts = comfortParts(f, mindRain)
  const comfort = comfortScore(f, mindRain)
  const flags = safety(f, prefs)
  let verdict = clamp(overall - COMFORT_WEIGHT * (5 - comfort))
  for (const x of flags) verdict = Math.min(verdict, x.cap ?? 5)
  if (f.daylight === false || flags.some((x) => x.skip)) verdict = 1
  return {
    waves: r2(waves),
    shape: r2(shape),
    overall: r2(overall),
    comfort: r2(comfort),
    verdict: r2(verdict),
    reason: reason(f, h, spot, flags, cparts, waves, shape),
    mess: waves >= 1.5 && messPoints(f) >= MESS_SHOWN_FROM ? messText(h, spot) : null,
    warnings: flags,
    wetsuit: wetsuit(f.seaSurfaceTemperature),
    comfortCauses: cparts.map(([k]) => k),
    features: f,
  }
}

/** Verdict for an overall wave score (physics or AI) with this hour's comfort + safety. */
export function verdictFrom(overall: number, p: PhysicsResult): number {
  if (p.features.daylight === false || p.warnings.some((w) => w.skip)) return 1
  let v = clamp(overall - COMFORT_WEIGHT * (5 - p.comfort))
  for (const w of p.warnings) v = Math.min(v, w.cap ?? 5)
  return v
}

export function seriesOf(hours: Iterable<HourConditions>): Series {
  const s: Series = new Map()
  for (const h of hours) s.set(h.time, h)
  return s
}
