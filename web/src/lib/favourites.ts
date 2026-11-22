// Favourite spots, saved only on this device (localStorage). Never sent anywhere.
// Every screen using the hook stays in sync, also across tabs (storage event).

import { useCallback, useSyncExternalStore } from 'react'

const KEY = 'surf:favourites'
const listeners = new Set<() => void>()
let cache: { raw: string | null; ids: ReadonlySet<string> } = { raw: null, ids: new Set() }

function read(): ReadonlySet<string> {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    /* storage blocked: no favourites */
  }
  if (raw !== cache.raw) {
    let ids: string[] = []
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : []
      if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string')
    } catch {
      /* corrupted: start empty */
    }
    cache = { raw, ids: new Set(ids) }
  }
  return cache.ids
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  const onStorage = (e: StorageEvent) => e.key === KEY && fn()
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(fn)
    window.removeEventListener('storage', onStorage)
  }
}

export function useFavourites() {
  const ids = useSyncExternalStore(subscribe, read, read)
  const toggle = useCallback((id: string) => {
    const next = new Set(read())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    try {
      localStorage.setItem(KEY, JSON.stringify([...next]))
    } catch {
      /* can't save: the star just won't stick */
    }
    listeners.forEach((l) => l())
  }, [])
  return { ids, toggle }
}
