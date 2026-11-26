// The spot page: photo hero with the day's verdict, readings for the picked hour (waves, period,
// wind + rose, power, tide), hour by hour, why this score, rate, next days, forecast vs surfers.
// Scores come from resolveScore (same as everywhere). Strings: ./strings.ts (en / ca / es).
// Per-spot presentation settings (photo, beach facing, swell window): ./spotDesign.ts.

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { ErrorBoundary, SectionFailed } from '../components/ErrorBoundary'
import { useFavourites } from '../lib/favourites'
import { dayOfMonth, hh, hhmm, localDate, num, tideCm } from '../lib/format'
import { wavePower } from '../lib/conditions'
import { PowerMeter, TideMini, tideRangeCm } from '../components/Glyphs'
import { buildChartRows } from '../lib/chartData'
import { CHART_DAYS } from '../lib/reports'
import { compass } from '../lib/geo'
import { windRelation } from '../lib/geo'
import type { ModelInfo } from '../lib/modelInfo'
import type { ForecastDay, HourConditions } from '../lib/forecast'
import { usePrefs } from '../lib/prefs'
import { readLocalAlerts, syncAlerts } from '../lib/push'
import type { ReportsState } from '../lib/reports'
import { fmt, seriesOf, windowFactor } from '../scoring/physics'
import { resolveScore } from '../scoring/resolveScore'
import type { Score, ScoreValue } from '../scoring/types'
import type { useSpotForecast } from '../useSpotForecast'
import { IconArrow, IconBell, IconCheck, IconCross, IconDash, IconStar, IconWarn } from './Icons'
import { designFor, type SpotDesign } from './spotDesign'
import { useLang, windName, type Lang, type Strings } from './strings'
import { BAR_BG, HeroPhoto, kmhToKn, Pips, REL_STROKE, REL_TAG, REL_TEXT, splitName, TopBar, VERDICT_TEXT, wd } from './ui'

const RateSheet = lazy(() => import('../components/RateSheet').then((m) => ({ default: m.RateSheet })))
const AlertSheet = lazy(() => import('../components/AlertSheet').then((m) => ({ default: m.AlertSheet })))
const ForecastVsSurfers = lazy(() => import('../components/ForecastVsSurfers'))

type ReadyState = Extract<ReturnType<typeof useSpotForecast>['state'], { status: 'ready' }>
type Scores = Map<number, Score>

interface Props extends ReadyState {
  now: number
  online: boolean
  reports: ReportsState
  model: ModelInfo | null
  onRatingSent: () => void
  /** Open the rating form at once (the /rate short link). */
  openRatingAtStart?: boolean
}

/** Daylight hours of a day (all hours if the day has no daylight data). */
const daylight = (day: ForecastDay) => {
  const light = day.hours.filter((h) => h.isDay)
  return light.length ? light : day.hours
}

const scoreOf = (scores: Scores, h: HourConditions): ScoreValue => scores.get(h.time)?.value ?? 1
const hourNum = (h: HourConditions, tz: string) => Number(hh(h.time, tz))
/** Supabase starts the collect job every 3 h at :07 UTC (migration 22); the new file reaches
 *  phones ~15 min later. GitHub's own hourly schedule sometimes updates sooner. */
const PUBLISH_EVERY_S = 3 * 3600
const PUBLISH_AFTER_S = 22 * 60
/** Next guaranteed publish after both now and the current file's time. */
function nextPublish(now: number, fetchedS: number): number {
  const after = Math.max(now, fetchedS)
  const at = Math.floor(after / PUBLISH_EVERY_S) * PUBLISH_EVERY_S + PUBLISH_AFTER_S
  return at > after ? at : at + PUBLISH_EVERY_S
}

/** Highest score among `hours`, and the first run of hours that has it. */
function bestRun(hours: HourConditions[], scores: Scores) {
  if (!hours.length) return null
  const best = Math.max(...hours.map((h) => scoreOf(scores, h))) as ScoreValue
  const i0 = hours.findIndex((h) => scoreOf(scores, h) === best)
  let i1 = i0
  while (i1 + 1 < hours.length && scoreOf(scores, hours[i1 + 1]) === best) i1++
  return { best, start: hours[i0], end: hours[i1], all: i0 === 0 && i1 === hours.length - 1 }
}

