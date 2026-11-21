import { SITE_URL } from './site'

// Cookie-free usage counts. Each app start adds 1 to a per-day counter in Supabase
// (count_event, migration 8); an install adds 1 to another. Nothing identifies the phone: no
// cookie, no id, nothing stored on the device, and the database keeps only the daily totals.
// A reload counts again, so "visits" means app opens, not people.
//
// Only counted on the live address (not localhost, not Vercel preview links), so testing
// doesn't skew the numbers.

type Kind = 'visit' | 'visit_app' | 'install'

const rawUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? ''
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? ''

function enabled(): boolean {
  return import.meta.env.PROD && rawUrl !== '' && key !== '' && window.location.origin === new URL(SITE_URL).origin
}

function send(kind: Kind): void {
  const base = (/^https?:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`).replace(/\/+$/, '')
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' }
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`
  // keepalive: still sent if the page closes right away. Failures (offline...) are ignored.
  fetch(`${base}/rest/v1/rpc/count_event`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_kind: kind }),
    keepalive: true,
  }).catch(() => {})
}

/** Opened as an installed app (home screen icon) rather than in a browser tab. */
function standalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/** Call once at start-up: counts this visit (after the first screen) and listens for installs. */
export function startUsageCounts(): void {
  if (!enabled()) return
  window.addEventListener('appinstalled', () => send('install'))
  // After load and idle, so it never competes with the forecast for bandwidth.
  const go = () => send(standalone() ? 'visit_app' : 'visit')
  const idle = () => ('requestIdleCallback' in window ? requestIdleCallback(go, { timeout: 5000 }) : setTimeout(go, 1000))
  if (document.readyState === 'complete') idle()
  else window.addEventListener('load', idle, { once: true })
}
