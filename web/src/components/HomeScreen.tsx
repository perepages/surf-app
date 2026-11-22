// Home: every spot, best score right now first. Favourites (saved on this phone) on top.
// List or map (the map's code, Leaflet, downloads only when the map is opened).

import { lazy, memo, Suspense, useMemo, useState } from 'react'
import { MiniWave } from './MiniWave'
import { ErrorBoundary, SectionFailed } from './ErrorBoundary'
import { SCORE_WORD, ScoreBadge } from './ScoreChip'
import { windInfo } from '../lib/conditions'
import { useFavourites } from '../lib/favourites'
import { hhmm, num } from '../lib/format'
import { CROWDS, type Crowd } from '../lib/ratings'
import { linkClick, spotPath } from '../lib/route'
import { spotsNow, type SpotListState, type SpotNow } from '../lib/spotList'
import { resolveScore } from '../scoring/resolveScore'
import type { Score } from '../scoring/types'

/** "Updated" times are in the phone's own time zone (spots may be in several). */
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

const SpotMap = lazy(() => import('./SpotMap'))

export interface RankedSpot extends SpotNow {
  score: Score | null
  favourite: boolean
}

type View = 'list' | 'map'
const VIEW_KEY = 'surf:home-view'
const readView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'map' ? 'map' : 'list'
  } catch {
    return 'list'
  }
}

/** Best first: score, then bigger waves, then name. Spots without data last. */
function rank(a: RankedSpot, b: RankedSpot) {
  return (
    (b.score?.value ?? 0) - (a.score?.value ?? 0) ||
    (b.hour?.waveHeight ?? -1) - (a.hour?.waveHeight ?? -1) ||
    a.spot.name.localeCompare(b.spot.name)
  )
}

const CROWD_LABEL = Object.fromEntries(CROWDS.map((c) => [c.id, c.label])) as Record<Crowd, string>
/** How full the water is, 0-4 dots (empty -> packed). */
const CROWD_LEVEL: Record<Crowd, number> = { empty: 0, few: 1, busy: 3, packed: 4 }

/** Name without the "(beach)" part, and the beach on its own. */
export const splitName = (name: string) => ({
  town: name.replace(/\s*\(.*\)\s*$/, ''),
  beach: name.match(/\((.*)\)/)?.[1] ?? null,
})

export function HomeScreen({ state, retry, now, online }: { state: SpotListState; retry: () => void; now: number; online: boolean }) {
  const [view, setView] = useState<View>(readView)
  const { ids: favIds, toggle } = useFavourites()
  const choose = (v: View) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* not remembered */
    }
  }

  const ranked = useMemo<RankedSpot[]>(() => {
    if (state.status !== 'ready') return []
    return spotsNow(state.data, now)
      .map((s) => ({
        ...s,
        favourite: favIds.has(s.spot.id),
        score: s.hour
          ? resolveScore(s.hour, s.spot, s.aiScore == null ? undefined : { validAt: s.hour.time, aiScore: s.aiScore, reason: null, modelVersion: null })
          : null,
      }))
      .sort(rank)
  }, [state, now, favIds])

  const favourites = ranked.filter((s) => s.favourite)
  const others = ranked.filter((s) => !s.favourite)

  return (
    <main className="flex flex-1 flex-col gap-3.5">
      <header className="flex items-end justify-between gap-4 px-5 pt-5 pb-1 sm:px-8">
        <div className="flex flex-col">
          <h1 className="font-display text-[30px] leading-none font-extrabold">Surf right now</h1>
          <span className="mt-1 text-[13px] text-mist">
            {state.status === 'ready' ? `Best first · updated ${hhmm(Math.floor(state.data.fetchedAt / 1000), LOCAL_TZ)}` : 'Best first'}
          </span>
        </div>
        <div role="tablist" aria-label="Show spots as" className="flex shrink-0 rounded-full border border-line bg-deep p-1 text-sm font-semibold">
          {(['list', 'map'] as const).map((v) => (
            <button
              key={v}
              role="tab"
              type="button"
              aria-selected={view === v}
              onClick={() => choose(v)}
              className={`rounded-full px-3.5 py-1.5 capitalize ${view === v ? 'bg-foam text-abyss' : 'text-mist hover:text-foam'}`}
            >
              {v}
            </button>
          ))}
        </div>
      </header>

      {state.status === 'ready' && (!online || state.stale) && !state.refreshing && (
        <p role="status" className="mx-4 rounded-lg border border-sand/40 px-3 py-2 text-sm text-sand sm:mx-8">
          {online ? 'Open-Meteo isn’t answering.' : 'You’re offline.'} These are the conditions saved at{' '}
          {hhmm(Math.floor(state.data.fetchedAt / 1000), LOCAL_TZ)}.
        </p>
      )}

      {state.status === 'loading' && <p className="px-5 font-display text-4xl font-extrabold text-mist sm:px-8">Checking the sea…</p>}
      {state.status === 'error' && (
        <div className="flex flex-col gap-4 px-5 sm:px-8">
          <p className="font-display text-4xl font-extrabold text-coral">No forecast</p>
          <p className="max-w-[50ch]">Couldn't load the conditions: {state.message}</p>
          <button type="button" onClick={retry} className="self-start rounded-lg bg-foam px-4 py-2 font-semibold text-abyss hover:bg-glass">
            Try again
          </button>
        </div>
      )}

      {state.status === 'ready' && view === 'list' && (
        <>
          {favourites.length > 0 && <SpotGroup title="Your spots" spots={favourites} onStar={toggle} />}
          <SpotGroup title={favourites.length ? 'Other spots' : 'All spots'} spots={others} onStar={toggle} hint={favourites.length === 0} />
        </>
      )}
      {state.status === 'ready' && view === 'map' && (
        <ErrorBoundary name="Map" fallback={<SectionFailed what="the map" />}>
          <Suspense fallback={<div className="mx-4 h-[60dvh] rounded-3xl border border-line bg-card sm:mx-8" aria-hidden />}>
            <SpotMap spots={ranked} />
          </Suspense>
        </ErrorBoundary>
      )}
    </main>
  )
}