export function SpotScreen(props: Props) {
  const { spot, forecast, stale, refreshing, ai, now, online, reports, model, onRatingSent, openRatingAtStart } = props
  const [lang, t] = useLang()
  const tz = forecast.timezone
  const design = designFor(spot.id)
  const facing = design?.facing ?? spot.beachOrientation
  const swellWindow =
    design?.swellWindow ??
    (spot.swellWindowMin != null && spot.swellWindowMax != null ? { from: spot.swellWindowMin, to: spot.swellWindowMax } : null)
  const { prefs } = usePrefs()

  // Same scores as the current page.
  const scores = useMemo(() => {
    const series = seriesOf(forecast.days.flatMap((d) => d.hours))
    const m = new Map<number, Score>()
    for (const d of forecast.days) for (const h of d.hours) m.set(h.time, resolveScore(h, spot, ai.get(h.time), series, prefs))
    return m
  }, [forecast, spot, ai, prefs])

  const today = localDate(now, tz)
  const days = useMemo(() => {
    const first = forecast.days.findIndex((d) => d.date >= today)
    return first <= 0 ? forecast.days : forecast.days.slice(first)
  }, [forecast, today])
  const allHours = useMemo(() => days.flatMap((d) => d.hours), [days])
  const nowIdx = Math.max(0, allHours.findIndex((h) => now < h.time + 3600))
  const nowHour = allHours[nowIdx]
  const todayIdx = Math.max(0, days.findIndex((d) => d.hours.some((h) => h.time === nowHour?.time)))

  // Day verdict: the best daylight hour still to come today, else tomorrow.
  const verdict = useMemo(() => {
    const todayDay = days[todayIdx]
    const left = todayDay ? daylight(todayDay).filter((h) => h.isDay && h.time + 3600 > now) : []
    const dayIdx = left.length ? todayIdx : todayIdx + 1
    const day = days[dayIdx]
    const run = bestRun(left.length ? left : day ? daylight(day).filter((h) => h.isDay) : [], scores)
    let nextGood: HourConditions | null = null
    if (run && run.best <= 2) {
      for (const d of days.slice(dayIdx + 1)) {
        const r = bestRun(daylight(d).filter((h) => h.isDay), scores)
        if (r && r.best >= 3) {
          nextGood = r.start
          break
        }
      }
    }
    return { dayIdx, run, nextGood }
  }, [days, todayIdx, now, scores])

  // Selected hour (bars are tappable). Default: the verdict's best hour.
  const [picked, setPicked] = useState<number | null>(null)
  const focusTime = picked ?? verdict.run?.start.time ?? nowHour?.time
  const focus = allHours.find((h) => h.time === focusTime) ?? nowHour
  const focusDayIdx = Math.max(0, days.findIndex((d) => d.hours.some((h) => h.time === focus?.time)))
  const focusScore = focus ? scores.get(focus.time) : undefined

  // Rating sheet (unchanged behaviour), alert sheet, settings sheet.
  const [rating, setRating] = useState(!!openRatingAtStart)
  const [ratingLoaded, setRatingLoaded] = useState(!!openRatingAtStart)
  const [picked15, setPicked15] = useState<ScoreValue | null>(null)
  const openRating = useCallback(() => {
    setRatingLoaded(true)
    setRating(true)
  }, [])
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
  const { ids: favIds, toggle } = useFavourites()
  const favourite = favIds.has(spot.id)
  const { town } = splitName(spot.name)

  const name = design?.name ?? town
  useEffect(() => {
    document.title = `${name} · Surf`
  }, [name])

  const fetchedS = Math.floor(forecast.fetchedAt / 1000)
  // "Forecast vs surfers" / "Who called it?" (the last section of the current page).
  const chartRows = useMemo(
    () => buildChartRows(forecast, spot, ai, reports.status === 'ready' ? reports.daily : [], today, CHART_DAYS),
    [forecast, spot, ai, reports, today],
  )
  const nextDaysList = days.slice(todayIdx + 1)

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 pt-4 sm:px-10 sm:pt-6">
      <TopBar current={spot.id} />

      {(!online || (stale && !refreshing)) && (
        <p role="status" className="mt-4 border-l-2 border-accent pl-3 text-sm text-stone2">
          {!online ? t.offline(hhmm(fetchedS, tz)) : t.stale(hhmm(fetchedS, tz))}
        </p>
      )}

      <main className="mt-5 grid grid-cols-1 gap-4 sm:mt-8 lg:grid-cols-12 lg:gap-5">
        {/* Hero: the one dominant element. */}
        <Hero
          className="lg:col-span-8"
          t={t}
          design={design}
          slug={spot.id}
          name={name}
          tz={tz}
          now={now}
          fetchedS={fetchedS}
          dayLabel={verdict.dayIdx === todayIdx ? t.today : t.tomorrow}
          run={verdict.run}
          nextGood={verdict.nextGood}
          score={verdict.run ? scores.get(verdict.run.start.time) : undefined}
          facing={facing}
          learned={model?.active ? t.learned(model.nRatings, model.scope === 'general' ? model.nSpots : null) : null}
          alertMin={alertMin}
          favourite={favourite}
          onRate={openRating}
          onAlert={() => {
            setAlertLoaded(true)
            setAlertOpen(true)
          }}
          onSave={() => toggle(spot.id)}
          dark={nowHour && !nowHour.isDay ? (forecast.days.map((d) => d.sunrise).find((s): s is number => s != null && s > now) ?? null) : null}
        />

        {focus && (
          <Readings
            className="lg:col-span-4"
            t={t}
            hour={focus}
            next={allHours[allHours.indexOf(focus) + 1]}
            day={days[focusDayIdx]}
            tz={tz}
            facing={facing}
            window={swellWindow}
            confirmed={design?.confirmed ?? false}
          />
        )}

        {days.length > 0 && (
          <HourByHour
            className="lg:col-span-12"
            t={t}
            lang={lang}
            days={days.slice(todayIdx, todayIdx + 4)}
            dayIdx={Math.max(0, focusDayIdx - todayIdx)}
            scores={scores}
            tz={tz}
            facing={facing}
            selected={focus?.time ?? null}
            nowTime={nowHour?.time ?? null}
            onPick={setPicked}
          />
        )}

        {focus && focusScore && (
          <Why className="lg:col-span-12" t={t} hour={focus} score={focusScore} facing={facing} win={swellWindow} tz={tz} model={model} />
        )}

        <RateBlock
          className="lg:col-span-12"
          t={t}
          picked={picked15}
          setPicked={setPicked15}
          onOpen={openRating}
          nowScore={nowHour ? scores.get(nowHour.time) : undefined}
          nowLabel={nowHour ? hhmm(nowHour.time, tz) : ''}
          reports={reports}
        />

        {nextDaysList.length > 0 && (
          <NextDays
            className="lg:col-span-12"
            t={t}
            days={nextDaysList}
            scores={scores}
            tz={tz}
            onPick={(time) => {
              setPicked(time)
              document.getElementById('hours')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
          />
        )}
        {chartRows.length > 1 && (
          <NearScreen className="lg:col-span-12 [&>section]:mx-0 [&>section]:rounded-[10px]">
            <ErrorBoundary name="Who called it" fallback={<SectionFailed what="who called it" />}>
              <Suspense fallback={<div className="h-[34rem]" aria-hidden />}>
                <ForecastVsSurfers rows={chartRows} model={model} />
              </Suspense>
            </ErrorBoundary>
          </NearScreen>
        )}
      </main>

      {ratingLoaded && (
        <ErrorBoundary name="Rating form" fallback={<SectionFailed what="the rating form" />}>
          <Suspense fallback={null}>
            <RateSheet
              open={rating}
              onClose={() => setRating(false)}
              spot={spot}
              forecast={forecast}
              scores={scores}
              now={now}
              onSent={onRatingSent}
              initialOverall={picked15}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {alertLoaded && (
        <ErrorBoundary name="Alert" fallback={<SectionFailed what="the alert settings" />}>
          <Suspense fallback={null}>
            <AlertSheet open={alertOpen} onClose={() => setAlertOpen(false)} spotId={spot.id} town={name} current={alertMin} onChanged={setAlertMin} />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  )
}

/** Renders children once the slot is within ~300 px of the screen (the chart is a big download). */
function NearScreen({ className, children }: { className: string; children: React.ReactNode }) {
  const [near, setNear] = useState(false)
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setNear(true)
          io.disconnect()
        }
      },
      { rootMargin: '300px 0px' },
    )
    io.observe(el)
  }, [])
  return (
    <div ref={near ? undefined : ref} className={className}>
      {near ? children : <div className="h-[34rem]" aria-hidden />}
    </div>
  )
}

