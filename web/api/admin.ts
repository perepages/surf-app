// Admin API (Vercel function): POST /api/admin with header `Authorization: Bearer <ADMIN_PASSWORD>`.
//   {"action":"summary"}                      -> last 30 days of counts + the latest 50 ratings
//   {"action":"hide","id":123,"hidden":true}  -> hide (or show again) one rating
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
    latest: latest.map(({ device_id, ...r }) => ({
      ...r,
      // Enough to spot one phone sending many ratings; the full id stays in the database.
      device: device_id ? device_id.slice(0, 6) : null,
    })),
  }
}

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Use POST' })

  const password = env.ADMIN_PASSWORD ?? ''
  if (password.length < MIN_PASSWORD) {
    return json(503, { error: `Admin is off: set ADMIN_PASSWORD (at least ${MIN_PASSWORD} characters) on the server.` })
  }
  const db = supabase(env)
  if (!db.ok) return json(503, { error: 'Admin is off: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.' })

  const auth = request.headers.get('authorization') ?? ''
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!samePassword(given, password)) {
    await sleep(1000) // slows down guessing
    return json(401, { error: 'Wrong password' })
  }

  let body: { action?: string; id?: unknown; hidden?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json(400, { error: 'Body must be JSON' })
  }

  try {
    if (body.action === 'summary') return json(200, await summary(db))

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
