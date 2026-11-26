import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  COMMENT_MAX,
  CROWDS,
  SURFACES,
  RatingError,
  WAVE_SIZES,
  contradiction,
  nextAllowedAt,
  saveRating,
  whenOptions,
  type Crowd,
  type Surface,
  type WeatherAnswer,
  WEATHER_ANSWERS,
  type WaveSize,
  type WhenOption,
} from '../lib/ratings'
import { hhmm, localDate } from '../lib/format'
import { NEAR_BEACH_KM, checkNearBeach, type NearBeachResult } from '../lib/nearBeach'
import type { Forecast } from '../lib/openMeteo'
import type { Spot } from '../lib/spot'
import type { Score, ScoreValue } from '../scoring/types'
import { IconCheck } from '../spot/Icons'
import { useLang, weekdayIn, type Strings } from '../spot/strings'
import { SCORE_CLASS } from './ScoreChip'

const SCORE_BG = SCORE_CLASS as Record<number, string>

interface Props {
  open: boolean
  onClose: () => void
  spot: Spot
  forecast: Forecast
  scores: Map<number, Score>
  now: number
  /** Called after a rating is saved (e.g. to refresh today's reports). */
  onSent?: () => void
  /** 1-5 already picked on the page before the sheet opened (still editable). */
  initialOverall?: ScoreValue | null
}

/**
 * "I surfed" sheet. Fastest path is 3 taps: open, pick 1-5, send ("when" is preselected to the
 * latest session slot). Everything else is optional. No account: an anonymous device id is sent.
 */
export function RateSheet(props: Props) {
  return <AnimatePresence>{props.open && <Sheet {...props} />}</AnimatePresence>
}

type Status = { kind: 'editing' } | { kind: 'sending' } | { kind: 'error'; message: string } | { kind: 'done'; forecast: Score; said: ScoreValue }

