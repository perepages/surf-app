// Forecast API (Vercel function): GET /api/forecast?spot=<id>  -> that spot's forecast file
//                                  GET /api/forecast?spot=all   -> index.json (home screen)
// Both answers also carry `extras`: the page's other public data (AI scores, reports, ...), see
// spotExtras / homeExtras below.
// The files are written every hour by jobs/collect_forecast.py into the private Supabase bucket
// `forecast-files`; the app never calls Open-Meteo itself.
//
// Cost: Vercel's CDN keeps each answer for CDN_FRESH_S and then serves the old copy while it
// fetches a new one in the background (CDN_STALE_S), so thousands of visitors cost one
// Supabase download per spot per region every few minutes. Any other URL shape (extra
// parameters, upper case...) is refused, so nobody can bypass the cache with ?x=random.
//
// Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (server-side only, same as api/admin.ts) for the
// file, and VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (the public key) for the extras.
// In `npm run dev` the same handler runs inside Vite (vite.config.ts devApi).

type Env = Record<string, string | undefined>

const BUCKET = 'forecast-files'
/** Fresh at the CDN for 10 min: the forecast changes every ~3 h, but the answer also carries
 *  today's surfer reports (extras), which shouldn't lag much more. (Was 5, then 15 min;
 *  docs/free-plan-limits.md.) Then stale-while-revalidate for up to a day (job hiccups). */
const CDN_FRESH_S = 600
const CDN_STALE_S = 86_400
/** Browsers may reuse it for a minute (the app keeps its own copy anyway). */
const BROWSER_S = 60
const SPOT_ID = /^[a-z0-9-]{1,40}$/

const error = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Short CDN cache for "not found" too, so a typo can't hammer Supabase.
      'Cache-Control': 'no-store',
      'Vercel-CDN-Cache-Control': status === 404 ? 'max-age=60' : 'no-store',
    },
  })

// ---------- extras: the page's other public data, in the same answer ----------
// Each visit used to make 7 (home) or 5 (spot page) more requests straight to Supabase. They ride
// along here instead, so the CDN serves them too and Supabase's egress no longer grows with
// visitors (docs/free-plan-limits.md, fix 2). Read with the PUBLIC key: never more than the app
// itself may see. Any part that fails is left out; the app then reads that part from Supabase
// itself, as before.

/** Same columns as web/src/lib/spot.ts SPOT_COLUMNS (copied: this file can't import browser code). */
const SPOT_COLUMNS = 'id,name,lat,lon,beach_orientation,swell_window_min,swell_window_max'
/** Same as web/src/lib/reports.ts CHART_DAYS. */
const CHART_DAYS = 14
const EXTRA_TIMEOUT_MS = 8000

