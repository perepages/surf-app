import { useCallback, useEffect, useRef, useState } from 'react'
import { CACHE_TTL_MS } from './lib/forecastRequest'
import { readLastGood, writeLastGood } from './lib/lastGood'
import { publishExtras } from './lib/extras'
import { downloadForecast, isFresh, isOld, readCachedForecast, saveForecast, type Forecast } from './lib/forecast'
import { aiFromRows, getAiPredictions, type AiPrediction } from './lib/predictions'
import { FALLBACK_SPOTS, loadSpot, spotFromRow, type Spot, type SpotRow } from './lib/spot'

export type SpotForecastState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      spot: Spot
      forecast: Forecast
      ai: Map<number, AiPrediction>
      /** Not re-downloaded in 15 min (a newer copy couldn't be fetched yet), or the job
       *  hasn't published a new forecast for hours. */
      stale: boolean
      /** A newer copy is being fetched in the background. */
      refreshing: boolean
    }

const CHECK_EVERY_MS = 5 * 60 * 1000
const DAY_S = 24 * 3600

// Reusing the same object when nothing changed lets memoised sections skip re-rendering.
const sameSpot = (a: Spot, b: Spot) =>
  a.id === b.id &&
  a.name === b.name &&
  a.lat === b.lat &&
  a.lon === b.lon &&
  a.beachOrientation === b.beachOrientation &&
  a.swellWindowMin === b.swellWindowMin &&
  a.swellWindowMax === b.swellWindowMax
function sameAi(a: Map<number, AiPrediction>, b: Map<number, AiPrediction>) {
  if (a.size !== b.size) return false
  for (const [k, v] of a) {
    const w = b.get(k)
    if (!w || w.aiScore !== v.aiScore || w.aiWaves !== v.aiWaves || w.aiShape !== v.aiShape || w.reason !== v.reason || w.modelVersion !== v.modelVersion) return false
  }
  return true
}

/**
 * Shows the last saved data at once (instant start, works offline), then refreshes spot,
 * forecast and AI scores in parallel and swaps them in. Nothing waits on anything else unless
 * it has to (a new forecast only waits for the spot if no coordinates are known yet).
 */
/** What's saved on this phone, read synchronously so the very first render already shows it. */
function savedState(spotId: string): SpotForecastState {
  const spot = readLastGood<Spot>(`spot:${spotId}`) ?? FALLBACK_SPOTS[spotId] ?? null
  const forecast = spot ? readCachedForecast(spot) : null
  if (!spot || !forecast) return { status: 'loading' }
  const ai = new Map(readLastGood<[number, AiPrediction][]>(`ai:${spotId}`) ?? [])
  const due = !isFresh(forecast)
  return { status: 'ready', spot, forecast, ai, stale: due || isOld(forecast), refreshing: due }
}

export function useSpotForecast(spotId: string) {
  const [state, setState] = useState<SpotForecastState>(() => savedState(spotId))
  const controller = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    controller.current?.abort()
    const ac = new AbortController()
    controller.current = ac
    const { signal } = ac

    // 1. Start from what's saved (already on screen via the initial state, or after a retry).
    const saved = savedState(spotId)
    const knownSpot = saved.status === 'ready' ? saved.spot : (readLastGood<Spot>(`spot:${spotId}`) ?? FALLBACK_SPOTS[spotId] ?? null)
    const cached = saved.status === 'ready' ? saved.forecast : null
    const cachedAi = saved.status === 'ready' ? saved.ai : new Map<number, AiPrediction>()
    const needsForecast = !cached || !isFresh(cached)

    // 2. The saved forecast is fresh: nothing to download (spot + AI scores were saved with it).
    if (!needsForecast && cached && knownSpot) {
      setState((prev) => (prev.status === 'ready' ? prev : { status: 'ready', spot: knownSpot, forecast: cached, ai: cachedAi, stale: isOld(cached), refreshing: false }))
      return
    }

    // 3. One download: the forecast + the page's other public data (extras). The spot row and AI
    //    scores come from the extras; only a part that's missing is read from Supabase directly.
    const nowS = Date.now() / 1000
    let downloaded: Awaited<ReturnType<typeof downloadForecast>> | null = null
    let downloadError: unknown = null
    try {
      downloaded = await downloadForecast(spotId, signal)
    } catch (err) {
      if (signal.aborted) return
      downloadError = err
    }
    if (signal.aborted) return
    const extras = downloaded?.extras ?? {}

    const spotRow = extras.spot as SpotRow | null | undefined
    let spot: Spot | null = spotRow ? spotFromRow(spotRow) : null
    const aiP: Promise<Map<number, AiPrediction> | null> = Array.isArray(extras.ai)
      ? Promise.resolve(aiFromRows(extras.ai))
      : getAiPredictions(spotId, nowS - 15 * DAY_S, nowS + 5 * DAY_S, signal)
    if (!spot) spot = await loadSpot(spotId, signal).catch(() => knownSpot)
    const loadedAi = await aiP
    if (signal.aborted) return
    if (spot) writeLastGood(`spot:${spotId}`, spot)
    if (loadedAi) writeLastGood(`ai:${spotId}`, [...loadedAi])
    if (downloaded && spot) saveForecast(spot, downloaded.forecast)
    // Reports and model info pick their parts up from here (lib/extras.ts).
    if (downloaded) publishExtras(spotId, extras)

    const sameAsKnown = spot && knownSpot && sameSpot(spot, knownSpot)
    const finalSpot = sameAsKnown ? knownSpot : spot
    const forecast = downloaded?.forecast ?? cached
    const ai = loadedAi && !sameAi(loadedAi, cachedAi) ? loadedAi : cachedAi

    if (finalSpot && forecast) {
      const stale = !isFresh(forecast) || isOld(forecast)
      setState((prev) =>
        prev.status === 'ready' && prev.spot === finalSpot && prev.forecast === forecast && prev.ai === ai && prev.stale === stale && !prev.refreshing
          ? prev // nothing new: no re-render
          : { status: 'ready', spot: finalSpot, forecast, ai, stale, refreshing: false },
      )
    } else {
      setState({
        status: 'error',
        message: !navigator.onLine
          ? 'You’re offline and there’s no saved forecast on this phone yet.'
          : downloadError instanceof Error
            ? downloadError.message
            : String(downloadError ?? 'This spot couldn’t be loaded.'),
      })
    }
  }, [spotId])

  useEffect(() => {
    void load()
    return () => controller.current?.abort()
  }, [load])

  // Back online, back to the app after a while, or left open on screen: download again once
  // the saved copy is older than 15 minutes (checked every 5 minutes while visible).
  const current = state.status === 'ready' ? state.forecast : null
  const fetchedAt = current ? (current.checkedAt ?? current.fetchedAt) : 0
  useEffect(() => {
    const refreshIfOld = () => {
      if (document.visibilityState === 'visible' && Date.now() - fetchedAt > CACHE_TTL_MS) void load()
    }
    const onOnline = () => void load()
    document.addEventListener('visibilitychange', refreshIfOld)
    window.addEventListener('online', onOnline)
    const timer = setInterval(refreshIfOld, CHECK_EVERY_MS)
    return () => {
      document.removeEventListener('visibilitychange', refreshIfOld)
      window.removeEventListener('online', onOnline)
      clearInterval(timer)
    }
  }, [fetchedAt, load])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    void load()
  }, [load])

  return { state, retry }
}

/** True while the browser says it has a network connection. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}

/** Current time in unix seconds, updated every minute. */
export function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}
