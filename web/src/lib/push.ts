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

/** False only when the subscription is KNOWN to use another key. Some browsers don't report the
 *  key (null): treat that as the same, or every tap would make a new subscription and orphan the
 *  alerts of the other spots. */
const notOtherKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => {
  if (!a) return true
  if (a.byteLength !== b.byteLength) return false
  const x = new Uint8Array(a)
  return x.every((v, i) => v === b[i])
}

function subscribeArgs(sub: PushSubscription) {
  const json = sub.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('The browser gave an incomplete push subscription.')
  return { p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth }
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
  if (sub && !notOtherKey(sub.options?.applicationServerKey, key)) {
    await sub.unsubscribe()
    sub = null
  }
  const previous = readLastEndpoint()
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  const args = subscribeArgs(sub)
  const alerts = { ...readLocalAlerts(), [spotId]: minScore }
  try {
    await rpc<null>('push_subscribe', { ...args, p_spot_id: spotId, p_min_score: minScore })
    // New push address (first alert, browser renewed it, or keys replaced): move this phone's
    // other alerts to it, else they'd stay on the dead address and vanish at the next send.
    if (previous && previous !== args.p_endpoint) await moveAlerts(args, alerts, spotId)
  } catch (err) {
    throw new Error(`Couldn’t save the alert (${err instanceof Error ? err.message : String(err)}). Try again in a moment.`)
  }
  writeLastEndpoint(args.p_endpoint)
  writeLocalAlerts(alerts)
}

const ENDPOINT_KEY = 'surf:push-endpoint' // to notice when the browser's push address changes
function readLastEndpoint(): string | null {
  try {
    return localStorage.getItem(ENDPOINT_KEY)
  } catch {
    return null
  }
}
function writeLastEndpoint(endpoint: string | null) {
  try {
    if (endpoint) localStorage.setItem(ENDPOINT_KEY, endpoint)
    else localStorage.removeItem(ENDPOINT_KEY)
  } catch {
    /* only used to repair alerts */
  }
}

/** Re-saves every alert of this phone under the current push address (except `skip`). */
async function moveAlerts(args: ReturnType<typeof subscribeArgs>, alerts: Record<string, number>, skip?: string) {
  for (const [spot, min] of Object.entries(alerts)) {
    if (spot === skip) continue
    await rpc<null>('push_subscribe', { ...args, p_spot_id: spot, p_min_score: min }).catch(() => {})
  }
}

/** Turns one spot's alert off; when none are left, the phone's push subscription goes too. */
export async function disableAlert(spotId: string): Promise<void> {
  const sub = await currentSubscription()
  const local = readLocalAlerts()
  delete local[spotId]
  if (sub) {
    await rpc<number>('push_unsubscribe', { p_endpoint: sub.endpoint, p_spot_id: spotId })
    if (Object.keys(local).length === 0) {
      await sub.unsubscribe().catch(() => {})
      writeLastEndpoint(null)
    }
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
      writeLastEndpoint(null)
      return {}
    }
    const rows = await rpc<{ spot_id: string; min_score: number }[]>('push_alerts', { p_endpoint: sub.endpoint })
    let fresh: Record<string, number> = Object.fromEntries(rows.map((r) => [r.spot_id, r.min_score]))
    // The browser renewed its push address (the job then deletes the old rows as "gone"): the
    // database has nothing for the new one but this phone still wants its alerts. Re-save them.
    if (rows.length === 0 && Object.keys(local).length > 0 && sub.endpoint !== readLastEndpoint() && Notification.permission === 'granted') {
      await moveAlerts(subscribeArgs(sub), local)
      fresh = local
    }
    writeLastEndpoint(sub.endpoint)
    writeLocalAlerts(fresh)
    return fresh
  } catch {
    return local
  }
}
