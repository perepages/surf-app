// Tiny "last good copy" store in localStorage, so the app can show the last data it had
// when it starts offline or while the network is slow. Every access is guarded: storage can be
// full, blocked (private mode) or cleared at any time.

export function readLastGood<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`surf:last:${key}`)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export function writeLastGood<T>(key: string, value: T): void {
  try {
    localStorage.setItem(`surf:last:${key}`, JSON.stringify(value))
  } catch {
    /* no cache: the app still works online */
  }
}
