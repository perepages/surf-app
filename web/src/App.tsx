import { LazyMotion, MotionConfig } from 'framer-motion'
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ConditionsPanel } from './components/ConditionsPanel'
import { ErrorBoundary, SectionFailed } from './components/ErrorBoundary'
import { HourList } from './components/HourList'
import { HourStrip } from './components/HourStrip'
import { TideCurve } from './components/TideCurve'
import { TodayReports } from './components/TodayReports'
import { buildChartRows } from './lib/chartData'
import { CHART_DAYS, useReports, type ReportsState } from './lib/reports'
import { Verdict } from './components/Verdict'
import { dayOfMonth, hhmm, localDate, weekday } from './lib/format'
import type { ForecastDay, HourConditions } from './lib/openMeteo'
import { DEFAULT_SPOT_ID } from './lib/spot'
import { resolveScore } from './scoring/resolveScore'
import type { Score } from './scoring/types'
import { useNow, useOnline, useSpotForecast } from './useSpotForecast'

const SCORE_BG = ['', 'bg-s1', 'bg-s2', 'bg-s3', 'bg-s4', 'bg-s5']

const loadMotionFeatures = () => import('./motionFeatures').then((r) => r.default)

// Loaded only when needed, so the first screen downloads and runs less JavaScript:
// the chart (Recharts) when scrolled near, the rating form when opened, the privacy page when visited.
const ForecastVsSurfers = lazy(() => import('./components/ForecastVsSurfers'))
const RateSheet = lazy(() => import('./components/RateSheet').then((m) => ({ default: m.RateSheet })))
const PrivacyPage = lazy(() => import('./components/PrivacyPage').then((m) => ({ default: m.PrivacyPage })))

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
  const { state, retry } = useSpotForecast(DEFAULT_SPOT_ID)
  const now = useNow()
  const online = useOnline()
  const showPrivacy = useHash() === '#privacy'

  // Surfer reports start loading with everything else (not after the forecast), so the
  // section is usually there before the screen first paints; refreshed after you rate.
  const [reportsKey, setReportsKey] = useState(0)
  const onRatingSent = useCallback(() => setReportsKey((k) => k + 1), [])
  const reports = useReports(DEFAULT_SPOT_ID, reportsKey)

  return (
    // reducedMotion="user": Framer skips transform/layout animations when the OS asks for less motion.
    // LazyMotion: the animation code (~25 KB) downloads after the first screen; `strict` makes sure
    // every component uses the light `m.*` elements.
    <LazyMotion features={loadMotionFeatures} strict>
    <MotionConfig reducedMotion="user">
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col">
      {showPrivacy && (
        <ErrorBoundary name="Privacy page" fallback={<SectionFailed what="the privacy page" />}>
          <Suspense fallback={null}>
            <PrivacyPage />
          </Suspense>
        </ErrorBoundary>
      )}
      {!showPrivacy && state.status === 'loading' && (
        <main className="flex flex-1 items-center px-4 sm:px-8">
          <p className="font-display text-5xl font-extrabold text-mist">Checking the sea…</p>
        </main>
      )}
      {!showPrivacy && state.status === 'error' && (
        <main className="flex flex-1 flex-col justify-center gap-4 px-4 sm:px-8">
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
      )}
      {!showPrivacy && state.status === 'ready' && (
        <SpotScreen {...state} now={now} online={online} reports={reports} onRatingSent={onRatingSent} />
      )}

      {/* Hidden while loading, so it doesn't jump down when the forecast appears. */}
      {(showPrivacy || state.status !== 'loading') && (
      <footer className="mt-auto px-4 pt-10 pb-6 text-xs text-mist sm:px-8">
        <a href="https://open-meteo.com/" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foam">
          Weather data by Open-Meteo.com
        </a>
        <a href="#privacy" className="ml-4 underline underline-offset-2 hover:text-foam">
          Privacy
        </a>
      </footer>
      )}
    </div>
    </MotionConfig>
    </LazyMotion>
  )
}

type ReadyState = Extract<ReturnType<typeof useSpotForecast>['state'], { status: 'ready' }>

interface ScreenProps {
  now: number
  online: boolean
  reports: ReportsState
  onRatingSent: () => void
}

