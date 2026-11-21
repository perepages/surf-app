import { useState, type FormEvent, type ReactNode } from 'react'
import { CROWDS, SURFACES, WAVE_SIZES } from '../lib/ratings'

// /admin: usage counts and the latest ratings, with a button to hide spam.
// The password is checked by the server (api/admin.ts); this page only holds it in memory
// while open, so a reload asks again. Nothing here works without the right password.

const TZ = 'Europe/Madrid' // shown times; the counts themselves are per UTC day

interface Day {
  day: string
  visits: number
  appVisits: number
  installs: number
  ratings: number
  hidden: number
}
interface Rating {
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
  device: string | null
  near_beach: boolean | null
  app_version: string | null
  hidden: boolean
}
interface Summary {
  days: Day[]
  latest: Rating[]
}

const SCORE_BG = ['', 'bg-s1 text-foam', 'bg-s2 text-foam', 'bg-s3 text-abyss', 'bg-s4 text-abyss', 'bg-s5 text-abyss']

async function callAdmin<T>(password: string, body: object): Promise<T> {
  const res = await fetch('/api/admin', {
    method: 'POST',
    // trim: copying from .env often picks up a space or line break at either end.
    headers: { Authorization: `Bearer ${password.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data as T
}

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  )
const dayLabel = (day: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${day}T00:00:00Z`))
const label = (items: readonly { id: string; label: string }[], id: string | null) => (id ? (items.find((i) => i.id === id)?.label ?? id) : null)

export default function AdminPage() {
  const [password, setPassword] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [data, setData] = useState<Summary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (pw = password) => {
    setBusy(true)
    setError(null)
    try {
      setData(await callAdmin<Summary>(pw, { action: 'summary' }))
      setUnlocked(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onLogin = (e: FormEvent) => {
    e.preventDefault()
    if (password) void load()
  }

  const lock = () => {
    setPassword('')
    setUnlocked(false)
    setData(null)
    setError(null)
  }

  const setHidden = async (id: number, hidden: boolean) => {
    setError(null)
    try {
      await callAdmin(password, { action: 'hide', id, hidden })
      // Update this row right away, then refresh the counts.
      setData((d) => d && { ...d, latest: d.latest.map((r) => (r.id === id ? { ...r, hidden } : r)) })
      void load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!unlocked) {
    return (
      <main className="mx-auto max-w-md px-4 pt-16 pb-10">
        <h1 className="font-display text-5xl font-black">Admin</h1>
        <form onSubmit={onLogin} className="mt-6 flex flex-col gap-3">
          <label htmlFor="admin-password" className="text-mist">
            Password
          </label>
          <input
            id="admin-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-lg border border-kelp bg-deep px-3 py-2.5 text-foam outline-none focus:border-glass"
          />
          <button
            type="submit"
            disabled={busy || !password}
            className="rounded-lg bg-foam px-4 py-2.5 font-semibold text-abyss hover:bg-glass disabled:opacity-50"
          >
            {busy ? 'Checking…' : 'Open'}
          </button>
          {error && (
            <p role="alert" className="text-coral">
              {error}
            </p>
          )}
        </form>
        <a href="/" className="mt-8 inline-block text-sm text-mist underline underline-offset-2 hover:text-foam">
          Back to the forecast
        </a>
      </main>
    )
  }

  const days = data?.days ?? []
  const sum = (n: number, f: (d: Day) => number) => days.slice(0, n).reduce((a, d) => a + f(d), 0)
  const maxVisits = Math.max(1, ...days.map((d) => d.visits + d.appVisits))

  return (
    <main className="mx-auto max-w-4xl px-4 pt-6 pb-10 sm:px-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto font-display text-5xl font-black">Admin</h1>
        <button type="button" onClick={() => void load()} disabled={busy} className="rounded-lg border border-kelp px-3 py-1.5 hover:border-mist disabled:opacity-50">
          {busy ? 'Loading…' : 'Refresh'}
        </button>
        <button type="button" onClick={lock} className="rounded-lg border border-kelp px-3 py-1.5 hover:border-mist">
          Lock
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-coral">
          {error}
        </p>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat title="Visits, 7 days" value={sum(7, (d) => d.visits + d.appVisits)} note={`${sum(30, (d) => d.visits + d.appVisits)} in 30 days`} />
        <Stat title="From installed app, 7 days" value={sum(7, (d) => d.appVisits)} note={`${sum(30, (d) => d.appVisits)} in 30 days`} />
        <Stat title="Installs, 7 days" value={sum(7, (d) => d.installs)} note={`${sum(30, (d) => d.installs)} in 30 days`} />
        <Stat title="Ratings, 7 days" value={sum(7, (d) => d.ratings)} note={`${sum(30, (d) => d.ratings)} in 30 days`} />
      </div>
      <p className="mt-2 text-sm text-mist">
        Visits = app opens (a reload counts again), counted only on the live site. Installs are reported by Chrome, Edge
        and Android only, never by iPhone. Hidden ratings aren’t counted.
      </p>

      <Section title="Last 30 days">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left tabular-nums">
            <thead className="text-sm text-mist">
              <tr>
                <th className="py-1.5 pr-3 font-normal">Day (UTC)</th>
                <th className="py-1.5 pr-3 font-normal">Visits</th>
                <th className="w-1/4 py-1.5 pr-3 font-normal" aria-hidden />
                <th className="py-1.5 pr-3 font-normal">Installed app</th>
                <th className="py-1.5 pr-3 font-normal">Installs</th>
                <th className="py-1.5 pr-3 font-normal">Ratings</th>
                <th className="py-1.5 font-normal">Hidden</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day} className="border-t border-deep">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{dayLabel(d.day)}</td>
                  <td className="py-1.5 pr-3">{d.visits + d.appVisits}</td>
                  <td className="py-1.5 pr-3" aria-hidden>
                    <div className="h-2 rounded-full bg-s3" style={{ width: `${((d.visits + d.appVisits) / maxVisits) * 100}%` }} />
                  </td>
                  <td className="py-1.5 pr-3">{d.appVisits}</td>
                  <td className="py-1.5 pr-3">{d.installs}</td>
                  <td className="py-1.5 pr-3 font-semibold">{d.ratings}</td>
                  <td className="py-1.5 text-mist">{d.hidden || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={`Latest ${data?.latest.length ?? 0} ratings`}>
        {data?.latest.length === 0 && <p className="text-mist">No ratings yet.</p>}
        <ul className="space-y-3">
          {data?.latest.map((r) => (
            <li key={r.id} className={`rounded-xl border border-kelp p-3 ${r.hidden ? 'opacity-50' : ''}`}>
              <div className="flex flex-wrap items-start gap-3">
                <span className={`grid size-11 shrink-0 place-items-center rounded-lg font-display text-2xl font-extrabold ${SCORE_BG[r.overall]}`}>
                  {r.overall}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    Surfed {when(r.surfed_at)}
                    {r.hidden && <span className="ml-2 rounded bg-coral px-1.5 py-0.5 text-xs text-abyss">hidden</span>}
                  </p>
                  <p className="text-sm text-mist">
                    {[label(WAVE_SIZES, r.wave_size), label(SURFACES, r.surface), label(CROWDS, r.crowd) && `crowd: ${label(CROWDS, r.crowd)}`]
                      .filter(Boolean)
                      .join(' · ') || 'No details'}
                  </p>
                  {r.comment && <p className="mt-1.5 break-words">“{r.comment}”</p>}
                  <p className="mt-1.5 text-xs text-mist">
                    #{r.id} · sent {when(r.created_at)} · {r.source}
                    {r.device && ` · device ${r.device}…`}
                    {r.near_beach && ' · at the beach'}
                    {r.app_version && ` · v${r.app_version}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void setHidden(r.id, !r.hidden)}
                  className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold ${
                    r.hidden ? 'border border-kelp hover:border-mist' : 'bg-coral text-abyss hover:opacity-90'
                  }`}
                >
                  {r.hidden ? 'Show again' : 'Hide as spam'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </main>
  )
}

function Stat({ title, value, note }: { title: string; value: number; note: string }) {
  return (
    <div className="rounded-xl border border-kelp p-3">
      <p className="text-sm text-mist">{title}</p>
      <p className="font-display text-4xl font-extrabold tabular-nums">{value}</p>
      <p className="text-xs text-mist">{note}</p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 font-display text-2xl font-extrabold">{title}</h2>
      {children}
    </section>
  )
}