function Sheet({ onClose, spot, forecast, scores, now, onSent, initialOverall }: Props) {
  const [, page] = useLang()
  const t = page.rate
  // Options are fixed while the sheet is open, so a minute tick doesn't reshuffle them.
  const [openedAt] = useState(now)
  const options = useMemo(() => whenOptions(forecast, openedAt), [forecast, openedAt])
  const latest = [...options].filter((o) => o.available).sort((a, b) => b.surfedAt - a.surfedAt)[0]

  const [when, setWhen] = useState<WhenOption | undefined>(latest)
  const [overall, setOverall] = useState<ScoreValue | null>(initialOverall ?? null)
  const [waveSize, setWaveSize] = useState<WaveSize | null>(null)
  const [surface, setSurface] = useState<Surface | null>(null)
  const [weather, setWeather] = useState<WeatherAnswer | null>(null)
  const [crowd, setCrowd] = useState<Crowd | null>(null)
  const [comment, setComment] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'editing' })
  const [location, setLocation] = useState<NearBeachResult | 'checking' | null>(null)
  // 3 per device per day: known locally from earlier sends, or learned from the database.
  const [limitUntil, setLimitUntil] = useState<number | 'unknown' | null>(() => nextAllowedAt(openedAt * 1000))

  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    heading.current?.focus()
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKey)
      opener?.focus()
    }
  }, [onClose])

  const shownScore = when?.hour ? scores.get(when.hour.time) : undefined
  const clash = contradiction(waveSize, overall)
  const canSend = !!when?.available && !!when.hour && !!shownScore && overall != null && !clash && status.kind !== 'sending'

  const checkLocation = async () => {
    setLocation('checking')
    setLocation(await checkNearBeach(spot))
  }

  const send = async () => {
    if (!canSend || !when || !shownScore || overall == null) return
    setStatus({ kind: 'sending' })
    try {
      const nearBeach = location === 'near' ? true : null // only "yes" is ever stored
      await saveRating(spot, forecast, shownScore, { when, overall, waveSize, surface, crowd, weather, comment, nearBeach })
      setStatus({ kind: 'done', forecast: shownScore, said: overall })
      onSent?.()
    } catch (err) {
      if (err instanceof RatingError && err.kind === 'limit') setLimitUntil('unknown')
      setStatus({ kind: 'error', message: errorText(t, err) })
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <m.div
        className="absolute inset-0 bg-abyss/75"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        aria-hidden
      />
      <m.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rate-title"
        className="relative flex max-h-[92dvh] w-full max-w-3xl flex-col rounded-t-3xl border-t border-kelp bg-deep"
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 380, damping: 38 }}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2 sm:px-8">
          <h2 id="rate-title" ref={heading} tabIndex={-1} className="font-display text-3xl font-extrabold outline-none">
            {status.kind === 'done' ? t.thanks : t.title}
          </h2>
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 text-mist hover:text-foam">
            {t.close}
          </button>
        </div>

        {status.kind === 'done' ? (
          <ThankYou t={t} forecast={status.forecast} said={status.said} onDone={onClose} />
        ) : limitUntil != null ? (
          <div className="px-5 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-8">
            <p className="max-w-[44ch] text-lg">
              {t.limit}{' '}
              {typeof limitUntil === 'number' ? whenAgain(page, Math.ceil(limitUntil / 1000), openedAt, forecast.timezone) : t.againTomorrow}
            </p>
            <button type="button" onClick={onClose} className="mt-6 w-full rounded-2xl bg-foam py-3.5 font-display text-2xl font-extrabold text-abyss">
              {t.ok}
            </button>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-5 pb-4 sm:px-8">
              <Group title={t.when}>
                {(['today', 'yesterday'] as const).map((day) => (
                  <div key={day} className="mb-2.5">
                    <span className="mb-1 block text-sm text-mist">{day === 'today' ? t.today : t.yesterday}</span>
                    <div role="radiogroup" aria-label={day === 'today' ? t.today : t.yesterday} className="grid grid-cols-4 gap-1.5">
                      {options
                        .filter((o) => o.day === day)
                        .map((o) => (
                          <Chip
                            key={o.slot}
                            selected={when?.day === o.day && when.slot === o.slot}
                            disabled={!o.available}
                            onClick={() => setWhen(o)}
                            small
                          >
                            {t.slots[o.slot] ?? o.label}
                          </Chip>
                        ))}
                    </div>
                  </div>
                ))}
              </Group>

              <Group title={t.overall}>
                <div role="radiogroup" aria-label={t.overallAria} className="grid grid-cols-5 gap-1.5">
                  {([1, 2, 3, 4, 5] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      aria-checked={overall === v}
                      aria-label={`${v} ${page.scale[v]}`}
                      onClick={() => setOverall(v)}
                      className={`flex flex-col items-center rounded-xl py-2 transition-[transform,box-shadow] duration-150 ${SCORE_BG[v]} ${
                        overall === v ? 'scale-105 ring-2 ring-foam ring-offset-2 ring-offset-deep' : overall ? 'opacity-60' : ''
                      }`}
                    >
                      <span className="font-display text-4xl leading-none font-extrabold">{v}</span>
                      <span className="text-xs font-semibold">{page.scale[v]}</span>
                    </button>
                  ))}
                </div>
              </Group>

              <p className="mt-6 mb-1 text-sm text-mist">{t.optional}</p>
              <Group title={t.waveSize}>
                <Choices label={t.waveSize} names={t.sizes} items={WAVE_SIZES} value={waveSize} onChange={setWaveSize} cols="grid-cols-3 sm:grid-cols-6" />
              </Group>
              <Group title={t.surface}>
                <Choices label={t.surface} names={t.surfaces} items={SURFACES} value={surface} onChange={setSurface} cols="grid-cols-3" />
              </Group>
              <Group title={t.weatherQ}>
                <Choices label={t.weatherQ} names={t.weatherAnswers} items={WEATHER_ANSWERS} value={weather} onChange={setWeather} cols="grid-cols-[2fr_1fr]" />
                <p className="mt-1.5 text-xs text-mist">{t.weatherNote}</p>
              </Group>
              <Group title={t.crowd}>
                <Choices label={t.crowd} names={t.crowds} items={CROWDS} value={crowd} onChange={setCrowd} cols="grid-cols-4" />
              </Group>
              <Group title={t.atBeachQ}>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={checkLocation}
                    disabled={location === 'checking' || location === 'near'}
                    className="rounded-xl border border-kelp px-3 py-2.5 font-semibold hover:border-mist disabled:opacity-60"
                  >
                    {location === 'checking' ? (
                      t.checking
                    ) : location === 'near' ? (
                      <span className="flex items-center gap-1.5">
                        {t.atBeach} <IconCheck size={16} />
                      </span>
                    ) : (
                      t.checkPhone
                    )}
                  </button>
                  <p className="min-w-0 flex-1 text-sm text-mist" aria-live="polite">
                    {location === 'near' && t.near}
                    {location === 'far' && t.far(NEAR_BEACH_KM)}
                    {location === 'denied' && t.denied}
                    {location === 'unavailable' && t.unavailable}
                    {(location == null || location === 'checking') && t.locHelp(NEAR_BEACH_KM)}
                  </p>
                </div>
              </Group>
              <Group title={t.comment}>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value.slice(0, COMMENT_MAX))}
                  rows={2}
                  placeholder={t.commentPh}
                  className="w-full resize-none rounded-xl border border-kelp bg-abyss/60 px-3 py-2 placeholder:text-mist/60 focus:border-mist focus:outline-none"
                />
                <p className="flex justify-between text-xs text-mist">
                  <span>{t.commentNote}</span>
                  <span className="tabular-nums">
                    {comment.length}/{COMMENT_MAX}
                  </span>
                </p>
              </Group>
            </div>

            <div className="border-t border-kelp px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-8">
              {clash ? (
                <p role="alert" className="mb-2 text-sm text-coral">
                  {t.clash}
                </p>
              ) : (
                status.kind === 'error' && (
                  <p role="alert" className="mb-2 text-sm text-coral">
                    {status.message}
                  </p>
                )
              )}
              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                className="w-full rounded-2xl bg-glass py-3.5 font-display text-2xl font-extrabold text-abyss transition-opacity disabled:opacity-40"
              >
                {status.kind === 'sending' ? t.sending : overall == null ? t.pick : t.send}
              </button>
              <p className="mt-2 text-center text-xs text-mist">
                {t.noAccount}{' '}
                <a href="#privacy" className="underline underline-offset-2 hover:text-foam">
                  {t.whatWeSave}
                </a>
              </p>
            </div>
          </>
        )}
      </m.div>
    </div>
  )
}

