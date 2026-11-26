// Forecast API (Vercel function): GET /api/forecast?spot=<id>  -> that spot's forecast file
//                                  GET /api/forecast?spot=all   -> index.json (home screen)
// The files are written every hour by jobs/collect_forecast.py into the private Supabase bucket
// `forecast-files`; the app never calls Open-Meteo itself.
//
// Cost: Vercel's CDN keeps each answer for CDN_FRESH_S and then serves the old copy while it
// fetches a new one in the background (CDN_STALE_S), so thousands of visitors cost one
// Supabase download per spot per region every few minutes. Any other URL shape (extra
// parameters, upper case...) is refused, so nobody can bypass the cache with ?x=random.
//
// Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (server-side only, same as api/admin.ts).
// In `npm run dev` the same handler runs inside Vite (vite.config.ts devApi).

type Env = Record<string, string | undefined>

const BUCKET = 'forecast-files'
/** Fresh at the CDN for 15 min (the job publishes every ~3 h; 15 instead of 5 min = a third of the
 *  function calls and origin transfer, docs/free-plan-limits.md); then stale-while-revalidate
 *  for up to a day (job hiccups). */
const CDN_FRESH_S = 900
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

  return new Response(request.method === 'HEAD' ? null : await res.arrayBuffer(), {
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
