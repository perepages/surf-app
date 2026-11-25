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
import { hhmm, localDate, weekday } from '../lib/format'
import { NEAR_BEACH_KM, checkNearBeach, type NearBeachResult } from '../lib/nearBeach'
import type { Forecast } from '../lib/openMeteo'
import type { Spot } from '../lib/spot'
import { SCORE_LABELS, type Score, type ScoreValue } from '../scoring/types'
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
}

/**
 * "I surfed" sheet. Fastest path is 3 taps: open, pick 1-5, send ("when" is preselected to the
 * latest session slot). Everything else is optional. No account: an anonymous device id is sent.
 */
export function RateSheet(props: Props) {
  return <AnimatePresence>{props.open && <Sheet {...props} />}</AnimatePresence>
}

type Status = { kind: 'editing' } | { kind: 'sending' } | { kind: 'error'; message: string } | { kind: 'done'; forecast: Score; said: ScoreValue }

function Sheet({ onClose, spot, forecast, scores, now, onSent }: Props) {
  // Options are fixed while the sheet is open, so a minute tick doesn't reshuffle them.
  const [openedAt] = useState(now)
  const options = useMemo(() => whenOptions(forecast, openedAt), [forecast, openedAt])
  const latest = [...options].filter((o) => o.available).sort((a, b) => b.surfedAt - a.surfedAt)[0]

  const [when, setWhen] = useState<WhenOption | undefined>(latest)
  const [overall, setOverall] = useState<ScoreValue | null>(null)
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
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
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
            {status.kind === 'done' ? 'Thanks!' : 'How was it really?'}
          </h2>
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 text-mist hover:text-foam">
            Close
          </button>
        </div>

        {status.kind === 'done' ? (
          <ThankYou forecast={status.forecast} said={status.said} onDone={onClose} />
        ) : limitUntil != null ? (
          <div className="px-5 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-8">
            <p className="max-w-[44ch] text-lg">
              You’ve sent 3 ratings in the last 24 hours, which is the most one phone can send. Thanks!{' '}
              {typeof limitUntil === 'number'
                ? `You can rate again ${whenAgain(Math.ceil(limitUntil / 1000), openedAt, forecast.timezone)}.`
                : 'You can rate again tomorrow.'}
            </p>
            <button type="button" onClick={onClose} className="mt-6 w-full rounded-2xl bg-foam py-3.5 font-display text-2xl font-extrabold text-abyss">
              OK
            </button>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-5 pb-4 sm:px-8">
              <Group title="When">
                {(['today', 'yesterday'] as const).map((day) => (
                  <div key={day} className="mb-2.5">
                    <span className="mb-1 block text-sm text-mist">{day === 'today' ? 'Today' : 'Yesterday'}</span>
                    <div role="radiogroup" aria-label={day === 'today' ? 'Today' : 'Yesterday'} className="grid grid-cols-4 gap-1.5">
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
                            {o.label}
                          </Chip>
                        ))}
                    </div>
                  </div>
                ))}
              </Group>

              <Group title="Overall">
                <div role="radiogroup" aria-label="Overall, 1 to 5" className="grid grid-cols-5 gap-1.5">
                  {([1, 2, 3, 4, 5] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      aria-checked={overall === v}
                      aria-label={`${v} ${SCORE_LABELS[v]}`}
                      onClick={() => setOverall(v)}
                      className={`flex flex-col items-center rounded-xl py-2 transition-[transform,box-shadow] duration-150 ${SCORE_BG[v]} ${
                        overall === v ? 'scale-105 ring-2 ring-foam ring-offset-2 ring-offset-deep' : overall ? 'opacity-60' : ''
                      }`}
                    >
                      <span className="font-display text-4xl leading-none font-extrabold">{v}</span>
                      <span className="text-xs font-semibold">{SCORE_LABELS[v]}</span>
                    </button>
                  ))}
                </div>
              </Group>

              <p className="mt-6 mb-1 text-sm text-mist">Optional, but it helps:</p>
              <Group title="Wave size">
                <Choices label="Wave size" items={WAVE_SIZES} value={waveSize} onChange={setWaveSize} cols="grid-cols-3 sm:grid-cols-6" />
              </Group>
              <Group title="Surface">
                <Choices label="Surface" items={SURFACES} value={surface} onChange={setSurface} cols="grid-cols-3" />
              </Group>
              <Group title="Was the weather the problem?">
                <Choices label="Was the weather the problem?" items={WEATHER_ANSWERS} value={weather} onChange={setWeather} cols="grid-cols-[2fr_1fr]" />
                <p className="mt-1.5 text-xs text-mist">So a rainy day with good waves isn’t learned as bad waves.</p>
              </Group>
              <Group title="Crowd">
                <Choices label="Crowd" items={CROWDS} value={crowd} onChange={setCrowd} cols="grid-cols-4" />
              </Group>
              <Group title="At the beach?">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={checkLocation}
                    disabled={location === 'checking' || location === 'near'}
                    className="rounded-xl border border-kelp px-3 py-2.5 font-semibold hover:border-mist disabled:opacity-60"
                  >
                    {location === 'checking' ? 'Checking…' : location === 'near' ? 'At the beach ✓' : 'Check on this phone'}
                  </button>
                  <p className="min-w-0 flex-1 text-sm text-mist" aria-live="polite">
                    {location === 'near' && 'Your rating will say you were at the beach.'}
                    {location === 'far' && `Not within ${NEAR_BEACH_KM} km right now. That’s fine, nothing is saved about it.`}
                    {location === 'denied' && 'Location is blocked. That’s fine, nothing is saved about it.'}
                    {location === 'unavailable' && 'Couldn’t get a location. That’s fine, nothing is saved about it.'}
                    {(location == null || location === 'checking') &&
                      `Ratings from the beach count more. Your phone checks if you’re within ${NEAR_BEACH_KM} km; your position never leaves it.`}
                  </p>
                </div>
              </Group>
              <Group title="Comment">
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value.slice(0, COMMENT_MAX))}
                  rows={2}
                  placeholder="Sandbar shifted, rip by the pier…"
                  className="w-full resize-none rounded-xl border border-kelp bg-abyss/60 px-3 py-2 placeholder:text-mist/60 focus:border-mist focus:outline-none"
                />
                <p className="flex justify-between text-xs text-mist">
                  <span>Shown to others on today’s reports, without your name.</span>
                  <span className="tabular-nums">
                    {comment.length}/{COMMENT_MAX}
                  </span>
                </p>
              </Group>
            </div>

            <div className="border-t border-kelp px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-8">
              {clash ? (
                <p role="alert" className="mb-2 text-sm text-coral">
                  {clash}
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
                {status.kind === 'sending' ? 'Sending…' : overall == null ? 'Pick 1 to 5 to send' : 'Send rating'}
              </button>
              <p className="mt-2 text-center text-xs text-mist">
                No account needed. Sent with an anonymous device id.{' '}
                <a href="#privacy" className="underline underline-offset-2 hover:text-foam">
                  What we save
                </a>
              </p>
            </div>
          </>
        )}
      </m.div>
    </div>
  )
}

/** "at 19:00" today, "on Sat at 19:00" another day. */
function whenAgain(unix: number, now: number, tz: string): string {
  const time = `at ${hhmm(unix, tz)}`
  return localDate(unix, tz) === localDate(now, tz) ? time : `on ${weekday(unix, tz)} ${time}`
}

function ThankYou({ forecast, said, onDone }: { forecast: Score; said: ScoreValue; onDone: () => void }) {
  return (
    <div className="px-5 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-8">
      <div className="flex items-end gap-6">
        <Big label={forecast.source === 'ai' ? 'AI forecast' : 'Forecast'} value={forecast.value} />
        <span className="pb-6 font-display text-4xl text-mist" aria-hidden>
          vs
        </span>
        <Big label="You" value={said} />
      </div>
      <p className="mt-5 max-w-[40ch] text-lg">
        Forecast said {forecast.value}, you said {said} — thanks, this trains the AI.
      </p>
      <button
        type="button"
        onClick={onDone}
        className="mt-6 w-full rounded-2xl bg-foam py-3.5 font-display text-2xl font-extrabold text-abyss"
      >
        Done
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
  items,
  value,
  onChange,
  cols,
}: {
  label: string
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
          {it.label}
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