function SpotScreen({ spot, forecast, stale, refreshing, ai, now, online, reports, onRatingSent }: ReadyState & ScreenProps) {
  const tz = forecast.timezone
  // Scores for every fetched hour, yesterday included (ratings need them).
  const scores = useMemo(() => {
    const m = new Map<number, Score>()
    for (const d of forecast.days) for (const h of d.hours) m.set(h.time, resolveScore(h, spot, ai.get(h.time)))
    return m
  }, [forecast, spot, ai])
  // The forecast UI starts at today.
  const today = localDate(now, tz)
  const days = useMemo(() => {
    const first = forecast.days.findIndex((d) => d.date >= today)
    return first <= 0 ? forecast.days : forecast.days.slice(first)
  }, [forecast, today])
  const allHours = useMemo(() => days.flatMap((d) => d.hours), [days])
  const anyAi = useMemo(() => [...scores.values()].some((s) => s.source === 'ai'), [scores])

  // Current hour (or the closest one if the forecast is older/newer than now).
  const nowIdx = Math.max(0, allHours.findIndex((h) => now < h.time + 3600))
  const nowHour: HourConditions | undefined = allHours[nowIdx]
  const todayIdx = Math.max(0, days.findIndex((d) => d.hours.some((h) => h.time === nowHour?.time)))

  // Selected hour; null = follow "now" as the clock moves.
  const [picked, setPicked] = useState<number | null>(null)
  const selectedIdx = picked == null ? nowIdx : Math.max(0, allHours.findIndex((h) => h.time === picked))
  const selHour = allHours[selectedIdx]
  const nowTime = nowHour?.time
  const selectHour = useCallback((t: number) => setPicked(t === nowTime ? null : t), [nowTime])
  const dayIdx = Math.max(0, days.findIndex((d) => d.hours.some((h) => h.time === selHour?.time)))
  const day = days[dayIdx]
  const selectDay = useCallback(
    (i: number) => {
      if (i === todayIdx) return setPicked(null)
      const d = days[i]
      // First daylight hour with something to see, else the first hour.
      setPicked((d.hours.find((h) => h.isDay) ?? d.hours[0]).time)
    },
    [days, todayIdx],
  )

  const [rating, setRating] = useState(false)
  // The form's code is downloaded on first open and then kept, so closing can animate.
  const [ratingLoaded, setRatingLoaded] = useState(false)
  const openRating = () => {
    setRatingLoaded(true)
    setRating(true)
  }
  const closeRating = useCallback(() => setRating(false), [])
  const chartRows = useMemo(
    () => buildChartRows(forecast, spot, ai, reports.status === 'ready' ? reports.daily : [], today, CHART_DAYS),
    [forecast, spot, ai, reports, today],
  )

  const firstLight = useMemo(() => {
    if (!nowHour || nowHour.isDay) return null
    return forecast.days.map((d) => d.sunrise).find((s): s is number => s != null && s > now) ?? null
  }, [forecast, nowHour, now])

  return (
    <main>
      <header className="flex items-baseline justify-between gap-4 px-4 pt-5 sm:px-8">
        <span className="font-display text-xl font-extrabold">{spot.name.replace(/\s*\(.*\)\s*$/, '')}</span>
        <span className="text-xs text-mist">Updated {hhmm(Math.floor(forecast.fetchedAt / 1000), tz)}</span>
      </header>

      {!online ? (
        <p role="status" className="mx-4 mt-3 rounded-lg border border-sand/40 px-3 py-2 text-sm text-sand sm:mx-8">
          You’re offline. This is the forecast saved at {hhmm(Math.floor(forecast.fetchedAt / 1000), tz)}.
        </p>
      ) : (
        stale &&
        !refreshing && (
          <p role="status" className="mx-4 mt-3 rounded-lg border border-sand/40 px-3 py-2 text-sm text-sand sm:mx-8">
            Open-Meteo isn't answering. This is the forecast from {hhmm(Math.floor(forecast.fetchedAt / 1000), tz)}.
          </p>
        )
      )}

      {nowHour && (
        <Verdict score={scores.get(nowHour.time)!} timezone={tz} firstLight={firstLight} now={now} />
      )}

      <div className="px-4 pb-10 sm:px-8">
        <button
          type="button"
          onClick={openRating}
          className="w-full rounded-2xl bg-foam px-5 py-4 text-left font-display text-3xl font-extrabold text-abyss transition-colors hover:bg-glass sm:w-auto"
        >
          I surfed — rate it
          <span className="block font-sans text-sm font-medium text-abyss/70">Tell the forecast how it really was</span>
        </button>
      </div>
      {ratingLoaded && (
        <ErrorBoundary name="Rating form" fallback={<SectionFailed what="the rating form" />}>
        <Suspense fallback={null}>
          <RateSheet open={rating} onClose={closeRating} spot={spot} forecast={forecast} scores={scores} now={now} onSent={onRatingSent} />
        </Suspense>
        </ErrorBoundary>
      )}
      <TodayReports reports={reports} timezone={tz} />

      {/* Below the first screen: drawn when scrolled near, not at start-up. */}
      {selHour && (
        <WhenNear placeholder="h-[36rem]" margin="300px" what="the conditions for this hour">
        <ConditionsPanel
          spot={spot}
          hour={selHour}
          next={allHours[selectedIdx + 1]}
          score={scores.get(selHour.time)!}
          timezone={tz}
          isNow={selHour.time === nowHour?.time}
        />
        </WhenNear>
      )}

      <WhenNear placeholder="h-[90rem]" margin="300px" what="the hourly forecast">
      <section aria-label="Hourly forecast" className="mt-8 px-4 sm:px-8">
        <HourStrip hours={allHours} scores={scores} selected={selHour?.time ?? 0} onSelect={selectHour} timezone={tz} now={now} />
        <div className="mt-4">
          <DayTabs days={days} selected={dayIdx} onSelect={selectDay} scores={scores} tz={tz} todayIdx={todayIdx} />
        </div>
        <div className="mt-6 mb-5">
          <TideCurve hours={day.hours} timezone={tz} now={now} selected={selHour?.time ?? now} />
        </div>
        <HourList spot={spot} hours={day.hours} scores={scores} timezone={tz} now={now} selected={selHour?.time ?? 0} />
        <p className="mt-4 text-xs text-mist">
          {anyAi
            ? 'Hours with a yellow dot use the AI-corrected score, trained on surfers’ ratings.'
            : 'Scores come from simple rules on wave size, period and wind. They will be corrected by AI once enough surfers rate real conditions.'}
        </p>
      </section>
      </WhenNear>

      {chartRows.length > 1 && (
        <WhenNear placeholder="h-[34rem]" margin="200px" what="the forecast vs surfers chart">
          <ForecastVsSurfers rows={chartRows} />
        </WhenNear>
      )}
    </main>
  )
}

