import { LazyMotion, MotionConfig } from 'framer-motion'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { NextDays, TodayCard } from './components/DayPlan'
import { ErrorBoundary, SectionFailed } from './components/ErrorBoundary'
import { TodayReports } from './components/TodayReports'
import { buildChartRows } from './lib/chartData'
import { CHART_DAYS, useReports, type ReportsState } from './lib/reports'
import { learnedFrom, useModelInfo, type ModelInfo } from './lib/modelInfo'
import { Verdict } from './components/Verdict'
import { hhmm, localDate } from './lib/format'
import type { HourConditions } from './lib/openMeteo'
import { DEFAULT_SPOT_ID } from './lib/spot'
import { resolveScore } from './scoring/resolveScore'
import type { Score } from './scoring/types'
import { useNow, useOnline, useSpotForecast } from './useSpotForecast'
import { HomeScreen, splitName } from './components/HomeScreen'
import { useFavourites } from './lib/favourites'
import { linkClick, spotPath, useRoute } from './lib/route'
import { useSpotList } from './lib/spotList'
import { readLocalAlerts, syncAlerts } from './lib/push'
import { usePrefs } from './lib/prefs'
import { PrefsButton } from './components/PrefsButton'
import { seriesOf } from './scoring/physics'

const loadMotionFeatures = () => import('./motionFeatures').then((r) => r.default)

// Loaded only when needed, so the first screen downloads and runs less JavaScript:
// the chart (Recharts) when scrolled near, the rating form and hour-by-hour sheet when opened,
// the privacy page when visited.
const ForecastVsSurfers = lazy(() => import('./components/ForecastVsSurfers'))
const RateSheet = lazy(() => import('./components/RateSheet').then((m) => ({ default: m.RateSheet })))
const PrivacyPage = lazy(() => import('./components/PrivacyPage').then((m) => ({ default: m.PrivacyPage })))
const HourSheet = lazy(() => import('./components/HourSheet').then((m) => ({ default: m.HourSheet })))
const AlertSheet = lazy(() => import('./components/AlertSheet').then((m) => ({ default: m.AlertSheet })))
/**
 * Renders children only once their placeholder comes within `margin` of the screen. Keeps the
 * first paint small (the top of the page) and moves the rest out of the start-up work.
 */
function WhenNear({
  children,
  placeholder,
  what,
  margin = '150%',
}: {
  children: ReactNode
  placeholder: string
  /** For the "couldn't show …" note if this section fails to load or crashes. */
  what: string
  margin?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || near) return
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setNear(true), { rootMargin: `${margin} 0px` })
    io.observe(el)
    return () => io.disconnect()
  }, [near, margin])
  return near ? (
    <ErrorBoundary name={what} fallback={<SectionFailed what={what} />}>
      <Suspense fallback={<div className={placeholder} aria-hidden />}>{children}</Suspense>
    </ErrorBoundary>
  ) : (
    <div ref={ref} className={placeholder} aria-hidden />
  )
}

/**
 * Opened via the short link /rate (QR poster, shared links): Vilanova's page with the rating
 * form open. Read once at start-up; the address is then set to that spot's page, so a reload,
 * the back button or "Add to Home Screen" doesn't land on the form again. Vercel serves
 * index.html for /rate (vercel.json rewrite) and the service worker does too (offline).
 */
const OPENED_TO_RATE = window.location.pathname.replace(/\/+$/, '') === '/rate' || window.location.hash === '#rate'
if (OPENED_TO_RATE) window.history.replaceState(null, '', spotPath(DEFAULT_SPOT_ID))

/** "#privacy" shows the privacy page; anything else the forecast. No router needed for two views. */
function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash)
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

