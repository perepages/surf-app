// Home: what opens at the bare address. The coast right now: a photo hero with the best spot at
// this hour, then every spot as a card (photo, score, waves, wind, next hours, crowd), best first,
// favourites (saved on this phone) on top. List or map (Leaflet downloads only when opened).

import { lazy, memo, Suspense, useEffect, useMemo, useState } from 'react'
import { ErrorBoundary, SectionFailed } from '../components/ErrorBoundary'
import { useFavourites } from '../lib/favourites'
import { dayOfMonth, hh, hhmm, num } from '../lib/format'
import { windRelation } from '../lib/geo'
import type { HourConditions } from '../lib/forecast'
import { usePrefs } from '../lib/prefs'
import type { Crowd } from '../lib/ratings'
import { linkClick, spotPath } from '../lib/route'
import { spotsNow, type SpotListState, type SpotNow } from '../lib/spotList'
import { seriesOf } from '../scoring/physics'
import { resolveScore } from '../scoring/resolveScore'
import type { Score, ScoreValue } from '../scoring/types'
import { IconArrow, IconStar } from './Icons'
import { designFor } from './spotDesign'
import { useLang, windName, type Strings } from './strings'
import { BAR_BG, HeroPhoto, Pips, REL_TAG, REL_TEXT, splitName, TopBar, VERDICT_TEXT, wd } from './ui'

const SpotMap = lazy(() => import('../components/SpotMap'))

/** Times on the home page are in the phone's own time zone (spots may be in several). */
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

export interface RankedSpot extends SpotNow {
  score: Score | null
  favourite: boolean
  /** This hour and the next ones we have (up to 4), with their scores. */
  next: { hour: HourConditions; value: ScoreValue }[]
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

const shortName = (s: RankedSpot) => designFor(s.spot.id)?.name ?? splitName(s.spot.name).town

/** How full the water is, 0-4 dots (empty -> packed). */
const CROWD_LEVEL: Record<Crowd, number> = { empty: 0, few: 1, busy: 3, packed: 4 }

export function HomePage({ state, retry, now, online }: { state: SpotListState; retry: () => void; now: number; online: boolean }) {
  const [, t] = useLang()
  const [view, setView] = useState<View>(readView)
  const { ids: favIds, toggle } = useFavourites()
  const { prefs } = usePrefs()
  const choose = (v: View) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* not remembered */
    }
  }

  useEffect(() => {
    document.title = t.home.title
  }, [t])

  const ranked = useMemo<RankedSpot[]>(() => {
    if (state.status !== 'ready') return []
    return spotsNow(state.data, now)
      .map((s) => {
        const all = state.data.hours[s.spot.id] ?? []
        const series = seriesOf(all)
        const ai = state.data.ai[s.spot.id] ?? {}
        const scoreOf = (h: HourConditions) => resolveScore(h, s.spot, ai[h.time] ?? undefined, series, prefs)
        const next = s.hour ? all.filter((h) => h.time >= s.hour!.time).slice(0, 4).map((h) => ({ hour: h, value: scoreOf(h).value })) : []
        return { ...s, favourite: favIds.has(s.spot.id), score: s.hour ? scoreOf(s.hour) : null, next }
      })
      .sort(rank)
  }, [state, now, favIds, prefs])

  const favourites = ranked.filter((s) => s.favourite)
  const others = ranked.filter((s) => !s.favourite)
  const fetchedS = state.status === 'ready' ? Math.floor(state.data.fetchedAt / 1000) : null

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 pt-4 sm:px-10 sm:pt-6">
      <TopBar current={null} />

      {state.status === 'ready' && (!online || state.stale) && !state.refreshing && fetchedS != null && (
        <p role="status" className="mt-4 border-l-2 border-accent pl-3 text-sm text-stone2">
          {!online ? t.offline(hhmm(fetchedS, LOCAL_TZ)) : t.stale(hhmm(fetchedS, LOCAL_TZ))}
        </p>
      )}

      <main className="mt-5 flex flex-col gap-4 sm:mt-8 sm:gap-5">
        {state.status === 'loading' && <p className="font-display text-5xl font-extrabold text-mist">{t.loading}</p>}
        {state.status === 'error' && (
          <div className="flex flex-col gap-4">
            <p className="font-display text-5xl font-extrabold text-coral">{t.noForecast}</p>
            <p className="max-w-[50ch]">{t.loadFailed(state.message)}</p>
            <button type="button" onClick={retry} className="self-start rounded-[8px] bg-foam px-4 py-2 font-semibold text-abyss hover:bg-glass">
              {t.tryAgain}
            </button>
          </div>
        )}

        {state.status === 'ready' && ranked.length > 0 && <CoastHero t={t} ranked={ranked} now={now} fetchedS={fetchedS!} />}

        {state.status === 'ready' && (
          <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-display text-[34px] leading-none font-extrabold sm:text-[40px]">{t.home.title}</h2>
              <p className="mt-1.5 text-sm text-mist">
                {t.home.count(ranked.length)}
                {favourites.length === 0 && ` · ${t.home.starHint}`}
              </p>
            </div>
            <div role="tablist" aria-label={t.home.showAs} className="flex rounded-[8px] border border-line p-0.5 text-sm font-medium">
              {(['list', 'map'] as const).map((v) => (
                <button
                  key={v}
                  role="tab"
                  type="button"
                  aria-selected={view === v}
                  onClick={() => choose(v)}
                  className={`h-9 rounded-[6px] px-4 ${view === v ? 'bg-foam text-abyss' : 'text-mist hover:text-foam'}`}
                >
                  {v === 'list' ? t.home.list : t.home.map}
                </button>
              ))}
            </div>
          </div>
        )}

        {state.status === 'ready' && view === 'list' && (
          <>
            {favourites.length > 0 && <SpotGroup t={t} title={t.home.yourSpots} spots={favourites} onStar={toggle} />}
            <SpotGroup t={t} title={favourites.length ? t.home.otherSpots : null} spots={others} onStar={toggle} />
          </>
        )}
        {state.status === 'ready' && view === 'map' && (
          <ErrorBoundary name="Map" fallback={<SectionFailed what="the map" />}>
            <Suspense fallback={<div className="h-[62dvh] rounded-[10px] border border-line bg-card" aria-hidden />}>
              <SpotMap spots={ranked} label={t.home.mapLabel} />
            </Suspense>
          </ErrorBoundary>
        )}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------- hero: the coast right now