function SpotGroup({ title, spots, onStar, hint = false }: { title: string; spots: RankedSpot[]; onStar: (id: string) => void; hint?: boolean }) {
  if (!spots.length) return null
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="flex items-baseline justify-between px-5 text-xs font-semibold tracking-wider text-mist uppercase sm:px-8">
        {title}
        {hint && <span className="font-normal tracking-normal normal-case">Tap ☆ to keep a spot on top</span>}
      </h2>
      <ul className="flex flex-col gap-2 px-4 sm:px-8">
        {spots.map((s) => (
          <SpotRow key={s.spot.id} s={s} onStar={onStar} />
        ))}
      </ul>
    </section>
  )
}

const SpotRow = memo(function SpotRow({ s, onStar }: { s: RankedSpot; onStar: (id: string) => void }) {
  const { town, beach } = splitName(s.spot.name)
  const h = s.hour
  const wind = h ? windInfo(h, s.spot.beachOrientation) : null
  const value = s.score?.value
  return (
    <li className="relative flex items-center gap-3 rounded-2xl border border-line bg-card py-3 pr-2 pl-3">
      {value ? <ScoreBadge value={value} /> : <span className="grid size-10 shrink-0 place-items-center rounded-[14px] bg-deep text-mist">–</span>}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* The whole card opens the spot (stretched link); the star stays its own button. */}
        <a href={spotPath(s.spot.id)} onClick={linkClick} className="line-clamp-2 font-display text-xl leading-tight font-extrabold after:absolute after:inset-0 after:rounded-2xl after:content-['']">
          {town}
        </a>
        {beach && <span className="truncate text-xs text-mist">{beach}</span>}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          {value && <span className={`font-bold ${SCORE_WORD[value].className}`}>{SCORE_WORD[value].word}</span>}
          {s.score?.source === 'ai' && <span className="text-sand">AI</span>}
          {wind && <span className={`rounded-full px-1.5 ${wind.tagClass}`}>{wind.label}</span>}
          {h && !h.isDay && <span className="text-mist">after dark</span>}
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {h && value ? <MiniWave height={h.waveHeight} period={h.swellPeriod ?? h.wavePeriod} score={value} /> : null}
        <span className="text-xs font-semibold tabular-nums">
          {num(h?.waveHeight ?? null)} m{h?.swellPeriod != null || h?.wavePeriod != null ? ` · ${Math.round((h.swellPeriod ?? h.wavePeriod)!)} s` : ''}
        </span>
        <CrowdLevel crowd={s.crowd} reports={s.reports} />
      </div>
      <button
        type="button"
        onClick={() => onStar(s.spot.id)}
        aria-pressed={s.favourite}
        aria-label={s.favourite ? `Remove ${town} from your spots` : `Add ${town} to your spots`}
        className={`relative z-10 grid size-10 shrink-0 place-items-center rounded-full text-2xl leading-none hover:bg-deep ${s.favourite ? 'text-sand' : 'text-mist'}`}
      >
        {s.favourite ? '★' : '☆'}
      </button>
    </li>
  )
})

/** Crowd from today's surfer reports (cams can't count people yet). */
export function CrowdLevel({ crowd, reports }: { crowd: Crowd | null; reports: number }) {
  if (!crowd) {
    return <span className="text-[11px] text-mist">Crowd: no reports</span>
  }
  const level = CROWD_LEVEL[crowd]
  return (
    <span className="flex items-center gap-1 text-[11px]" title={`Most of today's ${reports} surfer report${reports === 1 ? '' : 's'}`}>
      <span aria-hidden className="flex gap-[2px]">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`size-1.5 rounded-full ${i < level ? 'bg-foam' : 'bg-line'}`} />
        ))}
      </span>
      <span>
        {CROWD_LABEL[crowd]}
        <span className="text-mist"> · {reports} report{reports === 1 ? '' : 's'}</span>
      </span>
    </span>
  )
}
