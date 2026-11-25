import { lazy, Suspense, useCallback, useState } from 'react'
import { ErrorBoundary, SectionFailed } from './ErrorBoundary'
import { prefsSummary, usePrefs } from '../lib/prefs'

// The sheet's code downloads on first open.
const PrefsSheet = lazy(() => import('./PrefsSheet').then((m) => ({ default: m.PrefsSheet })))

/** "Your surf" button + its sheet (level, max size, I don't mind rain). Sand when something is set. */
export function PrefsButton() {
  const { prefs } = usePrefs()
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const summary = prefsSummary(prefs)
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setLoaded(true)
          setOpen(true)
        }}
        aria-haspopup="dialog"
        aria-label={summary ? `Your surf settings: ${summary}` : 'Your surf settings'}
        className={`rounded-full px-3 py-1 text-sm font-semibold hover:bg-deep ${summary ? 'text-sand' : 'text-mist hover:text-foam'}`}
      >
        ⚙ Your surf
      </button>
      {loaded && (
        <ErrorBoundary name="Your surf" fallback={<SectionFailed what="your settings" />}>
          <Suspense fallback={null}>
            <PrefsSheet open={open} onClose={close} />
          </Suspense>
        </ErrorBoundary>
      )}
    </>
  )
}