function CoastHero({ t, ranked, now, fetchedS }: { t: Strings; ranked: RankedSpot[]; now: number; fetchedS: number }) {
  const best = ranked[0]
  const v = best.score?.value ?? 1
  const h = best.hour
  const dark = h != null && !h.isDay
  const design = designFor(best.spot.id)
  const name = shortName(best)
  const also = ranked.slice(1).filter((s) => s.score?.value === v && v >= 2).map(shortName)
  const period = h ? (h.swellPeriod ?? h.wavePeriod) : null
  const dir = h ? (h.swellDirection ?? h.waveDirection) : null
  const rel = h?.windDirection != null ? windRelation(h.windDirection, best.spot.beachOrientation) : null
  const showBest = !dark && v >= 2
  const meta = [`${t.home.coastNow} · ${wd(t, now, LOCAL_TZ)} ${dayOfMonth(now, LOCAL_TZ)} · ${hhmm(now, LOCAL_TZ)}`, `${t.updated} ${hhmm(fetchedS, LOCAL_TZ)}`]

  return (
    <section aria-label={t.home.coastNow} className="relative isolate overflow-hidden rounded-[10px] border border-line">
      <HeroPhoto src={showBest ? (design?.photo ?? null) : null} thumb={design?.thumb} slug={best.spot.id} t={t} />
      <div className="relative flex min-h-[420px] flex-col gap-5 p-5 sm:min-h-[460px] sm:p-10">
        <p className="font-mono text-[11px] tracking-[0.08em] text-stone2 uppercase">{meta.join(' · ')}</p>
        <div className="mt-auto flex flex-col gap-4">
          {showBest ? (
            <>
              <p className="font-mono text-xs tracking-[0.1em] text-stone2 uppercase">{t.home.bestNow}</p>
              <h1
                className="font-display leading-[0.88] font-extrabold uppercase"
                // Fits the name on one line: ~0.52 em per capital in this condensed face.
                style={{ fontSize: `clamp(40px, calc((100vw - 80px) / ${(name.length * 0.52).toFixed(2)}), 136px)` }}
              >
                {name}
              </h1>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Pips value={v} size={12} />
                <span className="font-mono text-lg tnum">
                  {v} {t.outOf}
                </span>
                <span className={`text-lg font-bold ${VERDICT_TEXT[v]}`}>{t.scale[v]}</span>
                {best.score?.source === 'ai' && (
                  <span className="rounded-[6px] border border-accent px-2 py-0.5 text-xs font-medium text-accent">{t.aiCorrected}</span>
                )}
              </div>
              {h && (
                <p className="max-w-[56ch] font-mono text-sm leading-relaxed text-stone2 sm:text-[15px]">
                  {num(h.waveHeight)} m · {num(period, 0)} s{dir != null && ` · ${windName(dir)}`}
                  {h.windSpeed != null && ` — ${rel ? t.rel[rel] : ''} ${Math.round(h.windSpeed)} km/h`}
                  {h.windDirection != null && ` (${windName(h.windDirection)})`}
                </p>
              )}
              {also.length > 0 && also.length <= 2 && <p className="text-[15px] text-stone2">{t.home.alsoGood(also.join(', '))}</p>}
            </>
          ) : (
            <>
              <h1 className="font-display text-[76px] leading-[0.88] font-extrabold uppercase sm:text-[136px]">{dark ? t.home.night : t.home.flat}</h1>
              <p className="max-w-[48ch] text-[15px] text-stone2">{dark ? t.home.nightSub : t.home.flatSub}</p>
            </>
          )}
          <div className="border-t border-line/80 pt-4">
            <a
              href={spotPath(best.spot.id)}
              onClick={linkClick}
              className="inline-flex h-11 items-center rounded-[8px] bg-accent px-4 text-[15px] font-semibold text-abyss hover:bg-foam"
            >
              {t.home.open(name)}
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- spot cards

function SpotGroup({ t, title, spots, onStar }: { t: Strings; title: string | null; spots: RankedSpot[]; onStar: (id: string) => void }) {
  if (!spots.length) return null
  return (
    <section aria-label={title ?? t.allSpots} className="flex flex-col gap-3">
      {title && <h3 className="font-mono text-[11px] tracking-[0.1em] text-mist uppercase">{title}</h3>}
      <ul className="grid gap-3 lg:grid-cols-2 lg:gap-4">
        {spots.map((s) => (
          <SpotCard key={s.spot.id} t={t} s={s} onStar={onStar} />
        ))}
      </ul>
    </section>
  )
}

const SpotCard = memo(function SpotCard({ t, s, onStar }: { t: Strings; s: RankedSpot; onStar: (id: string) => void }) {
  const design = designFor(s.spot.id)
  const name = shortName(s)
  const beach = design?.beach ?? splitName(s.spot.name).beach
  const h = s.hour
  const v = s.score?.value
  const period = h ? (h.swellPeriod ?? h.wavePeriod) : null
  const rel = h?.windDirection != null ? windRelation(h.windDirection, s.spot.beachOrientation) : null
  const [imgFailed, setImgFailed] = useState(false)
  const img = design?.thumb ?? design?.photo

  return (
    <li className="relative flex overflow-hidden rounded-[10px] border border-line bg-card transition-colors hover:border-mist">
      {/* Photo strip (in colour here: no text sits on it). */}
      <div className="relative w-24 shrink-0 bg-inner sm:w-40" aria-hidden>
        {img && !imgFailed && (
          <img src={img} alt="" loading="lazy" decoding="async" onError={() => setImgFailed(true)} className="absolute inset-0 size-full object-cover saturate-[.85]" />
        )}
        {v && (
          <span className={`absolute top-2.5 left-2.5 grid size-11 place-items-center rounded-[8px] font-display text-[28px] leading-none font-extrabold ${BAR_BG[v]}`}>
            {v}
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2.5 p-3.5 sm:p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {/* The whole card opens the spot (stretched link); the star stays its own button. */}
            <a
              href={spotPath(s.spot.id)}
              onClick={linkClick}
              className="font-display text-[28px] leading-none font-extrabold after:absolute after:inset-0 after:content-[''] sm:text-[32px]"
            >
              {name}
            </a>
            {beach && <p className="mt-1 truncate text-xs text-mist">{beach}</p>}
          </div>
          <button
            type="button"
            onClick={() => onStar(s.spot.id)}
            aria-pressed={s.favourite}
            aria-label={s.favourite ? t.home.removeFav(name) : t.home.addFav(name)}
            className={`relative z-10 -mt-1 -mr-1 grid size-10 shrink-0 place-items-center rounded-[8px] hover:bg-inner ${s.favourite ? 'text-accent' : 'text-mist'}`}
          >
            <IconStar size={20} filled={s.favourite} />
          </button>
        </div>

        {v ? (
          <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
            <span className={`font-bold ${VERDICT_TEXT[v]}`}>{t.scale[v]}</span>
            {s.score?.source === 'ai' && <span className="text-xs text-accent">{t.aiCorrected}</span>}
            {h && !h.isDay && <span className="text-xs text-mist">{t.home.afterDark}</span>}
          </p>
        ) : (
          <p className="text-sm text-mist">{t.home.noData}</p>
        )}

        {h && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[13px] tnum">
            <span>
              {num(h.waveHeight)} m · {num(period, 0)} s
            </span>
            {h.windSpeed != null && (
              <span className={`flex items-center gap-1 ${rel ? REL_TEXT[rel] : 'text-mist'}`}>
                {h.windDirection != null && <IconArrow size={13} rotate={(h.windDirection + 180) % 360} />}
                {Math.round(h.windSpeed)} km/h
              </span>
            )}
            {rel && <span className={`rounded-[6px] px-1.5 py-px font-sans text-[11px] font-bold ${REL_TAG[rel]}`}>{t.rel[rel]}</span>}
          </p>
        )}

        {s.next.length > 1 && (
          <div className="flex items-end gap-1" aria-label={t.home.nextHours}>
            {s.next.map(({ hour, value }, i) => (
              <div key={hour.time} className="flex flex-1 flex-col items-center gap-1">
                <span
                  className={`flex w-full items-start justify-center rounded-[3px] pt-0.5 font-mono text-[10px] font-medium ${BAR_BG[value]} ${hour.isDay ? '' : 'night-hatch opacity-60'}`}
                  style={{ height: 10 + value * 5 }}
                  aria-label={`${hh(hour.time, LOCAL_TZ)}: ${value} / 5`}
                >
                  {value}
                </span>
                <span className={`font-mono text-[10px] ${i === 0 ? 'text-foam' : 'text-mist'}`}>{i === 0 ? t.home.now : hh(hour.time, LOCAL_TZ)}</span>
              </div>
            ))}
          </div>
        )}

        <CrowdLine t={t} crowd={s.crowd} reports={s.reports} />
      </div>
    </li>
  )
})

/** Crowd from today's surfer reports (cams can't count people yet). */
function CrowdLine({ t, crowd, reports }: { t: Strings; crowd: Crowd | null; reports: number }) {
  if (!crowd) return <span className="text-[11px] text-mist">{t.home.crowdNone}</span>
  const level = CROWD_LEVEL[crowd]
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-stone2">
      <span aria-hidden className="flex gap-[2px]">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`size-1.5 rounded-full ${i < level ? 'bg-foam' : 'bg-line'}`} />
        ))}
      </span>
      {t.home.crowd(t.rate.crowds[crowd], reports)}
    </span>
  )
}
