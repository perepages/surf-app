// "Your surf" bottom sheet: I don't mind rain, level, max wave size. Saved on this phone only;
// changes the GO / MAYBE / SKIP and the warnings at once (every screen).

import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useRef } from 'react'
import { MAX_WAVE_CHOICES, usePrefs } from '../lib/prefs'
import { LEVEL_MAX_M, type Level } from '../scoring/physics'
import { useLang, type Strings } from '../spot/strings'

interface Props {
  open: boolean
  onClose: () => void
}

export function PrefsSheet(props: Props) {
  return <AnimatePresence>{props.open && <Sheet {...props} />}</AnimatePresence>
}

const levels = (t: Strings['prefs']): { id: Level | null; name: string; note: string }[] => [
  { id: null, name: t.levels.none, note: t.noLimit },
  { id: 'beginner', name: t.levels.beginner, note: t.limit(LEVEL_MAX_M.beginner!) },
  { id: 'intermediate', name: t.levels.intermediate, note: t.limit(LEVEL_MAX_M.intermediate!) },
  { id: 'advanced', name: t.levels.advanced, note: t.noLimit },
]

const choice = (on: boolean) =>
  `flex cursor-pointer flex-col items-start gap-0.5 rounded-2xl border px-3 py-2.5 has-focus-visible:outline-2 has-focus-visible:outline-glass ${on ? 'border-foam bg-card' : 'border-line hover:border-mist'}`

function Sheet({ onClose }: Props) {
  const { prefs, update } = usePrefs()
  const [, page] = useLang()
  const t = page.prefs
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

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <m.div className="absolute inset-0 bg-abyss/75" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} aria-hidden />
      <m.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prefs-title"
        className="relative flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-y-auto rounded-t-3xl border-t border-kelp bg-deep"
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 380, damping: 38 }}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2 sm:px-8">
          <h2 id="prefs-title" ref={heading} tabIndex={-1} className="font-display text-3xl font-extrabold outline-none">
            {t.title}
          </h2>
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 font-semibold text-foam hover:bg-card">
            {t.done}
          </button>
        </div>

        <div className="flex flex-col gap-5 px-5 pt-1 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-8">
          <p className="max-w-[46ch] text-sm text-mist">
            {t.intro}
          </p>

          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-2xl border border-line px-4 py-3 has-focus-visible:outline-2 has-focus-visible:outline-glass">
            <span className="flex flex-col">
              <span className="font-semibold">{t.rain}</span>
              <span className="text-xs text-mist">{t.rainNote}</span>
            </span>
            <input
              type="checkbox"
              checked={!!prefs.dontMindRain}
              onChange={(e) => update({ dontMindRain: e.target.checked })}
              className="size-5 shrink-0 accent-[var(--color-glass)]"
            />
          </label>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-semibold">{t.level}</legend>
            <div className="grid grid-cols-2 gap-2">
              {levels(t).map((l) => (
                <label key={String(l.id)} className={choice((prefs.level ?? null) === l.id)}>
                  <input type="radio" name="level" checked={(prefs.level ?? null) === l.id} onChange={() => update({ level: l.id })} className="sr-only" />
                  <span className="font-semibold">{l.name}</span>
                  <span className="text-xs text-mist">{l.note}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-semibold">{t.biggest}</legend>
            <div className="grid grid-cols-4 gap-2">
              {[null, ...MAX_WAVE_CHOICES].map((v) => (
                <label key={String(v)} className={`${choice((prefs.maxWaveM ?? null) === v)} items-center`}>
                  <input type="radio" name="max-wave" checked={(prefs.maxWaveM ?? null) === v} onChange={() => update({ maxWaveM: v })} className="sr-only" />
                  <span className="font-semibold tabular-nums">{v == null ? t.any : `${v} m`}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-mist">{t.maxNote}</p>
          </fieldset>
        </div>
      </m.div>
    </div>
  )
}
