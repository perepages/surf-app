// "Alert me" bottom sheet: pick a minimum score; get a push when the forecast (AI when there is
// a model) says this spot will be that good in daylight within the next 24 h.

import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { SCORE_WORD, ScoreBadge } from './ScoreChip'
import { disableAlert, enableAlert, isIos, pushSupport, type PushSupport } from '../lib/push'
import { SCORE_LABELS, type ScoreValue } from '../scoring/types'

interface Props {
  open: boolean
  onClose: () => void
  spotId: string
  town: string
  /** Current alert for this spot (min score), or null. */
  current: number | null
  onChanged: (minScore: number | null) => void
}

export function AlertSheet(props: Props) {
  return <AnimatePresence>{props.open && <Sheet {...props} />}</AnimatePresence>
}

const CHOICES: ScoreValue[] = [3, 4, 5]

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string } | { kind: 'done'; text: string }

function Sheet({ onClose, spotId, town, current, onChanged }: Props) {
  const [support] = useState<PushSupport>(pushSupport)
  const [min, setMin] = useState<ScoreValue>((current as ScoreValue | null) ?? 4)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

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

  const turnOn = async () => {
    setStatus({ kind: 'busy' })
    try {
      await enableAlert(spotId, min) // asks for permission: must run straight from the tap
      onChanged(min)
      setStatus({ kind: 'done', text: `Done. You’ll get a notification when ${town} looks ${min}/5 or better.` })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }
  const turnOff = async () => {
    setStatus({ kind: 'busy' })
    try {
      await disableAlert(spotId)
      onChanged(null)
      setStatus({ kind: 'done', text: `Alert for ${town} turned off.` })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <m.div className="absolute inset-0 bg-abyss/75" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} aria-hidden />
      <m.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="alert-title"
        className="relative flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-y-auto rounded-t-3xl border-t border-kelp bg-deep"
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 380, damping: 38 }}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2 sm:px-8">
          <h2 id="alert-title" ref={heading} tabIndex={-1} className="font-display text-3xl font-extrabold outline-none">
            Alert me for {town}
          </h2>
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 text-mist hover:text-foam">
            Close
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 pt-1 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-8">
          {support.ok ? (
            status.kind === 'done' ? (
              <>
                <p role="status" className="text-lg">
                  {status.text}
                </p>
                <button type="button" onClick={onClose} className="self-start rounded-lg bg-foam px-5 py-2.5 font-semibold text-abyss hover:bg-glass">
                  OK
                </button>
              </>
            ) : (
              <>
                <p className="max-w-[46ch] text-mist">
                  Get a notification when the forecast (AI-corrected when there is a model) says {town} will be at least this good in
                  daylight within the next 24 hours. At most one every 12 hours.
                </p>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 text-sm font-semibold">Tell me when it’s at least</legend>
                  <div className="grid grid-cols-3 gap-2">
                    {CHOICES.map((v) => (
                      <label
                        key={v}
                        className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-2xl border py-3 has-focus-visible:outline-2 has-focus-visible:outline-glass ${min === v ? 'border-foam bg-card' : 'border-line hover:border-mist'}`}
                      >
                        <input type="radio" name="min-score" value={v} checked={min === v} onChange={() => setMin(v)} className="sr-only" />
                        <ScoreBadge value={v} />
                        <span className="text-sm font-semibold">{SCORE_LABELS[v]}</span>
                        <span className={`text-xs font-bold ${SCORE_WORD[v].className}`}>{v === 5 ? 'only epic' : `${v}+`}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {status.kind === 'error' && (
                  <p role="alert" className="rounded-lg border border-coral/50 px-3 py-2 text-sm text-coral-text">
                    {status.message}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={turnOn}
                    disabled={status.kind === 'busy' || current === min}
                    className="rounded-lg bg-foam px-5 py-2.5 font-semibold text-abyss hover:bg-glass disabled:opacity-50"
                  >
                    {status.kind === 'busy' ? 'Saving…' : current == null ? 'Turn on alert' : current === min ? 'Alert is on' : 'Change alert'}
                  </button>
                  {current != null && (
                    <button type="button" onClick={turnOff} disabled={status.kind === 'busy'} className="rounded-lg px-4 py-2.5 font-semibold text-coral-text hover:bg-card">
                      Turn off
                    </button>
                  )}
                </div>
                <p className="text-xs text-mist">
                  Your phone’s push address and the score you picked are stored so we can send the alert. Turning it off deletes them.
                </p>
              </>
            )
          ) : (
            <Unsupported reason={support.reason} />
          )}
        </div>
      </m.div>
    </div>
  )
}

function Unsupported({ reason }: { reason: Exclude<PushSupport, { ok: true }>['reason'] }) {
  if (reason === 'ios-install') {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-lg">On iPhone, alerts only work from the app on your Home Screen.</p>
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-mist">
          <li>
            In Safari, tap <span className="font-semibold text-foam">Share</span> (the square with an arrow).
          </li>
          <li>
            Tap <span className="font-semibold text-foam">Add to Home Screen</span>, then <span className="font-semibold text-foam">Add</span>.
          </li>
          <li>Open the app from the new icon and tap “Alert me” again.</li>
        </ol>
        <p className="text-xs text-mist">Needs iOS 16.4 or newer.</p>
      </div>
    )
  }
  if (reason === 'denied') {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-lg">Notifications are blocked for this app.</p>
        <p className="text-mist">
          {isIos()
            ? 'Open Settings > Notifications, find this app and allow notifications, then come back.'
            : 'Tap the icon left of the address (or long-press the app icon > App info > Notifications) and allow notifications, then come back.'}
        </p>
      </div>
    )
  }
  if (reason === 'not-configured') {
    return <p className="text-lg">Alerts aren’t switched on for this version of the app yet.</p>
  }
  return <p className="text-lg">This browser can’t receive alerts. On iPhone you need iOS 16.4 or newer; on Android use Chrome, Firefox or Samsung Internet.</p>
}
