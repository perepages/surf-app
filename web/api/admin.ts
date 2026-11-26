// Admin API (Vercel function): POST /api/admin, JSON body with the password and an action:
//   {"password":"...","action":"summary"}                      -> last 30 days of counts + latest 50 ratings
//   {"password":"...","action":"hide","id":123,"hidden":true}  -> hide (or show again) one rating
//   {"password":"...","action":"usage"}                        -> free-plan usage + 80% alerts
// The password goes in the body, not a header: Vercel's preview protection may handle
// `Authorization` headers itself, and headers can't carry characters like ñ or é.
// (`Authorization: Bearer <password>` still works, for scripts.)
//
// Runs on the server only. Needs, in Vercel's environment variables (never VITE_*):
//   ADMIN_PASSWORD             at least 16 characters, else the API stays off
//   SUPABASE_URL               same as the jobs
//   SUPABASE_SERVICE_ROLE_KEY  same as the jobs; bypasses row-level security, never sent to the browser
//
// In `npm run dev` the same handler runs inside Vite (vite.config.ts devApi), reading the root .env.
// No packages: Node's crypto + fetch.

import { createHash, timingSafeEqual } from 'node:crypto'

type Env = Record<string, string | undefined>

const DAYS = 30
const LATEST = 50
const MIN_PASSWORD = 16

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Constant-time compare (hashing first makes the lengths equal). */
function samePassword(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function supabase(env: Env) {
  const raw = (env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  const base = /^https?:\/\//.test(raw) ? raw : `https://${raw}`
  const key = (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  // New keys (sb_secret_...) go in `apikey` only; legacy JWT keys also as Bearer.
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' }
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(`${base}/rest/v1/${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Supabase ${path.split('?')[0]}: HTTP ${res.status} ${detail.slice(0, 200)}`)
    }
    return (res.status === 204 ? undefined : await res.json()) as T
  }
  return { ok: raw !== '' && key !== '', call }
}

interface RatingRow {
  id: number
  spot_id: string
  surfed_at: string
  created_at: string
  overall: number
  wave_size: string | null
  surface: string | null
  crowd: string | null
  comment: string | null
  source: string
  device_id: string | null
  near_beach: boolean | null
  app_version: string | null
  hidden: boolean
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

async function summary(db: ReturnType<typeof supabase>) {
  const today = new Date()
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (DAYS - 1)))
  const since = isoDay(first)

  const [counts, recent, latest] = await Promise.all([
    db.call<{ day: string; kind: string; count: number }[]>(`daily_counts?select=day,kind,count&day=gte.${since}`),
    // Supabase returns at most 1000 rows per request by default; plenty for 30 days for now.
    db.call<{ created_at: string; hidden: boolean }[]>(
      `ratings?select=created_at,hidden&created_at=gte.${since}T00:00:00Z&order=created_at.desc&limit=1000`,
    ),
    db.call<RatingRow[]>(
      'ratings?select=id,spot_id,surfed_at,created_at,overall,wave_size,surface,crowd,comment,source,device_id,near_beach,app_version,hidden' +
        `&order=created_at.desc&limit=${LATEST}`,
    ),
  ])

  // One row per UTC day, newest first, zeros included so gaps are visible.
  const days = new Map<string, { day: string; visits: number; appVisits: number; installs: number; ratings: number; hidden: number }>()
  for (let i = 0; i < DAYS; i++) {
    const day = isoDay(new Date(first.getTime() + (DAYS - 1 - i) * 86_400_000))
    days.set(day, { day, visits: 0, appVisits: 0, installs: 0, ratings: 0, hidden: 0 })
  }
  for (const c of counts) {
    const d = days.get(c.day)
    if (!d) continue
    if (c.kind === 'visit') d.visits += c.count
    else if (c.kind === 'visit_app') d.appVisits += c.count
    else if (c.kind === 'install') d.installs += c.count
  }
  for (const r of recent) {
    const d = days.get(isoDay(new Date(r.created_at)))
    if (!d) continue
    if (r.hidden) d.hidden++
    else d.ratings++
  }

  return {
    days: [...days.values()],
    // Hit Supabase's 1000-row limit: the ratings column is short. Count in SQL once this happens.
    ratingsCapped: recent.length >= 1000,
    latest: latest.map(({ device_id, ...r }) => ({
      ...r,
      // Enough to spot one phone sending many ratings; the full id stays in the database.
      device: device_id ? device_id.slice(0, 6) : null,
    })),
  }
}

// ---------- free-plan usage (action "usage", migration 24) ----------

/** Free-plan limits, checked 2026-11-26 on supabase.com/pricing, open-meteo.com/en/pricing and
 *  vercel.com/docs/plans/hobby. Same numbers in jobs/usage_check.py (nightly email alert). */
export const FREE_LIMITS = {
  dbBytes: 500e6, // Supabase: 500 MB database (over it: requests answer HTTP 402)
  storageBytes: 1e9, // Supabase: 1 GB file storage
  openMeteoPerDay: 10_000, // Open-Meteo non-commercial: 10,000 calls/day (also 5,000/h, 600/min), per IP
}
/** Warn from this share of a limit. */
export const ALERT_AT = 0.8

