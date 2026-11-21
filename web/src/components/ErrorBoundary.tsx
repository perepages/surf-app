import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Catches a crash in its children (a bug, or a section's code that couldn't be downloaded,
 * e.g. offline before the app was saved on the phone) and shows `fallback` instead of a blank
 * screen. Without this, React removes the whole page on any render error.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode; name: string }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`${this.props.name} crashed`, error, info.componentStack)
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** Small "this part couldn't load" note for one section, with a reload button. */
export function SectionFailed({ what }: { what: string }) {
  return (
    <p role="status" className="mx-4 mt-8 rounded-lg border border-kelp px-3 py-2 text-sm text-mist sm:mx-8">
      Couldn’t show {what}.{' '}
      <button type="button" onClick={() => window.location.reload()} className="underline underline-offset-2 hover:text-foam">
        Reload
      </button>
    </p>
  )
}

/** Whole-app fallback: still credits Open-Meteo and offers a reload. */
export function AppFailed() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-4 px-4 sm:px-8">
      <p className="font-display text-5xl font-extrabold text-coral">Something went wrong</p>
      <p className="max-w-[50ch]">The app hit an error. Reloading usually fixes it.</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="self-start rounded-lg bg-foam px-4 py-2 font-semibold text-abyss hover:bg-glass"
      >
        Reload
      </button>
      <a href="https://open-meteo.com/" target="_blank" rel="noreferrer" className="mt-6 text-xs text-mist underline underline-offset-2">
        Weather data by Open-Meteo.com
      </a>
    </main>
  )
}
