import { LazyMotion, MotionConfig } from 'framer-motion'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { ErrorBoundary, SectionFailed } from './components/ErrorBoundary'
import { HomeScreen } from './components/HomeScreen'
import { useModelInfo } from './lib/modelInfo'
import { useReports } from './lib/reports'
import { linkClick, spotPath, useRoute } from './lib/route'
import { DEFAULT_SPOT_ID } from './lib/spot'
import { useSpotList } from './lib/spotList'
import { IconBack } from './spot/Icons'
import { SpotScreen } from './spot/SpotScreen'
import { useLang } from './spot/strings'
import { useNow, useOnline, useSpotForecast } from './useSpotForecast'

const loadMotionFeatures = () => import('./motionFeatures').then((r) => r.default)

// The privacy page is only downloaded when visited.
const PrivacyPage = lazy(() => import('./components/PrivacyPage').then((m) => ({ default: m.PrivacyPage })))

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
  const wide = route.name === 'spot' && !showPrivacy

  return (
    // reducedMotion="user": Framer skips transform/layout animations when the OS asks for less motion.
    // LazyMotion: the animation code (~25 KB) downloads after the first screen; `strict` makes sure
    // every component uses the light `m.*` elements.
    <LazyMotion features={loadMotionFeatures} strict>
    <MotionConfig reducedMotion="user">
    <div className={`mx-auto flex min-h-dvh flex-col ${wide ? 'max-w-[1280px]' : 'max-w-3xl'}`}>
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

      <footer className="mt-auto px-4 pt-10 pb-6 text-xs text-mist sm:px-10">
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

function BackLink({ label }: { label: string }) {
  return (
    <a href="/" onClick={linkClick} className="flex items-center gap-1 self-start rounded-[8px] px-2 py-1 text-sm font-semibold text-mist hover:text-foam">
      <IconBack size={15} />
      {label}
    </a>
  )
}

function SpotPage({ spotId, now, online }: { spotId: string; now: number; online: boolean }) {
  const { state, retry } = useSpotForecast(spotId)
  const [, t] = useLang()

  // Surfer reports start loading with everything else (not after the forecast), so the
  // section is usually there before the screen first paints; refreshed after you rate.
  const [reportsKey, setReportsKey] = useState(0)
  const onRatingSent = useCallback(() => setReportsKey((k) => k + 1), [])
  const reports = useReports(spotId, reportsKey)
  const model = useModelInfo(spotId)

  if (state.status === 'loading') {
    return (
      <main className="flex flex-1 flex-col gap-4 px-4 pt-4 sm:px-10">
        <BackLink label={t.allSpots} />
        <p className="font-display text-5xl font-extrabold text-mist">{t.loading}</p>
      </main>
    )
  }
  if (state.status === 'error') {
    return (
      <main className="flex flex-1 flex-col gap-4 px-4 pt-4 sm:px-10">
        <BackLink label={t.allSpots} />
        <p className="font-display text-5xl font-extrabold text-coral">{t.noForecast}</p>
        <p className="max-w-[50ch]">{t.loadFailed(state.message)}</p>
        <button type="button" onClick={retry} className="self-start rounded-[8px] bg-foam px-4 py-2 font-semibold text-abyss hover:bg-glass">
          {t.tryAgain}
        </button>
      </main>
    )
  }
  return <SpotScreen {...state} now={now} online={online} reports={reports} model={model} onRatingSent={onRatingSent} openRatingAtStart={OPENED_TO_RATE} />
}
