// Pieces shared by the home page and the spot page: top bar (logo, spots, language, your surf),
// score pips and colours, the duotone photo, wind colours, small helpers.

import { lazy, Suspense, useEffect, useState } from 'react'
import { ErrorBoundary, SectionFailed } from '../components/ErrorBoundary'
import { prefsSummary, usePrefs } from '../lib/prefs'
import { linkClick, spotPath } from '../lib/route'
import { IconBack, IconSliders } from './Icons'
import { Logo } from './Logo'
import { SPOT_DESIGN } from './spotDesign'
import { LANGS, useLang, type Lang, type Strings } from './strings'

const PrefsSheet = lazy(() => import('../components/PrefsSheet').then((m) => ({ default: m.PrefsSheet })))

/** Name without the "(beach)" part, and the beach on its own. */
export const splitName = (name: string) => ({
  town: name.replace(/\s*\(.*\)\s*$/, ''),
  beach: name.match(/\((.*)\)/)?.[1] ?? null,
})

/** Short weekday in the page language ("Fri" / "dv." / "vie"). */
export const wd = (t: Strings, unix: number, tz: string) => new Intl.DateTimeFormat(t.locale, { weekday: 'short', timeZone: tz }).format(unix * 1000)
export const kmhToKn = (k: number) => Math.round(k / 1.852)

// ---------------------------------------------------------------- colours

/** Verdict colour: 1 coral (skip), 2 sand (maybe), 3-4 green (go), 5 purple (epic). */
export const VERDICT_TEXT: Record<number, string> = { 1: 'text-coral-text', 2: 'text-sand', 3: 'text-glass', 4: 'text-glass', 5: 'text-epic-soft' }
export const SCORE_FILL: Record<number, string> = { 1: 'border-s1 bg-s1', 2: 'border-s2 bg-s2', 3: 'border-s3 bg-s3', 4: 'border-s4 bg-s4', 5: 'border-s5 bg-s5' }
/** Score blocks (hour bars, chips): background + readable text. */
export const BAR_BG: Record<number, string> = { 1: 'bg-s1 text-abyss', 2: 'bg-s2 text-abyss', 3: 'bg-s3 text-abyss', 4: 'bg-s4 text-abyss', 5: 'bg-s5 text-white' }
/** How the wind hits the beach: green offshore (helps), sand cross, coral onshore (spoils). */
export const REL_TEXT: Record<string, string> = { offshore: 'text-glass', cross: 'text-sand', onshore: 'text-coral-text' }
export const REL_TAG: Record<string, string> = { offshore: 'bg-glass/15 text-glass', cross: 'bg-sand/15 text-sand', onshore: 'bg-coral/20 text-coral-text' }
export const REL_STROKE: Record<string, string> = { offshore: 'var(--pos)', cross: 'var(--accent)', onshore: 'var(--neg)' }

export function Pips({ value, size = 10 }: { value: number; size?: number }) {
  return (
    <span className="flex gap-1.5" aria-hidden>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={`rounded-full border ${i <= value ? SCORE_FILL[value] : 'border-[#4b8392]'}`}
          style={{ width: size, height: size }}
        />
      ))}
    </span>
  )
}

// ---------------------------------------------------------------- photo

/**
 * The spot photo as a duotone background (grey photo at low opacity over the sea colour, so text
 * on it keeps >= 4.5:1). Phones get the small copy, desktops the large one.
 */
export function HeroPhoto({ src, thumb, slug, t }: { src: string | null; thumb?: string | null; slug: string; t: Strings }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  if (!src || failed) {
    // TODO: add web/public/photos/<slug>.jpg (and set `photo` in spot/spotDesign.ts).
    return (
      <div className="absolute inset-0 bg-inner" aria-hidden>
        <span className="absolute right-4 bottom-3 font-mono text-[11px] text-mist/80">{t.photoTodo(slug)}</span>
      </div>
    )
  }
  return (
    <div className="absolute inset-0 bg-sea" aria-hidden>
      <img
        src={src}
        srcSet={thumb ? `${thumb} 640w, ${src} 1600w` : undefined}
        sizes="(min-width: 1024px) 66vw, 100vw"
        alt=""
        decoding="async"
        onError={() => setFailed(true)}
        className="absolute inset-0 size-full object-cover opacity-[0.26] mix-blend-luminosity grayscale"
      />
      <div className="absolute inset-0 bg-sea/40 lg:bg-sea/15" />
    </div>
  )
}

// ---------------------------------------------------------------- top bar

/** Logo (home), the spots (current one underlined), language, "Your surf" and its sheet. */
export function TopBar({ current }: { current: string | null }) {
  const [lang, t, setLang] = useLang()
  const { prefs } = usePrefs()
  const prefsSet = !!prefsSummary(prefs)
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const onPrefs = () => {
    setLoaded(true)
    setOpen(true)
  }
  return (
    <header className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-10">
      <div className="flex items-center justify-between gap-3">
        <a href="/" onClick={linkClick} className="flex items-center gap-2 text-foam" aria-label={t.allSpots}>
          {current && <IconBack size={16} className="text-mist lg:hidden" />}
          <Logo className="h-7 w-auto" />
        </a>
        <div className="flex items-center gap-1 lg:hidden">
          <LangToggle lang={lang} setLang={setLang} />
          <button
            type="button"
            onClick={onPrefs}
            aria-haspopup="dialog"
            aria-label={t.yourSurf}
            className={`grid size-11 place-items-center rounded-[8px] border border-line hover:border-mist ${prefsSet ? 'text-accent' : 'text-stone2'}`}
          >
            <IconSliders />
          </button>
        </div>
      </div>
      <nav aria-label={t.spots} className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:flex-1 lg:px-0">
        <ul className="flex min-w-max gap-5 border-b border-line text-sm font-medium lg:gap-7">
          {SPOT_DESIGN.map((s) => {
            const on = s.slug === current
            return (
              <li key={s.slug}>
                <a
                  href={spotPath(s.slug)}
                  onClick={linkClick}
                  aria-current={on ? 'page' : undefined}
                  className={`-mb-px flex min-h-11 items-center border-b-2 ${on ? 'border-accent text-foam' : 'border-transparent text-mist hover:text-foam'}`}
                >
                  {s.name}
                </a>
              </li>
            )
          })}
        </ul>
      </nav>
      <div className="hidden items-center gap-2 lg:flex">
        <LangToggle lang={lang} setLang={setLang} />
        <button
          type="button"
          onClick={onPrefs}
          aria-haspopup="dialog"
          className={`flex h-10 items-center gap-2 rounded-[8px] border border-line px-3 text-sm font-medium hover:border-mist ${prefsSet ? 'text-accent' : 'text-stone2'}`}
        >
          <IconSliders size={16} /> {t.yourSurf}
        </button>
      </div>
      {loaded && (
        <ErrorBoundary name="Your surf" fallback={<SectionFailed what="your settings" />}>
          <Suspense fallback={null}>
            <PrefsSheet open={open} onClose={() => setOpen(false)} />
          </Suspense>
        </ErrorBoundary>
      )}
    </header>
  )
}

function LangToggle({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  const [, t] = useLang()
  return (
    <div className="flex rounded-[8px] border border-line p-0.5 font-mono text-xs" role="group" aria-label={t.language}>
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={lang === l}
          onClick={() => setLang(l)}
          className={`h-9 min-w-9 rounded-[6px] px-2 uppercase ${lang === l ? 'bg-foam text-abyss' : 'text-mist hover:text-foam'}`}
        >
          {l}
        </button>
      ))}
    </div>
  )
}
