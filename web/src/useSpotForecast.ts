import { useCallback, useEffect, useRef, useState } from 'react'
import { readLastGood, writeLastGood } from './lib/lastGood'
import { fetchForecast, isFresh, readCachedForecast, type Forecast } from './lib/openMeteo'
import { getAiPredictions, type AiPrediction } from './lib/predictions'
import { FALLBACK_SPOTS, loadSpot, type Spot } from './lib/spot'

export type SpotForecastState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      spot: Spot
      forecast: Forecast
      ai: Map<number, AiPrediction>
      /** Older than 30 min and a newer copy couldn't be fetched (yet). */
      stale: boolean
      /** A newer copy is being fetched in the background. */
      refreshing: boolean
    }

const REFRESH_AFTER_MS = 30 * 60 * 1000
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
  const stale = !isFresh(forecast)
  return { status: 'ready', spot, forecast, ai, stale, refreshing: stale }
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

    // 2. Refresh everything in parallel.
    const nowS = Date.now() / 1000
    const spotP = loadSpot(spotId, signal).then((s) => {
      writeLastGood(`spot:${spotId}`, s)
      return s
    })
    const aiP = getAiPredictions(spotId, nowS - 15 * DAY_S, nowS + 5 * DAY_S, signal).then((m) => {
      if (m) writeLastGood(`ai:${spotId}`, [...m])
      return m
    })
    const forecastP = (async () => {
      if (!needsForecast && cached) return cached
      const first = knownSpot ?? (await spotP)
      return fetchForecast(first, signal)
    })()

    // First visit (nothing saved): show the forecast the moment it arrives; the AI scores and
    // the spot from the database follow without holding up the first screen.
    if (!cached && knownSpot) {
      forecastP
        .then((f) => {
          if (signal.aborted) return
          setState((prev) =>
            prev.status === 'ready' ? prev : { status: 'ready', spot: knownSpot, forecast: f, ai: cachedAi, stale: false, refreshing: false },
          )
        })
        .catch(() => {})
    }

    const [spotR, aiR, forecastR] = await Promise.allSettled([spotP, aiP, forecastP])
    if (signal.aborted) return

    const loadedSpot = spotR.status === 'fulfilled' ? spotR.value : knownSpot
    const spot = loadedSpot && knownSpot && sameSpot(loadedSpot, knownSpot) ? knownSpot : loadedSpot
    let forecast = forecastR.status === 'fulfilled' ? forecastR.value : cached
    // The database moved the spot: the forecast must be for the new coordinates.
    if (spot && knownSpot && forecast && (spot.lat !== knownSpot.lat || spot.lon !== knownSpot.lon)) {
      forecast = await fetchForecast(spot, signal).catch(() => forecast)
      if (signal.aborted) return
    }
    const loadedAi = aiR.status === 'fulfilled' && aiR.value ? aiR.value : cachedAi
    const ai = sameAi(loadedAi, cachedAi) ? cachedAi : loadedAi

    if (spot && forecast) {
      const stale = !isFresh(forecast)
      setState((prev) =>
        prev.status === 'ready' && prev.spot === spot && prev.forecast === forecast && prev.ai === ai && prev.stale === stale && !prev.refreshing
          ? prev // nothing new: no re-render
          : { status: 'ready', spot, forecast, ai, stale, refreshing: false },
      )
    } else {
      const reason = forecastR.status === 'rejected' ? forecastR.reason : spotR.status === 'rejected' ? spotR.reason : null
      setState({
        status: 'error',
        message: !navigator.onLine
          ? 'You’re offline and there’s no saved forecast on this phone yet.'
          : reason instanceof Error
            ? reason.message
            : String(reason),
      })
    }
  }, [spotId])

  useEffect(() => {
    void load()
    return () => controller.current?.abort()
  }, [load])

  // Back online, back to the app after a while, or left open on screen: refresh once the
  // forecast is older than 30 minutes (checked every 5 minutes while visible).
  const fetchedAt = state.status === 'ready' ? state.forecast.fetchedAt : 0
  useEffect(() => {
    const refreshIfOld = () => {
      if (document.visibilityState === 'visible' && Date.now() - fetchedAt > REFRESH_AFTER_MS) void load()
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
