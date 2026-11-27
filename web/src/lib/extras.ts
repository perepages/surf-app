// The page's other public data that rides along with the forecast answer (/api/forecast
// `extras`, see web/api/forecast.ts): AI scores, today's reports, 14-day ratings, model info,
// the spot row (spot page) or the spot list + crowd (home page).
//
// forecast.ts publishes them here when a forecast arrives; the hooks that used to read Supabase
// themselves (reports, model info) pick them up instead. A hook reads Supabase directly only
// when its part is missing (old server, a read failed there), when nothing arrived within
// EXTRAS_WAIT_MS, or right after the user sent a rating (their report must show at once).

import { FETCHED_AT_KEY } from './forecastRequest'

export interface SpotExtras {
  spot?: unknown
  ai?: unknown[]
  reports?: unknown
  daily?: unknown[]
  model?: unknown
}

/** How long a hook waits for the forecast's extras before reading Supabase itself. */
export const EXTRAS_WAIT_MS = 10_000
/** A saved copy younger than this needs no new read when a screen opens. */
export const EXTRAS_FRESH_MS = 20 * 60 * 1000

/** The spot's forecast (and so its extras) was downloaded less than EXTRAS_FRESH_MS ago. */
export function extrasRecent(spotId: string): boolean {
  try {
    const t = Number(localStorage.getItem(`${FETCHED_AT_KEY}:${spotId}`) || 0)
    return Date.now() - t < EXTRAS_FRESH_MS
  } catch {
    return false
  }
}

type Listener = (extras: SpotExtras) => void
const listeners = new Map<string, Set<Listener>>()

/** Called by forecast.ts with every spot forecast it downloads ({} if the server sent none). */
export function publishExtras(spotId: string, extras: SpotExtras | undefined): void {
  for (const l of listeners.get(spotId) ?? []) l(extras ?? {})
}

/** Subscribe to a spot's extras; returns the unsubscribe function. */
export function onExtras(spotId: string, listener: Listener): () => void {
  let set = listeners.get(spotId)
  if (!set) listeners.set(spotId, (set = new Set()))
  set.add(listener)
  return () => set.delete(listener)
}