export default function App() {
  const route = useRoute()
  const now = useNow()
  const online = useOnline()
  const showPrivacy = useHash() === '#privacy'

  return (
    // reducedMotion="user": Framer skips transform/layout animations when the OS asks for less motion.
    // LazyMotion: the animation code (~25 KB) downloads after the first screen; `strict` makes sure
    // every component uses the light `m.*` elements.
    <LazyMotion features={loadMotionFeatures} strict>
    <MotionConfig reducedMotion="user">
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col">
      {showPrivacy ? (
        <ErrorBoundary name="Privacy page" fallback={<SectionFailed what="the privacy page" />}>
          <Suspense fallback={null}>
            <PrivacyPage />
          </Suspense>
        </ErrorBoundary>
      ) : route.name === 'home' ? (
        <Home now={now} online={online} />
      ) : (
        <SpotPage key={route.spotId} spotId={route.spotId} now={now} online={online} />
      )}

      <footer className="mt-auto px-4 pt-10 pb-6 text-xs text-mist sm:px-8">
        <a href="https://open-meteo.com/" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foam">
          Weather data by Open-Meteo.com
        </a>
        <a href="#privacy" className="ml-4 underline underline-offset-2 hover:text-foam">
          Privacy
        </a>
      </footer>
    </div>
    </MotionConfig>
    </LazyMotion>
  )
}

function Home({ now, online }: { now: number; online: boolean }) {
  const { state, retry } = useSpotList()
  useEffect(() => {
    document.title = 'Surf right now'
  }, [])
  return <HomeScreen state={state} retry={retry} now={now} online={online} />
}

function BackLink() {
  return (
    <a href="/" onClick={linkClick} className="self-start rounded-full px-2 py-1 text-sm font-semibold text-mist hover:bg-deep hover:text-foam">
      ‹ All spots
    </a>
  )
}

function SpotPage({ spotId, now, online }: { spotId: string; now: number; online: boolean }) {
  const { state, retry } = useSpotForecast(spotId)

  // Surfer reports start loading with everything else (not after the forecast), so the
  // section is usually there before the screen first paints; refreshed after you rate.
  const [reportsKey, setReportsKey] = useState(0)
  const onRatingSent = useCallback(() => setReportsKey((k) => k + 1), [])
  const reports = useReports(spotId, reportsKey)
  const model = useModelInfo(spotId)

  const name = state.status === 'ready' ? splitName(state.spot.name).town : null
  useEffect(() => {
    if (name) document.title = `${name} · Surf`
  }, [name])

  if (state.status === 'loading') {
    return (
      <main className="flex flex-1 flex-col gap-4 px-4 pt-4 sm:px-8">
        <BackLink />
        <p className="font-display text-5xl font-extrabold text-mist">Checking the sea…</p>
      </main>
    )
  }
  if (state.status === 'error') {
    return (
      <main className="flex flex-1 flex-col gap-4 px-4 pt-4 sm:px-8">
        <BackLink />
        <p className="font-display text-5xl font-extrabold text-coral">No forecast</p>
        <p className="max-w-[50ch]">Couldn't load the forecast: {state.message}</p>
        <button
          type="button"
          onClick={retry}
          className="self-start rounded-lg bg-foam px-4 py-2 font-semibold text-abyss hover:bg-glass"
        >
          Try again
        </button>
      </main>
    )
  }
  return <SpotScreen {...state} now={now} online={online} reports={reports} model={model} onRatingSent={onRatingSent} />
}

type ReadyState = Extract<ReturnType<typeof useSpotForecast>['state'], { status: 'ready' }>

interface ScreenProps {
  now: number
  online: boolean
  reports: ReportsState
  model: ModelInfo | null
  onRatingSent: () => void
}

