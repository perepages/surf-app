// Your surf preferences ("I don't mind rain", level, max wave size), saved only on this device
// (localStorage). Never sent anywhere. They change the GO / MAYBE / SKIP and the warnings, not
// the forecast itself. Every screen using the hook stays in sync, also across tabs.

import { useCallback, useSyncExternalStore } from 'react'
import type { Level, Prefs } from '../scoring/physics'

const KEY = 'surf:prefs'
const LEVELS: Level[] = ['beginner', 'intermediate', 'advanced']
/** Max wave sizes offered in the settings, m. */
export const MAX_WAVE_CHOICES = [0.5, 0.8, 1.2, 1.5, 2, 2.5] as const

const listeners = new Set<() => void>()
let cache: { raw: string | null; prefs: Prefs } = { raw: null, prefs: {} }

function parse(raw: string | null): Prefs {
  try {
    const p: unknown = raw ? JSON.parse(raw) : {}
    if (!p || typeof p !== 'object') return {}
    const o = p as Record<string, unknown>
    return {
      dontMindRain: o.dontMindRain === true,
      level: LEVELS.includes(o.level as Level) ? (o.level as Level) : null,
      maxWaveM: typeof o.maxWaveM === 'number' && o.maxWaveM > 0 && o.maxWaveM < 10 ? o.maxWaveM : null,
    }
  } catch {
    return {} // corrupted: defaults
  }
}

export function readPrefs(): Prefs {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    /* storage blocked: defaults */
  }
  if (raw !== cache.raw) cache = { raw, prefs: parse(raw) }
  return cache.prefs
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

export function usePrefs() {
  const prefs = useSyncExternalStore(subscribe, readPrefs, readPrefs)
  const update = useCallback((change: Partial<Prefs>) => {
    const next = { ...readPrefs(), ...change }
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      /* can't save: the choice lasts until the page is closed */
      cache = { raw: cache.raw, prefs: next }
    }
    listeners.forEach((l) => l())
  }, [])
  return { prefs, update }
}

/** "Beginner · max 1.2 m · rain OK", or null when nothing is set. */
export function prefsSummary(p: Prefs): string | null {
  const parts = [
    p.level ? p.level[0].toUpperCase() + p.level.slice(1) : null,
    p.maxWaveM != null ? `max ${p.maxWaveM} m` : null,
    p.dontMindRain ? 'rain OK' : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}
