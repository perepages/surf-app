import { SUPABASE_TIMEOUT_MS, withTimeout } from './http'

// Minimal read-only access to Supabase's REST API (PostgREST) with the public key.
// Row-level security decides what the public key can see (spots, forecasts, predictions).

const rawUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? ''
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? ''

export const supabaseConfigured = rawUrl !== '' && key !== ''

function baseUrl(): string {
  const url = rawUrl.replace(/\/+$/, '')
  return /^https?:\/\//.test(url) ? url : `https://${url}`
}

/** New keys (sb_publishable_...) go in `apikey` only; legacy JWT keys also as Bearer. */
function headers(): Record<string, string> {
  const h: Record<string, string> = { apikey: key }
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`
  return h
}

/**
 * POST one row with `return=minimal`: the public may insert ratings but not read them back,
 * so asking for the row in the response would fail.
 */
export async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
  if (!supabaseConfigured) throw new Error('Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)')
  await withTimeout(undefined, SUPABASE_TIMEOUT_MS, 'The database', async (signal) => {
    const res = await fetch(`${baseUrl()}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(row),
      signal,
    })
    if (!res.ok) {
      let detail = ''
      try {
        const body = (await res.json()) as { message?: string }
        detail = body.message ?? ''
      } catch {
        /* no JSON body */
      }
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
    }
  })
}

/** GET /rest/v1/<table>?<query>. `query` is a PostgREST query string, already encoded. */
export async function selectRows<T>(table: string, query: string, signal?: AbortSignal): Promise<T[]> {
  if (!supabaseConfigured) throw new Error('Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)')
  return withTimeout(signal, SUPABASE_TIMEOUT_MS, `Supabase ${table}`, async (s) => {
    const res = await fetch(`${baseUrl()}/rest/v1/${table}?${query}`, { headers: headers(), signal: s })
    if (!res.ok) throw new Error(`Supabase ${table}: HTTP ${res.status}`)
    return (await res.json()) as T[]
  })
}

/** POST /rest/v1/rpc/<fn>: calls a database function the public may execute. */
export async function rpc<T>(fn: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  if (!supabaseConfigured) throw new Error('Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)')
  return withTimeout(signal, SUPABASE_TIMEOUT_MS, `Supabase ${fn}`, async (s) => {
    const res = await fetch(`${baseUrl()}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: s,
    })
    if (!res.ok) throw new Error(`Supabase ${fn}: HTTP ${res.status}`)
    return (await res.json()) as T
  })
}