function SpotScreen({ spot, forecast, stale, refreshing, ai, now, online, reports, model, onRatingSent }: ReadyState & ScreenProps) {
  const tz = forecast.timezone
  const { prefs } = usePrefs()
  // Scores for every fetched hour, yesterday included (ratings need them). The whole fetched
  // range (past 14 days too) is the history for wind 6/12/24 h and rain 72 h.
  const scores = useMemo(() => {
    const series = seriesOf(forecast.days.flatMap((d) => d.hours))
    const m = new Map<number, Score>()
    for (const d of forecast.days) for (const h of d.hours) m.set(h.time, resolveScore(h, spot, ai.get(h.time), series, prefs))
    return m
  }, [forecast, spot, ai, prefs])
  // The forecast UI starts at today.
  const today = localDate(now, tz)
  const days = useMemo(() => {
    const first = forecast.days.findIndex((d) => d.date >= today)
    return first <= 0 ? forecast.days : forecast.days.slice(first)
  }, [forecast, today])
  const allHours = useMemo(() => days.flatMap((d) => d.hours), [days])

  // Current hour (or the closest one if the forecast is older/newer than now).
  const nowIdx = Math.max(0, allHours.findIndex((h) => now < h.time + 3600))
  const nowHour: HourConditions | undefined = allHours[nowIdx]
  const todayDay = days.find((d) => d.hours.some((h) => h.time === nowHour?.time)) ?? days[0]
  const nextDays = useMemo(() => days.filter((d) => d.date > (todayDay?.date ?? today)).slice(0, 3), [days, todayDay, today])

  // The short link /rate (the poster's QR code) opens the app with the rating form already up.
  const [rating, setRating] = useState(OPENED_TO_RATE)
  // Sheets' code is downloaded on first open and then kept, so closing can animate.
  const [ratingLoaded, setRatingLoaded] = useState(OPENED_TO_RATE)
  const openRating = useCallback(() => {
    setRatingLoaded(true)
    setRating(true)
  }, [])
  const closeRating = useCallback(() => setRating(false), [])

  // Hour-by-hour sheet: index into [today, ...nextDays]; null = closed.
  const sheetDays = useMemo(() => (todayDay ? [todayDay, ...nextDays] : nextDays), [todayDay, nextDays])
  const [hoursDay, setHoursDay] = useState<number | null>(null)
  const [hoursLoaded, setHoursLoaded] = useState(false)
  const openHours = useCallback((i: number) => {
    setHoursLoaded(true)
    setHoursDay(i)
  }, [])
  const openToday = useCallback(() => openHours(0), [openHours])
  const openNextDay = useCallback((i: number) => openHours(i + 1), [openHours])
  const closeHours = useCallback(() => setHoursDay(null), [])

  const chartRows = useMemo(
    () => buildChartRows(forecast, spot, ai, reports.status === 'ready' ? reports.daily : [], today, CHART_DAYS),
    [forecast, spot, ai, reports, today],
  )

  const firstLight = useMemo(() => {
    if (!nowHour || nowHour.isDay) return null
    return forecast.days.map((d) => d.sunrise).find((s): s is number => s != null && s > now) ?? null
  }, [forecast, nowHour, now])

  const { town, beach: placeName } = splitName(spot.name)
  const { ids: favIds, toggle } = useFavourites()
  const favourite = favIds.has(spot.id)

  // Surf alert for this spot: local copy at once, then what the database really has.
  const [alertMin, setAlertMin] = useState<number | null>(() => readLocalAlerts()[spot.id] ?? null)
  useEffect(() => {
    let live = true
    void syncAlerts().then((a) => live && setAlertMin(a[spot.id] ?? null))
    return () => {
      live = false
    }
  }, [spot.id])
  const [alertOpen, setAlertOpen] = useState(false)
  const [alertLoaded, setAlertLoaded] = useState(false)
  const closeAlert = useCallback(() => setAlertOpen(false), [])

  return (
    <main className="flex flex-col gap-3.5">
      <div className="flex items-center justify-between px-3 pt-3 sm:px-6">
        <BackLink />
        <div className="flex flex-wrap items-center justify-end gap-1">
          <PrefsButton />
          <button
            type="button"
            onClick={() => {
              setAlertLoaded(true)
              setAlertOpen(true)
            }}
            aria-haspopup="dialog"
            className={`rounded-full px-3 py-1 text-sm font-semibold hover:bg-deep ${alertMin != null ? 'text-sand' : 'text-mist hover:text-foam'}`}
          >
            {alertMin != null ? `🔔 Alert ${alertMin}+` : '🔔 Alert me'}
          </button>
          <button
            type="button"
            onClick={() => toggle(spot.id)}
            aria-pressed={favourite}
            aria-label={favourite ? `Remove ${town} from your spots` : `Add ${town} to your spots`}
            className={`rounded-full px-3 py-1 text-sm font-semibold hover:bg-deep ${favourite ? 'text-sand' : 'text-mist hover:text-foam'}`}
          >
            {favourite ? '★ Saved' : '☆ Save'}
          </button>
        </div>
      </div>
      {alertLoaded && (
        <ErrorBoundary name="Alert" fallback={<SectionFailed what="the alert settings" />}>
          <Suspense fallback={null}>
            <AlertSheet open={alertOpen} onClose={closeAlert} spotId={spot.id} town={town} current={alertMin} onChanged={setAlertMin} />
          </Suspense>
        </ErrorBoundary>
      )}
      <header className="flex items-baseline justify-between gap-4 px-5 pb-1 sm:px-8">
        <div className="flex flex-col">
          <span className="font-display text-[26px] font-extrabold">{town}</span>
          {placeName && <span className="text-[13px] text-mist">{placeName}</span>}
        </div>
        <span className="text-xs text-mist">Updated {hhmm(Math.floor(forecast.fetchedAt / 1000), tz)}</span>
      </header>

      {!online ? (
        <p role="status" className="mx-4 rounded-lg border border-sand/40 px-3 py-2 text-sm text-sand sm:mx-8">
          You’re offline. This is the forecast saved at {hhmm(Math.floor(forecast.fetchedAt / 1000), tz)}.
        </p>
      ) : (
        stale &&
        !refreshing && (
          <p role="status" className="mx-4 rounded-lg border border-sand/40 px-3 py-2 text-sm text-sand sm:mx-8">
            Open-Meteo isn't answering. This is the forecast from {hhmm(Math.floor(forecast.fetchedAt / 1000), tz)}.
          </p>
        )
      )}

      {nowHour && todayDay && (
        <Verdict
          score={scores.get(nowHour.time)!}
          hour={nowHour}
          next={allHours[nowIdx + 1]}
          dayHours={todayDay.hours}
          spot={spot}
          timezone={tz}
          firstLight={firstLight}
          now={now}
          learnedFrom={learnedFrom(model)}
        />
      )}

      <TodayReports reports={reports} timezone={tz} onRate={openRating} />
      {ratingLoaded && (
        <ErrorBoundary name="Rating form" fallback={<SectionFailed what="the rating form" />}>
          <Suspense fallback={null}>
            <RateSheet open={rating} onClose={closeRating} spot={spot} forecast={forecast} scores={scores} now={now} onSent={onRatingSent} />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* Below the first screen: drawn when scrolled near, not at start-up. */}
      {todayDay && (
        <WhenNear placeholder="h-[26rem]" margin="300px" what="today's forecast">
          <TodayCard day={todayDay} scores={scores} spot={spot} timezone={tz} now={now} onOpenHours={openToday} />
        </WhenNear>
      )}
      <WhenNear placeholder="h-[24rem]" margin="300px" what="the next days">
        <NextDays days={nextDays} scores={scores} spot={spot} timezone={tz} onOpenDay={openNextDay} />
      </WhenNear>
      {hoursLoaded && (
        <ErrorBoundary name="Hour by hour" fallback={<SectionFailed what="the hour-by-hour forecast" />}>
          <Suspense fallback={null}>
            <HourSheet
              open={hoursDay != null}
              onClose={closeHours}
              days={sheetDays}
              initialDay={hoursDay ?? 0}
              scores={scores}
              spot={spot}
              timezone={tz}
              now={now}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {chartRows.length > 1 && (
        <WhenNear placeholder="h-[34rem]" margin="200px" what="who called it">
          <ForecastVsSurfers rows={chartRows} model={model} />
        </WhenNear>
      )}
    </main>
  )
}
