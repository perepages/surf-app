// Network time limits. A phone on a weak signal can keep a request open for minutes without
// failing, which would leave the app on "Checking the sea…" or "Sending…" forever. Every request
// for the forecast file or to Supabase goes through withTimeout, so it either answers or fails with a clear
// message, and the app falls back to its saved copy.

export const FORECAST_TIMEOUT_MS = 20_000
export const SUPABASE_TIMEOUT_MS = 15_000

/**
 * Runs `run` with a signal that aborts when `outer` aborts or after `ms`, whichever comes first.
 * The limit covers the whole request, body included. A timeout becomes
 * `Error("<label> took too long to answer")`; an abort from `outer` is passed through unchanged.
 */
export async function withTimeout<T>(
  outer: AbortSignal | undefined,
  ms: number,
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController()
  let timedOut = false
  const onAbort = () => ac.abort(outer?.reason)
  if (outer?.aborted) ac.abort(outer.reason)
  else outer?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, ms)
  try {
    return await run(ac.signal)
  } catch (err) {
    if (timedOut && !outer?.aborted) throw new Error(`${label} took too long to answer`)
    throw err
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onAbort)
  }
}

/** Resolves like `p`, but rejects as soon as `signal` aborts (for promises that can't be cancelled). */
export function untilAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