function publicDb(env: Env) {
  const raw = (env.VITE_SUPABASE_URL ?? env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  const base = /^https?:\/\//.test(raw) ? raw : `https://${raw}`
  const key = (env.VITE_SUPABASE_ANON_KEY ?? '').trim()
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' }
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`
  const call = async (path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${base}/rest/v1/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(EXTRA_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`${path.split('?')[0]}: HTTP ${res.status}`)
    return res.status === 204 ? null : res.json()
  }
  return { ok: raw !== '' && key !== '', call }
}

const isoAt = (unixS: number) => encodeURIComponent(new Date(unixS * 1000).toISOString())

/** Runs the named reads in parallel; keeps the ones that worked. */
async function settle(parts: Record<string, Promise<unknown>>): Promise<Record<string, unknown>> {
  const names = Object.keys(parts)
  const results = await Promise.allSettled(Object.values(parts))
  const out: Record<string, unknown> = {}
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out[names[i]] = r.value
    else console.warn('forecast extras', names[i], String(r.reason))
  })
  return out
}

/** One spot page: spot row, 20 days of AI scores, today's reports, 14-day ratings, model info. */
async function spotExtras(env: Env, spot: string): Promise<Record<string, unknown> | null> {
  const db = publicDb(env)
  if (!db.ok) return null
  const now = Date.now() / 1000
  const id = encodeURIComponent(spot)
  return settle({
    spot: db.call(`spots?select=${SPOT_COLUMNS}&id=eq.${id}`).then((rows) => (rows as unknown[])[0] ?? null),
    ai: db.call(
      `predictions?select=valid_at,ai_score,ai_waves,ai_shape,reason,model_version&spot_id=eq.${id}` +
        `&valid_at=gte.${isoAt(now - 15 * 86400)}&valid_at=lte.${isoAt(now + 5 * 86400)}&ai_waves=not.is.null`,
    ),
    reports: db.call('rpc/spot_reports_today', { p_spot_id: spot }),
    daily: db.call('rpc/spot_daily_ratings', { p_spot_id: spot, p_days: CHART_DAYS }),
    model: db.call('rpc/spot_model_info', { p_spot_id: spot, p_days: CHART_DAYS }),
  })
}

/** The home page: active spots, AI scores around now, today's crowd per spot. */
async function homeExtras(env: Env): Promise<Record<string, unknown> | null> {
  const db = publicDb(env)
  if (!db.ok) return null
  const now = Date.now() / 1000
  const spotsP = db.call(`spots?select=${SPOT_COLUMNS}&active=eq.true&order=id`) as Promise<{ id: string }[]>
  const ids = spotsP.then((rows) => rows.map((r) => encodeURIComponent(r.id)).join(','))
  return settle({
    spots: spotsP,
    ai: ids.then((list) =>
      db.call(
        `predictions?select=spot_id,valid_at,ai_score,ai_waves,ai_shape&spot_id=in.(${list})` +
          `&valid_at=gte.${isoAt(now - 2 * 3600)}&valid_at=lte.${isoAt(now + 5 * 3600)}&ai_waves=not.is.null`,
      ),
    ),
    // Only what the list shows (count + most common crowd), one call per spot like the app did.
    crowd: spotsP.then(async (rows) => {
      const out: Record<string, { count: number; crowd: string | null }> = {}
      await Promise.all(
        rows.map(async (r) => {
          const rep = (await db.call('rpc/spot_reports_today', { p_spot_id: r.id })) as { count: number; crowd: string | null }
          out[r.id] = { count: rep.count, crowd: rep.crowd }
        }),
      )
      return out
    }),
  })
}

export async function handleForecast(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return error(405, 'Use GET')
  const url = new URL(request.url)
  const params = [...url.searchParams.keys()]
  const spot = url.searchParams.get('spot') ?? ''
  if (params.length !== 1 || params[0] !== 'spot' || (spot !== 'all' && !SPOT_ID.test(spot))) {
    return error(400, 'Use /api/forecast?spot=<id> or ?spot=all')
  }

  const raw = (env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  const base = /^https?:\/\//.test(raw) ? raw : `https://${raw}`
  const key = (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!raw || !key) return error(503, 'Forecast API not configured')
  const headers: Record<string, string> = { apikey: key }
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}` // legacy JWT keys

  const path = spot === 'all' ? 'index.json' : `spots/${spot}.json`
  // Started at the same time as the file, so they don't add to the wait.
  const extrasP = (spot === 'all' ? homeExtras(env) : spotExtras(env, spot)).catch(() => null)
  let res: Response
  try {
    res = await fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, { headers, signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    console.error('forecast API', err)
    return error(502, 'Storage did not answer')
  }
  // Storage says 400 {"error":"not_found"} for a missing object.
  if (res.status === 404 || res.status === 400) return error(404, `No forecast for ${spot}`)
  if (!res.ok) return error(502, `Storage HTTP ${res.status}`)

  let body: string
  try {
    const file = (await res.json()) as Record<string, unknown>
    const extras = await extrasP
    body = JSON.stringify(extras ? { ...file, extras } : file)
  } catch (err) {
    console.error('forecast API', err)
    return error(502, 'Bad forecast file')
  }
  return new Response(request.method === 'HEAD' ? null : body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${BROWSER_S}`,
      // Read by Vercel's CDN only (not passed on to browsers).
      'Vercel-CDN-Cache-Control': `max-age=${CDN_FRESH_S}, stale-while-revalidate=${CDN_STALE_S}`,
    },
  })
}

// Vercel (Node runtime, web-standard handler).
export function GET(request: Request): Promise<Response> {
  return handleForecast(request, process.env)
}
export function HEAD(request: Request): Promise<Response> {
  return handleForecast(request, process.env)
}