// ---------------------------------------------------------------- hero

function Hero(p: {
  className: string
  t: Strings
  design: SpotDesign | undefined
  slug: string
  name: string
  tz: string
  now: number
  fetchedS: number
  dayLabel: string
  run: ReturnType<typeof bestRun>
  nextGood: HourConditions | null
  score: Score | undefined
  facing: number
  learned: string | null
  alertMin: number | null
  favourite: boolean
  onRate: () => void
  onAlert: () => void
  onSave: () => void
  dark: number | null
}) {
  const { t, run, tz } = p
  const best = run?.best ?? 1
  // Same thresholds as the app's GO / MAYBE / SKIP: 3+ is a GO, 5 is EPIC.
  const headline = best === 5 ? t.epic : best >= 3 ? t.worth : best === 2 ? t.maybe : t.notToday
  const second =
    best >= 2 && run
      ? t.goAt(hhmm(run.start.time, tz))
      : p.nextGood
        ? t.nextGood(wd(t, p.nextGood.time, tz), hhmm(p.nextGood.time, tz))
        : t.noneSoon
  const h = run?.start
  const period = h ? (h.swellPeriod ?? h.wavePeriod) : null
  const dir = h ? (h.swellDirection ?? h.waveDirection) : null
  const rel = h?.windDirection != null ? windRelation(h.windDirection, p.facing) : null
  const meta = [
    `${p.dayLabel} · ${wd(t, p.now, tz)} ${dayOfMonth(p.now, tz)}`,
    `${t.updated} ${hhmm(p.fetchedS, tz)}`,
    `${t.nextUpdate} ${hhmm(nextPublish(p.now, p.fetchedS), tz)}`,
  ]
  return (
    <section aria-label={p.name} className={`relative isolate overflow-hidden rounded-[10px] border border-line ${p.className}`}>
      <HeroPhoto src={p.design?.photo ?? null} thumb={p.design?.thumb} slug={p.slug} t={t} />
      <div className="relative flex min-h-[460px] flex-col gap-5 p-5 sm:min-h-[520px] sm:p-10">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div>
            <h2 className="font-display text-[38px] leading-none font-extrabold sm:text-[44px]">{p.name}</h2>
            <p className="mt-1 text-sm text-stone2">{p.design ? `${p.design.beach} · ${p.design.municipality}` : ''}</p>
          </div>
          <p className="font-mono text-[11px] tracking-[0.08em] text-stone2 uppercase">{meta.join(' · ')}</p>
        </div>

        <div className="mt-auto flex flex-col gap-4">
          <h1 className="font-display text-[76px] leading-[0.88] font-extrabold uppercase sm:text-[136px]">
            {headline}
            <span className={`mt-2 block text-[38px] leading-[1] normal-case sm:text-[60px] ${VERDICT_TEXT[best]}`}>{second}</span>
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Pips value={best} size={12} />
            <span className="font-mono text-lg tnum" aria-label={`${best} of 5`}>
              {best} {t.outOf}
            </span>
            <span className={`text-lg font-bold ${VERDICT_TEXT[best]}`}>{t.scale[best]}</span>
            {p.score?.source === 'ai' && (
              <span className="rounded-[6px] border border-accent px-2 py-0.5 text-xs font-medium text-accent">{t.aiCorrected}</span>
            )}
            {p.score?.source === 'ai' && p.score.simple && <span className="text-sm text-stone2">{t.rulesSaid(p.score.simple.value)}</span>}
          </div>
          {h && (
            <p className="max-w-[56ch] font-mono text-sm leading-relaxed text-stone2 sm:text-[15px]">
              {num(h.waveHeight)} m · {num(period, 0)} s{dir != null && ` · ${compass(dir)}`}
              {h.windSpeed != null && ` — ${rel ? t.rel[rel] : ''} ${Math.round(h.windSpeed)} km/h`}
              {h.windDirection != null && ` (${windName(h.windDirection)})`}
            </p>
          )}
          {p.score?.source === 'ai' && <p className="max-w-[56ch] text-[15px]">{p.score.reason}</p>}
          {p.score?.source === 'ai' && p.learned && <p className="text-sm text-stone2">{p.learned}</p>}
          {p.dark != null && <p className="text-sm text-stone2">{t.darkNow(hhmm(p.dark, tz))}</p>}

          <div className="flex flex-wrap items-center gap-2 border-t border-line/80 pt-4">
            <button
              type="button"
              onClick={p.onRate}
              className="flex h-11 items-center rounded-[8px] bg-accent px-4 text-[15px] font-semibold text-abyss hover:bg-foam"
            >
              {t.rateOpen}
            </button>
            <button
              type="button"
              onClick={p.onAlert}
              aria-haspopup="dialog"
              className={`flex h-11 items-center gap-2 rounded-[8px] border px-3.5 text-[15px] font-medium hover:border-foam ${p.alertMin != null ? 'border-accent text-accent' : 'border-[#3e6a72] text-foam'}`}
            >
              <IconBell size={17} />
              {p.alertMin != null ? t.alertOn(p.alertMin) : t.alertMe}
            </button>
            <button
              type="button"
              onClick={p.onSave}
              aria-pressed={p.favourite}
              className={`flex h-11 items-center gap-2 rounded-[8px] px-3 text-[15px] font-medium hover:text-foam ${p.favourite ? 'text-accent' : 'text-stone2'}`}
            >
              <IconStar size={17} filled={p.favourite} />
              {p.favourite ? t.saved : t.save}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- readings (waves, period, wind + rose, power, tide)

function Readings(p: {
  className: string
  t: Strings
  hour: HourConditions
  next: HourConditions | undefined
  day: ForecastDay | undefined
  tz: string
  facing: number
  window: { from: number; to: number } | null
  confirmed: boolean
}) {
  const { t, hour, day, tz, facing } = p
  const heights = day ? daylight(day).map((h) => h.waveHeight).filter((x): x is number => x != null) : []
  const period = hour.swellPeriod ?? hour.wavePeriod
  const dir = hour.swellDirection ?? hour.waveDirection
  const rel = hour.windDirection != null ? windRelation(hour.windDirection, facing) : null
  const periodNote = period == null ? null : period < 6 ? t.periodShort : period < 9 ? t.periodMid : t.periodLong
  const power = wavePower(hour)
  const trend = p.next?.tide != null && hour.tide != null ? (p.next.tide > hour.tide ? t.rising : t.falling) : null
  const range = day ? tideRangeCm(day.hours) : null

  const cell = 'flex flex-col gap-1 bg-card px-4 py-4 sm:px-5'
  const label = 'text-xs font-medium text-mist'
  const big = 'font-mono text-[28px] leading-none font-medium tnum sm:text-[32px]'
  const unit = 'ml-1 text-base text-mist'

  return (
    <section aria-label={t.at(hhmm(hour.time, tz))} className={`flex flex-col overflow-hidden rounded-[10px] border border-line bg-card ${p.className}`}>
      <p className="border-b border-line px-5 py-3 font-mono text-[11px] tracking-[0.08em] text-mist uppercase">
        {wd(t, hour.time, tz)} · {t.at(hhmm(hour.time, tz))}
      </p>
      <dl className="grid flex-1 grid-cols-2 gap-px bg-line">
        {hour.waveHeight != null && (
          <div className={cell}>
            <dt className={label}>{t.waves}</dt>
            <dd className={big}>
              {num(hour.waveHeight)}
              <span className={unit}>m</span>
            </dd>
            {heights.length > 1 && <dd className="text-[12px] text-stone2">{t.rangeToday(num(Math.min(...heights)), num(Math.max(...heights)))}</dd>}
          </div>
        )}
        {period != null && (
          <div className={cell}>
            <dt className={label}>{t.period}</dt>
            <dd className={big}>
              {num(period, 0)}
              <span className={unit}>s</span>
            </dd>
            <dd className="text-[12px] leading-snug text-stone2">
              {periodNote}
              {dir != null && <span className="block text-mist">{t.from(compass(dir), windName(dir))}</span>}
            </dd>
          </div>
        )}

        {/* Wind, with the rose right where wind is first read. */}
        {hour.windSpeed != null && (
          <div className={`${cell} col-span-2`}>
            <dt className={label}>{t.wind}</dt>
            <dd className="flex items-center justify-between gap-3">
              <div className="flex flex-col gap-2">
                <span className={big}>
                  {Math.round(hour.windSpeed)}
                  <span className={unit}>km/h</span>
                  <span className="ml-2 text-base text-mist">{kmhToKn(hour.windSpeed)} kn</span>
                </span>
                {rel && <span className={`self-start rounded-[6px] px-2 py-0.5 text-xs font-bold ${REL_TAG[rel]}`}>{t.rel[rel]}</span>}
                {hour.windDirection != null && (
                  <span className={`flex items-center gap-1 text-sm ${rel ? REL_TEXT[rel] : 'text-mist'}`}>
                    <IconArrow size={15} rotate={(hour.windDirection + 180) % 360} />
                    {windName(hour.windDirection)} · {compass(hour.windDirection)}
                  </span>
                )}
                {hour.windGusts != null && <span className="font-mono text-[12px] text-mist">{t.gust(Math.round(hour.windGusts))}</span>}
              </div>
              <MiniRose t={t} facing={facing} window={p.window} swell={dir} wind={hour.windDirection} rel={rel} />
            </dd>
            <dd>
              <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-stone2" aria-label={t.keyTitle}>
                <li className="flex items-center gap-1.5">
                  <span className="h-[3px] w-4 rounded bg-foam" aria-hidden />
                  {t.keySwell}
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="flex h-[5px] w-6 overflow-hidden rounded" aria-hidden>
                    <span className="flex-1 bg-glass" />
                    <span className="flex-1 bg-sand" />
                    <span className="flex-1 bg-coral" />
                  </span>
                  {t.keyWind}
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="size-3 rounded-[2px] border border-foam/50 bg-foam/15" aria-hidden />
                  {t.keyWindow}
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="w-4 border-t border-dashed border-mist" aria-hidden />
                  {t.keyFacing}
                </li>
              </ul>
            </dd>
            {!p.confirmed && (
              <dd className="flex items-center gap-1.5 font-mono text-[10px] text-mist">
                <IconWarn size={12} /> {t.roseToConfirm}
              </dd>
            )}
          </div>
        )}

        {power && (
          <div className={cell}>
            <dt className={label}>{t.power}</dt>
            <dd className={big}>
              {power.kw.toFixed(1)}
              <span className={unit}>kW/m</span>
            </dd>
            <dd className="flex items-center gap-2 text-[12px] font-semibold">
              <PowerMeter level={power.level} />
              {t.powerWords[power.level]}
            </dd>
          </div>
        )}
        {hour.tide != null && (
          <div className={cell}>
            <dt className={label}>{t.tide}</dt>
            <dd className="font-mono text-lg leading-none font-medium tnum">
              {tideCm(hour.tide)} cm <span className="text-xs text-mist">{trend}</span>
            </dd>
            {day && (
              <dd className="max-w-full overflow-hidden">
                <TideMini hours={day.hours} now={hour.time} timezone={tz} />
              </dd>
            )}
            {range != null && <dd className="text-[11px] text-mist">{t.tideRange(range)}</dd>}
          </div>
        )}
      </dl>
    </section>
  )
}

// ---------------------------------------------------------------- wind rose (small, inside the wind reading)

const C = 120
const pt = (deg: number, r: number) => {
  const a = (deg * Math.PI) / 180
  return [C + r * Math.sin(a), C - r * Math.cos(a)] as const
}
const f1 = (n: number) => n.toFixed(1)

function sectorPath(from: number, to: number, r0: number, r1: number) {
  const span = (((to - from) % 360) + 360) % 360
  const large = span > 180 ? 1 : 0
  const [ax, ay] = pt(from, r1)
  const [bx, by] = pt(to, r1)
  const [cx, cy] = pt(to, r0)
  const [dx, dy] = pt(from, r0)
  return `M${f1(ax)} ${f1(ay)} A${r1} ${r1} 0 ${large} 1 ${f1(bx)} ${f1(by)} L${f1(cx)} ${f1(cy)} A${r0} ${r0} 0 ${large} 0 ${f1(dx)} ${f1(dy)} Z`
}

function Arrow({ deg, color, width }: { deg: number; color: string; width: number }) {
  // Comes FROM deg: from the outer ring towards the centre.
  const [x0, y0] = pt(deg, 74)
  const [x1, y1] = pt(deg, 16)
  const [lx, ly] = pt(deg + 16, 30)
  const [rx, ry] = pt(deg - 16, 30)
  return (
    <g stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d={`M${f1(x0)} ${f1(y0)} L${f1(x1)} ${f1(y1)}`} />
      <path d={`M${f1(lx)} ${f1(ly)} L${f1(x1)} ${f1(y1)} L${f1(rx)} ${f1(ry)}`} />
    </g>
  )
}

/**
 * Outer band = which winds help (green: offshore, from the land), which spoil (red: onshore,
 * from the sea), cross-shore in sand. Inner ring = the swell window. Arrows: wind (coloured by
 * how it hits this beach) and swell (foam).
 */
function MiniRose(p: { t: Strings; facing: number; window: { from: number; to: number } | null; swell: number | null; wind: number | null; rel: string | null }) {
  const { t, facing } = p
  const off = (facing + 180) % 360
  const [bx, by] = pt(facing, 50)
  const aria = t.roseAria(
    p.swell != null ? `${compass(p.swell)} (${windName(p.swell)})` : t.none,
    p.wind != null ? `${compass(p.wind)} (${windName(p.wind)})${p.rel ? `, ${t.rel[p.rel]}` : ''}` : t.none,
  )
  return (
    <svg viewBox="0 0 240 240" className="size-[148px] shrink-0 sm:size-[168px]" role="img" aria-label={aria}>
      {/* wind quality band */}
      <path d={sectorPath(off - 45, off + 45, 80, 94)} fill="var(--pos)" fillOpacity=".75" />
      <path d={sectorPath(facing - 45, facing + 45, 80, 94)} fill="var(--neg)" fillOpacity=".75" />
      <path d={sectorPath(facing + 45, off - 45, 80, 94)} fill="var(--accent)" fillOpacity=".3" />
      <path d={sectorPath(off + 45, facing - 45, 80, 94)} fill="var(--accent)" fillOpacity=".3" />
      <circle cx={C} cy={C} r="78" fill="var(--inner)" stroke="var(--line)" />
      {p.window && <path d={sectorPath(p.window.from, p.window.to, 50, 78)} fill="var(--stone)" fillOpacity=".14" stroke="var(--stone)" strokeOpacity=".5" />}
      <path d={`M${C} ${C} L${f1(bx)} ${f1(by)}`} stroke="var(--muted)" strokeWidth="1.2" strokeDasharray="3 4" />
      {(
        [
          ['N', 0],
          ['E', 90],
          ['S', 180],
          ['W', 270],
        ] as const
      ).map(([n, d]) => {
        const [x, y] = pt(d, 108)
        return (
          <text key={n} x={x} y={y + 6} textAnchor="middle" fill="var(--muted)" style={{ font: '700 17px var(--font-ui)' }}>
            {n}
          </text>
        )
      })}
      {p.swell != null && <Arrow deg={p.swell} color="var(--stone)" width={4} />}
      {p.wind != null && <Arrow deg={p.wind} color={p.rel ? REL_STROKE[p.rel] : 'var(--stone)'} width={6} />}
      <circle cx={C} cy={C} r="4" fill="var(--stone)" />
    </svg>
  )
}

// ---------------------------------------------------------------- hour by hour

function HourByHour(p: {
  className: string
  t: Strings
  lang: Lang
  days: ForecastDay[]
  dayIdx: number
  scores: Scores
  tz: string
  facing: number
  selected: number | null
  nowTime: number | null
  onPick: (time: number) => void
}) {
  const { t, tz, scores } = p
  const [dayIdx, setDayIdx] = useState(p.dayIdx)
  useEffect(() => setDayIdx(p.dayIdx), [p.dayIdx])
  const day = p.days[Math.min(dayIdx, p.days.length - 1)]
  const hours = day.hours.filter((h) => {
    const n = hourNum(h, tz)
    return n >= 6 && n <= 21
  })
  const light = hours.filter((h) => h.isDay)
  const run = bestRun(light, scores)
  const showRun = run && run.best >= 2 && !run.all
  const runStart = showRun ? hours.indexOf(run.start) : -1
  const runEnd = showRun ? hours.indexOf(run.end) : -1

  // Sea breeze (embat): first daylight hour from 10h where the wind turns onshore at >= 12 km/h.
  let embat = -1
  hours.forEach((h, i) => {
    if (embat >= 0 || i === 0 || !h.isDay || hourNum(h, tz) < 10) return
    const prev = hours[i - 1]
    const on = (x: HourConditions) => x.windDirection != null && x.windSpeed != null && x.windSpeed >= 12 && windRelation(x.windDirection, p.facing) === 'onshore'
    if (on(h) && !on(prev)) embat = i
  })

  const cols = hours.length
  return (
    <section id="hours" aria-labelledby="hours-title" className={`rounded-[10px] border border-line bg-card p-5 sm:p-7 ${p.className}`}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="hours-title" className="font-display text-[34px] leading-none font-extrabold sm:text-[40px]">
            {t.hourByHour}
          </h2>
          <p className="mt-1.5 text-sm text-mist">{t.tapHour}</p>
        </div>
        <div className="flex gap-1" role="tablist">
          {p.days.map((d, i) => {
            const noon = d.hours[Math.floor(d.hours.length / 2)].time
            return (
              <button
                key={d.date}
                type="button"
                role="tab"
                aria-selected={i === dayIdx}
                onClick={() => setDayIdx(i)}
                className={`h-10 rounded-[8px] px-3 text-sm font-medium ${i === dayIdx ? 'bg-foam text-abyss' : 'text-mist hover:text-foam'}`}
              >
                {i === 0 ? t.today : `${wd(t, noon, tz)} ${dayOfMonth(noon, tz)}`}
              </button>
            )
          })}
        </div>
      </div>

      <div className="mt-6">
        <div>
          {/* Bars */}
          <div className="grid items-end gap-1 sm:gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {hours.map((h) => {
              const v = scoreOf(scores, h)
              const sel = h.time === p.selected
              const isNow = h.time === p.nowTime
              return (
                <button
                  key={h.time}
                  type="button"
                  onClick={() => p.onPick(h.time)}
                  aria-pressed={sel}
                  aria-label={`${hhmm(h.time, tz)}: ${v} / 5, ${t.scale[v]}${h.isDay ? '' : `, ${t.night}`}`}
                  className={`relative flex items-start justify-center rounded-[4px] pt-1 font-mono text-[11px] font-medium sm:text-xs ${BAR_BG[v]} ${h.isDay ? '' : 'opacity-60'} ${sel ? 'outline-2 outline-offset-2 outline-foam' : ''}`}
                  style={{ height: `calc(var(--bar-base) + ${v} * var(--bar-step))` }}
                >
                  {!h.isDay && <span className="night-hatch absolute inset-0 rounded-[4px]" aria-hidden />}
                  <span className="relative">{v}</span>
                  {isNow && <span className="absolute -top-2.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-foam" aria-hidden />}
                </button>
              )
            })}
          </div>
          {/* Hours */}
          <div className="mt-1.5 grid gap-1 sm:gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }} aria-hidden>
            {hours.map((h, i) => (
              <span key={h.time} className={`text-center font-mono text-[10px] sm:text-[11px] ${h.time === p.selected ? 'text-foam' : 'text-mist'}`}>
                {i % 2 === 0 || cols < 12 ? hh(h.time, tz) : ''}
                <span className="hidden sm:inline">{i % 2 === 0 || cols < 12 ? '' : hh(h.time, tz)}</span>
              </span>
            ))}
          </div>
          {/* Best window bracket + embat marker */}
          <div className="relative mt-2 h-10" style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {showRun && (
              <div className="flex flex-col" style={{ gridColumn: `${runStart + 1} / ${runEnd + 2}`, gridRow: 1 }}>
                <span className="h-2 border-x-[1.5px] border-b-[1.5px] border-accent" />
                <span className="mt-1 font-mono text-[11px] whitespace-nowrap text-accent">
                  {t.bestWindow(hh(run.start.time, tz), hh(run.end.time + 3600, tz))}
                </span>
              </div>
            )}
            {embat >= 0 && (
              <div className="flex flex-col items-start" style={{ gridColumn: `${embat + 1} / span 4`, gridRow: showRun ? 2 : 1 }}>
                <span className="h-2 border-l-[1.5px] border-dashed border-stone2" />
                <span className="font-mono text-[11px] whitespace-nowrap text-stone2">{t.embat}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-line pt-4 text-xs text-stone2" aria-label="Key">
        {[1, 2, 3, 4, 5].map((v) => (
          <li key={v} className="flex items-center gap-1.5">
            <span className={`grid size-5 place-items-center rounded-[4px] font-mono text-[10px] ${BAR_BG[v]}`}>{v}</span>
            {t.scale[v]}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="night-hatch size-5 rounded-[4px] border border-line" />
          {t.night}
        </li>
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------- why this score (Waves / Shape / Comfort + reasons)

type Kind = 'pos' | 'neg' | 'neu'
interface Reason {
  kind: Kind
  title: string
  sub: string | null
}

function reasonsFor(t: Strings, hour: HourConditions, score: Score, facing: number, win: { from: number; to: number } | null): Reason[] {
  const out: Reason[] = []
  const f = score.physics?.features
  const waves = score.parts?.waves
  if (hour.waveHeight != null && waves != null) {
    const sub = f && f.breakingHeight > 0 ? t.whySizeSub(num(f.breakingHeight)) : null
    if (waves < 1.5) out.push({ kind: 'neg', title: t.whyFlat, sub: `${t.whySize(num(hour.waveHeight))}. ${sub ?? ''}`.trim() })
    else out.push({ kind: waves >= 3 ? 'pos' : 'neu', title: t.whySize(num(hour.waveHeight)), sub })
  }
  if (hour.windSpeed != null) {
    const kmh = Math.round(hour.windSpeed)
    if (kmh < 8) out.push({ kind: 'pos', title: t.whyCalm(kmh), sub: t.whyCalmSub })
    else if (hour.windDirection != null) {
      const rel = windRelation(hour.windDirection, facing)
      const kind: Kind = rel === 'offshore' ? 'pos' : rel === 'onshore' && kmh >= 12 ? 'neg' : 'neu'
      out.push({
        kind,
        title: t.whyWind(t.rel[rel], kmh, windName(hour.windDirection)),
        sub: rel === 'offshore' ? t.whyWindSubGood : rel === 'onshore' ? t.whyWindSubBad : t.whyWindSubCross,
      })
    }
  }
  // Same swell direction as the readings and the rose (primary swell, else total sea).
  const dir = hour.swellDirection ?? hour.waveDirection
  const size = hour.swellHeight ?? hour.waveHeight ?? 0
  if (dir != null && size > 0.1) {
    const wf = windowFactor(dir, { beachOrientation: facing, swellWindowMin: win?.from ?? null, swellWindowMax: win?.to ?? null })
    if (wf < 0.3) out.push({ kind: 'neg', title: t.whyBlocked(compass(dir)), sub: t.whyBlockedSub })
    else if (wf >= 0.9) out.push({ kind: 'pos', title: t.whyOpen(compass(dir)), sub: t.whyOpenSub })
  }
  const period = hour.swellPeriod ?? hour.wavePeriod
  if (period != null) {
    const kind: Kind = period < 6 ? 'neg' : period >= 9 ? 'pos' : 'neu'
    out.push({ kind, title: t.whyPeriod(Math.round(period)), sub: period < 6 ? t.periodShort : period >= 9 ? t.periodLong : t.periodMid })
  }
  return out.slice(0, 4)
}

const KIND_ICON: Record<Kind, { Icon: typeof IconCheck; cls: string }> = {
  pos: { Icon: IconCheck, cls: 'text-glass border-glass/60' },
  neg: { Icon: IconCross, cls: 'text-coral-text border-coral/60' },
  neu: { Icon: IconDash, cls: 'text-stone2 border-line' },
}

const PART_BG = ['', 'bg-s1', 'bg-s2', 'bg-s3', 'bg-s4', 'bg-s5']

function Part({ name, value, note }: { name: string; value: number; note: string }) {
  const v = Math.min(5, Math.max(1, Math.round(value)))
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-mist">{name}</span>
        <span className="font-mono text-lg leading-none font-medium tnum">{fmt(value, 1)}</span>
      </div>
      <div className="h-2 rounded-full bg-inner" role="img" aria-label={`${name} ${fmt(value, 1)} / 5: ${note}`}>
        <div className={`h-full rounded-full ${PART_BG[v]}`} style={{ width: `${((value - 1) / 4) * 100}%`, minWidth: '6%' }} />
      </div>
      <span className="text-[12px] text-stone2">{note}</span>
    </div>
  )
}

function Why({ className, t, hour, score, facing, win, tz, model }: { className: string; t: Strings; hour: HourConditions; score: Score; facing: number; win: { from: number; to: number } | null; tz: string; model: ModelInfo | null }) {
  const reasons = reasonsFor(t, hour, score, facing, win)
  const trust = model?.active && model.compared > 0 ? model : null
  const filled = trust ? Math.round((trust.aiCloser / trust.compared) * 10) : 0
  const ph = score.physics
  const parts = score.parts
  const dark = ph?.features.daylight === false
  const causes = ph?.comfortCauses ?? []
  const comfortKey = dark ? 'dark' : causes.includes('rain') ? 'rain' : causes.includes('drizzle') ? 'drizzle' : causes.includes('cold_air') || causes.includes('cold_water') ? 'cold' : 'dry'
  const thunder = hour.weatherCode != null && [95, 96, 99].includes(hour.weatherCode)
  const rainy = (hour.precipProb ?? 0) > 20 || (hour.precipitation ?? 0) >= 0.1
  const mm = hour.precipitation != null && hour.precipitation >= 0.1 ? fmt(hour.precipitation, 1) : null
  const weather = thunder ? t.whyStorm : rainy ? t.rainLine(hour.precipProb ?? null, mm) : null
  const temps = [
    hour.airTemp != null ? t.air(fmt(hour.airTemp)) : null,
    hour.seaTemp != null ? t.water(fmt(hour.seaTemp)) : null,
    ph?.wetsuit ? t.wetsuit(ph.wetsuit) : null,
  ].filter(Boolean)
  const wavesIdx = !parts ? 0 : parts.waves < 1.5 ? 0 : parts.waves < 2.5 ? 1 : parts.waves < 3.5 ? 2 : parts.waves < 4.5 ? 3 : 4
  const shapeIdx = !parts ? 0 : parts.shape >= 4.5 ? 3 : parts.shape >= 3.5 ? 2 : parts.shape >= 2.5 ? 1 : 0

  return (
    <section aria-labelledby="why-title" className={`rounded-[10px] border border-line bg-card p-5 sm:p-7 ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="why-title" className="font-display text-[34px] leading-none font-extrabold sm:text-[40px]">
          {t.why}
        </h2>
        <span className="font-mono text-[12px] text-mist">
          {hhmm(hour.time, tz)} · {score.value} {t.outOf}
        </span>
      </div>
      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10">
        <div className="flex flex-col gap-4">
          {parts && (
            <div className="grid grid-cols-3 gap-4">
              <Part name={t.waves} value={parts.waves} note={t.wavesNotes[wavesIdx]} />
              <Part name={t.partShape} value={parts.shape} note={t.shapeNotes[shapeIdx]} />
              <Part name={t.partComfort} value={parts.comfort} note={t.comfortNotes[comfortKey]} />
            </div>
          )}
          {ph && ph.warnings.length > 0 && (
            <ul className="flex flex-col gap-1.5" aria-label={t.safety}>
              {ph.warnings.map((w) => (
                <li key={w.kind} role="alert" className="flex items-start gap-2 rounded-[8px] border border-coral/50 bg-coral/10 px-3 py-2 text-sm font-semibold text-coral-text">
                  <IconWarn size={16} className="mt-0.5 shrink-0" /> {w.text}
                </li>
              ))}
            </ul>
          )}
          {ph?.mess && (
            <div className="rounded-[8px] border border-sand/40 px-3 py-2">
              <p className="text-xs font-semibold tracking-[0.04em] text-sand uppercase">{t.messTitle}</p>
              <p className="text-sm leading-snug">{ph.mess}</p>
            </div>
          )}
          {(weather || temps.length > 0) && (
            <p className="text-sm text-stone2">
              {weather && <span className={`font-semibold ${thunder ? 'text-coral-text' : 'text-foam'}`}>{weather}</span>}
              {weather && temps.length > 0 && ' · '}
              {temps.join(' · ')}
            </p>
          )}
        </div>
        <div>
          <ul className="divide-y divide-line lg:-mt-3.5">
            {reasons.map((r, i) => {
              const k = KIND_ICON[r.kind]
              return (
                <li key={i} className="flex gap-3.5 py-3.5">
                  <span className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border ${k.cls}`}>
                    <k.Icon size={15} />
                    <span className="sr-only">{r.kind === 'pos' ? 'for' : r.kind === 'neg' ? 'against' : 'neutral'}</span>
                  </span>
                  <div>
                    <p className="font-semibold">{r.title}</p>
                    {r.sub && <p className="mt-0.5 text-sm leading-snug text-stone2">{r.sub}</p>}
                  </div>
                </li>
              )
            })}
          </ul>
          {trust && (
            <div className="mt-2 border-t border-line pt-4">
              <p className="text-sm font-semibold">{t.trustTitle}</p>
              <p className="mt-1 text-sm text-stone2">{t.trustLine(trust.aiCloser, trust.compared, trust.days)}</p>
              <div className="mt-2.5 flex gap-1" aria-hidden>
                {Array.from({ length: 10 }, (_, i) => (
                  <span key={i} className={`h-3 w-2 rounded-[2px] ${i < filled ? 'bg-accent' : 'bg-inner ring-1 ring-line'}`} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- rate

function RateBlock(p: {
  className: string
  t: Strings
  picked: ScoreValue | null
  setPicked: (v: ScoreValue) => void
  onOpen: () => void
  nowScore: Score | undefined
  nowLabel: string
  reports: ReportsState
}) {
  const { t } = p
  const today = p.reports.status === 'ready' ? p.reports.today : null
  return (
    <section aria-labelledby="rate-title" className={`grid gap-5 rounded-[10px] border border-line p-5 sm:p-7 lg:grid-cols-[1fr_auto] lg:items-center ${p.className}`}>
      <div>
        <h2 id="rate-title" className="font-display text-[34px] leading-none font-extrabold sm:text-[40px]">
          {t.rateTitle}
        </h2>
        <p className="mt-2 text-stone2">{t.rateSub}</p>
        {p.nowScore && <p className="mt-1 font-mono text-xs text-mist">{t.forecastSaid(p.nowScore.value, p.nowLabel)}</p>}
        {today && today.count >= 3 && today.avgOverall != null && (
          <p className="mt-1 font-mono text-xs text-mist">{t.reportsLine(today.count, today.avgOverall.toFixed(1))}</p>
        )}
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-2">
            {([1, 2, 3, 4, 5] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={p.picked === v}
                aria-label={`${v} / 5, ${t.scale[v]}`}
                onClick={() => p.setPicked(v)}
                className={`size-14 rounded-[8px] border font-mono text-xl font-medium tnum ${p.picked === v ? 'border-accent bg-accent text-abyss' : 'border-[#3e6a72] hover:border-foam'}`}
              >
                {v}
              </button>
            ))}
          </div>
          <div className="flex justify-between text-[11px] text-mist" aria-hidden>
            <span>{t.scale[1]}</span>
            <span>{t.scale[5]}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={p.onOpen}
          className="flex h-14 items-center rounded-[8px] bg-foam px-5 text-[15px] font-semibold text-abyss hover:bg-accent"
        >
          {t.rateOpen}
        </button>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- next days

function NextDays({ className, t, days, scores, tz, onPick }: { className: string; t: Strings; days: ForecastDay[]; scores: Scores; tz: string; onPick: (time: number) => void }) {
  return (
    <section aria-labelledby="next-title" className={`rounded-[10px] border border-line bg-card p-5 sm:p-7 ${className}`}>
      <h2 id="next-title" className="font-display text-[34px] leading-none font-extrabold sm:text-[40px]">
        {t.nextDays(days.length)}
      </h2>
      <ul className="mt-4 divide-y divide-line lg:grid lg:grid-cols-3 lg:gap-0 lg:divide-x lg:divide-y-0">
        {days.map((d) => {
          const run = bestRun(daylight(d).filter((h) => h.isDay), scores)
          if (!run) return null
          const noon = d.hours[Math.floor(d.hours.length / 2)].time
          const when = run.best <= 1 ? t.noGoodHour : run.all ? t.allDay : t.bestAt(hh(run.start.time, tz), hh(run.end.time + 3600, tz))
          return (
            <li key={d.date} className="lg:px-6 lg:first:pl-0">
              <button type="button" onClick={() => onPick(run.start.time)} className="flex w-full items-center gap-4 py-3.5 text-left hover:text-foam lg:flex-col lg:items-start lg:gap-2">
                <span className="w-16 shrink-0 lg:w-auto">
                  <span className="block font-semibold">{wd(t, noon, tz)}</span>
                  <span className="font-mono text-xs text-mist">{dayOfMonth(noon, tz)}</span>
                </span>
                <span className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                  <Pips value={run.best} />
                  <span className="text-sm font-semibold">{t.scale[run.best]}</span>
                </span>
                <span className="font-mono text-xs text-stone2">{when}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