/** "You can rate again at 19:00" today, "… on Sat at 19:00" another day, in the page language. */
function whenAgain(page: Strings, unix: number, now: number, tz: string): string {
  const time = hhmm(unix, tz)
  return localDate(unix, tz) === localDate(now, tz) ? page.rate.againAt(time) : page.rate.againOn(weekdayIn(page, unix, tz), time)
}

/** A rating error in the page language (the database's own message stays in the console). */
function errorText(t: Strings['rate'], err: unknown): string {
  if (err instanceof RatingError) {
    if (err.kind === 'limit') return t.errLimit
    if (err.kind === 'contradiction') return t.clash
    if (err.kind === 'too_old') return t.errTooOld
    if (err.message.includes('too slow')) return t.errSlow
    if (err.message.includes('no forecast')) return t.errNoForecast
  }
  console.warn('Rating not saved', err)
  return t.errOther
}

function ThankYou({ t, forecast, said, onDone }: { t: Strings['rate']; forecast: Score; said: ScoreValue; onDone: () => void }) {
  return (
    <div className="px-5 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-8">
      <div className="flex items-end gap-6">
        <Big label={forecast.source === 'ai' ? t.aiForecast : t.forecast} value={forecast.value} />
        <span className="pb-6 font-display text-4xl text-mist" aria-hidden>
          {t.vs}
        </span>
        <Big label={t.you} value={said} />
      </div>
      <p className="mt-5 max-w-[40ch] text-lg">
        {t.thanksLine(forecast.value, said)}
      </p>
      <button
        type="button"
        onClick={onDone}
        className="mt-6 w-full rounded-2xl bg-foam py-3.5 font-display text-2xl font-extrabold text-abyss"
      >
        {t.done}
      </button>
    </div>
  )
}

function Big({ label, value }: { label: string; value: ScoreValue }) {
  return (
    <div className="flex flex-col items-start">
      <span className="text-sm text-mist">{label}</span>
      <m.span
        className={`mt-1 grid size-24 place-items-center rounded-2xl font-display text-7xl font-black ${SCORE_BG[value]}`}
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 18 }}
      >
        {value}
      </m.span>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="mt-4">
      <legend className="mb-2 font-semibold">{title}</legend>
      {children}
    </fieldset>
  )
}

function Choices<T extends string>({
  label,
  names,
  items,
  value,
  onChange,
  cols,
}: {
  label: string
  /** Labels in the page language, by id (falls back to the English label). */
  names: Record<string, string>
  items: readonly { id: T; label: string }[]
  value: T | null
  onChange: (v: T | null) => void
  cols: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`grid gap-1.5 ${cols}`}>
      {items.map((it) => (
        // Tapping the chosen chip again clears it (these answers are optional).
        <Chip key={it.id} selected={value === it.id} onClick={() => onChange(value === it.id ? null : it.id)}>
          {names[it.id] ?? it.label}
        </Chip>
      ))}
    </div>
  )
}

function Chip({
  selected,
  disabled,
  onClick,
  small,
  children,
}: {
  selected: boolean
  disabled?: boolean
  onClick: () => void
  small?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-xl border px-2 font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-30 ${
        small ? 'py-2 text-sm' : 'py-2.5'
      } ${selected ? 'border-foam bg-foam text-abyss' : 'border-kelp text-foam hover:border-mist'}`}
    >
      {children}
    </button>
  )
}