const DayTabs = memo(function DayTabs({
  days,
  selected,
  onSelect,
  scores,
  tz,
  todayIdx,
}: {
  days: ForecastDay[]
  selected: number
  onSelect: (i: number) => void
  scores: Map<number, Score>
  tz: string
  todayIdx: number
}) {
  return (
    <div role="tablist" aria-label="Day" className="grid grid-cols-4 gap-2">
      {days.map((d, i) => {
        // Best daylight score of the day, so you can spot the good day at a glance.
        const daylight = d.hours.filter((h) => h.isDay)
        const best = Math.max(1, ...(daylight.length ? daylight : d.hours).map((h) => scores.get(h.time)?.value ?? 1))
        const active = i === selected
        const noon = d.hours[Math.floor(d.hours.length / 2)].time
        return (
          <button
            key={d.date}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(i)}
            className={`flex flex-col items-start rounded-lg border px-2.5 pt-1.5 pb-2 text-left transition-colors ${
              active ? 'border-foam bg-deep' : 'border-kelp hover:border-mist'
            }`}
          >
            <span className="text-sm text-mist">{i === todayIdx ? 'Today' : weekday(noon, tz)}</span>
            <span className="font-display text-2xl leading-none font-extrabold">{dayOfMonth(noon, tz)}</span>
            <span className="mt-2 flex w-full items-center gap-1.5" title={`Best score ${best}/5`}>
              <span className={`h-1.5 rounded-full ${SCORE_BG[best]}`} style={{ width: `${best * 20}%` }} />
              <span className="text-xs text-mist tabular-nums">{best}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
})
