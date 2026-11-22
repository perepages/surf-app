// Surf alerts (web push). The phone subscribes with our public VAPID key; the subscription
// (push address + its encryption keys) goes to Supabase through push_subscribe (migration 13)
// with the spot and the minimum score. jobs/notify.py sends the alerts every hour.
//
// Where it works: Android (Chrome, Edge, Firefox, Samsung Internet) and desktop browsers, in a
// tab or installed. iPhone/iPad: iOS 16.4+ and ONLY from the app added to the Home Screen
// (Safari tabs have no push at all).

import { rpc, supabaseConfigured } from './supabase'

const PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined)?.trim() ?? ''
const LOCAL_KEY = 'surf:alerts' // { spotId: minScore } as last confirmed by the database

export type PushSupport =
  | { ok: true }
  /** iPhone/iPad in a Safari tab: works once added to the Home Screen and opened from there. */
  | { ok: false; reason: 'ios-install' }
  /** iOS older than 16.4, or a browser without web push. */
  | { ok: false; reason: 'unsupported' }
  /** The user (or the browser) blocked notifications for this site. */
  | { ok: false; reason: 'denied' }
  /** Development server (no service worker) or a build without the keys. */
  | { ok: false; reason: 'not-configured' }

export const isIos = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)
export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

export function pushSupport(): PushSupport {
  const hasApi = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  if (!hasApi) return isIos() && !isStandalone() ? { ok: false, reason: 'ios-install' } : { ok: false, reason: 'unsupported' }
  if (!PUBLIC_KEY || !supabaseConfigured || !import.meta.env.PROD) return { ok: false, reason: 'not-configured' }
  if (Notification.permission === 'denied') return { ok: false, reason: 'denied' }
  return { ok: true }
}

export function readLocalAlerts(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}')
    return v && typeof v === 'object' ? (v as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function writeLocalAlerts(alerts: Record<string, number>) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(alerts))
  } catch {
    /* only a display copy */
  }
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=')
  const raw = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

const sameKey = (a: ArrayBuffer | null, b: Uint8Array) => {
  if (!a || a.byteLength !== b.byteLength) return false
  const x = new Uint8Array(a)
  return x.every((v, i) => v === b[i])
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // The worker is registered after page load (main.tsx); wait for it, but not forever.
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The app isn’t fully installed yet. Reload and try again.')), 10_000)),
  ])
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription()) ?? null
}

/**
 * Turns the alert on (or changes the score). MUST be called straight from a tap: browsers
 * (iOS especially) only show the permission question in response to the user.
 */
export async function enableAlert(spotId: string, minScore: number): Promise<void> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this app. Allow them in your phone’s settings, then try again.'
        : 'No permission to send notifications.',
    )
  }
  const reg = await registration()
  const key = keyBytes(PUBLIC_KEY)
  let sub = await reg.pushManager.getSubscription()
  // Subscribed earlier with another key (keys were replaced): start over.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  const json = sub.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('The browser gave an incomplete push subscription.')
  try {
    await rpc<null>('push_subscribe', {
      p_endpoint: json.endpoint,
      p_p256dh: json.keys.p256dh,
      p_auth: json.keys.auth,
      p_spot_id: spotId,
      p_min_score: minScore,
    })
  } catch (err) {
    throw new Error(`Couldn’t save the alert (${err instanceof Error ? err.message : String(err)}). Try again in a moment.`)
  }
  writeLocalAlerts({ ...readLocalAlerts(), [spotId]: minScore })
}

/** Turns one spot's alert off; when none are left, the phone's push subscription goes too. */
export async function disableAlert(spotId: string): Promise<void> {
  const sub = await currentSubscription()
  const local = readLocalAlerts()
  delete local[spotId]
  if (sub) {
    await rpc<number>('push_unsubscribe', { p_endpoint: sub.endpoint, p_spot_id: spotId })
    if (Object.keys(local).length === 0) await sub.unsubscribe().catch(() => {})
  }
  writeLocalAlerts(local)
}

/**
 * The alerts the database really has for this phone (the job removes dead ones). Falls back to
 * the local copy when offline or not set up. Never throws.
 */
export async function syncAlerts(): Promise<Record<string, number>> {
  const local = readLocalAlerts()
  try {
    if (pushSupport().ok !== true && Object.keys(local).length === 0) return local
    const sub = await currentSubscription()
    if (!sub) {
      writeLocalAlerts({})
      return {}
    }
    const rows = await rpc<{ spot_id: string; min_score: number }[]>('push_alerts', { p_endpoint: sub.endpoint })
    const fresh = Object.fromEntries(rows.map((r) => [r.spot_id, r.min_score]))
    writeLocalAlerts(fresh)
    return fresh
  } catch {
    return local
  }
}