interface UsageRow {
  measured_at: string
  db_bytes: number
  tables: { name: string; bytes: number; rows_estimate: number }[]
  storage: { bucket: string; files: number; bytes: number }[]
  api_calls: { day: string; service: string; calls: number; requests: number }[]
}

async function usage(db: ReturnType<typeof supabase>) {
  const u = await db.call<UsageRow>('rpc/usage_summary', { method: 'POST', body: '{}' })
  const storageBytes = u.storage.reduce((s, b) => s + b.bytes, 0)
  const today = isoDay(new Date())
  const om = u.api_calls.filter((a) => a.service === 'open-meteo')
  const omToday = om.find((a) => a.day === today)?.calls ?? 0
  const omMax = om.reduce((m, a) => Math.max(m, a.calls), 0)
  const metric = (key: string, label: string, used: number, limit: number, unit: 'bytes' | 'calls', note: string) => ({
    key,
    label,
    used,
    limit,
    unit,
    share: limit > 0 ? used / limit : 0,
    alert: limit > 0 && used / limit >= ALERT_AT,
    note,
  })
  return {
    measuredAt: u.measured_at,
    alertAt: ALERT_AT,
    metrics: [
      metric('db', 'Supabase database', u.db_bytes, FREE_LIMITS.dbBytes, 'bytes', 'Free: 500 MB. Measured now, same way as Supabase.'),
      metric('storage', 'Supabase file storage', storageBytes, FREE_LIMITS.storageBytes, 'bytes', 'Free: 1 GB. All buckets.'),
      metric('openMeteo', 'Open-Meteo calls today', omToday, FREE_LIMITS.openMeteoPerDay, 'calls',
        `Free: 10,000 a day. Counted by our jobs with Open-Meteo’s weighting (UTC day). Busiest of the last 30 days: ${Math.round(omMax)}.`),
    ],
    tables: u.tables,
    storage: u.storage,
    apiDays: om.map(({ day, calls, requests }) => ({ day, calls, requests })),
    // Shown as "check on the dashboard": no API gives these without a broad account token.
    notReadable: [
      { label: 'Supabase egress', limit: '5 GB + 5 GB cached a month', where: 'Supabase dashboard > Organization > Usage', url: 'https://supabase.com/dashboard/org/_/usage' },
      { label: 'Vercel data transfer', limit: '100 GB a month (10 GB origin)', where: 'Vercel dashboard > Usage', url: 'https://vercel.com/dashboard' },
      { label: 'Vercel requests + functions', limit: '1,000,000 CDN requests, 1,000,000 function calls a month', where: 'Vercel dashboard > Usage', url: 'https://vercel.com/dashboard' },
    ],
  }
}

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Use POST' })

  // trim: a value pasted into Vercel's settings often carries a space or line break at either
  // end; the page trims what's typed the same way.
  const password = (env.ADMIN_PASSWORD ?? '').trim()
  if (password.length < MIN_PASSWORD) {
    return json(503, { error: `Admin is off: set ADMIN_PASSWORD (at least ${MIN_PASSWORD} characters) on the server.` })
  }
  const db = supabase(env)
  if (!db.ok) return json(503, { error: 'Admin is off: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.' })

  let body: { password?: unknown; action?: string; id?: unknown; hidden?: unknown }
  try {
    body = (await request.json()) as typeof body
    if (typeof body !== 'object' || body === null) throw new Error('not an object')
  } catch {
    return json(400, { error: 'Body must be a JSON object' })
  }

  const auth = request.headers.get('authorization') ?? ''
  const given = typeof body.password === 'string' ? body.password.trim() : auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!samePassword(given, password)) {
    await sleep(1000) // slows down guessing
    return json(401, { error: 'Wrong password' })
  }

  try {
    if (body.action === 'summary') return json(200, await summary(db))

    if (body.action === 'usage') {
      try {
        return json(200, await usage(db))
      } catch (err) {
        if (/PGRST202|42883/.test(err instanceof Error ? err.message : '')) {
          return json(503, { error: 'Usage not ready: run supabase/migrations/20261126000024_usage_stats.sql in the SQL editor.' })
        }
        throw err
      }
    }

    if (body.action === 'hide') {
      if (!Number.isSafeInteger(body.id) || typeof body.hidden !== 'boolean') {
        return json(400, { error: 'hide needs a numeric id and hidden: true/false' })
      }
      const updated = await db.call<{ id: number; hidden: boolean }[]>(`ratings?id=eq.${body.id}&select=id,hidden`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ hidden: body.hidden, hidden_at: body.hidden ? new Date().toISOString() : null }),
      })
      if (updated.length === 0) return json(404, { error: `No rating ${body.id}` })
      return json(200, updated[0])
    }

    return json(400, { error: 'Unknown action' })
  } catch (err) {
    console.error('admin API', err)
    const message = err instanceof Error ? err.message : 'Database error'
    // Column or table missing: the migration that adds them hasn't been run yet.
    if (/42703|42P01|PGRST205|PGRST204/.test(message)) {
      return json(503, { error: 'Database not ready: run supabase/migrations/20261121000008_admin_and_counts.sql in the SQL editor.' })
    }
    return json(502, { error: message })
  }
}

// Vercel (Node runtime, web-standard handler).
export function POST(request: Request): Promise<Response> {
  return handleAdmin(request, process.env)
}
export function GET(request: Request): Promise<Response> {
  return handleAdmin(request, process.env)
}
