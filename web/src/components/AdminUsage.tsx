// /admin "Free plan" panel: how close each free limit is (api/admin.ts action "usage",
// migration 24). Red from 80% of a limit. Numbers no API gives (Supabase egress, Vercel) are
// listed with a link to the dashboard that shows them.

export interface UsageMetric {
  key: string
  label: string
  used: number
  limit: number
  unit: 'bytes' | 'calls'
  share: number
  alert: boolean
  note: string
}
export interface Usage {
  measuredAt: string
  alertAt: number
  metrics: UsageMetric[]
  tables: { name: string; bytes: number; rows_estimate: number }[]
  storage: { bucket: string; files: number; bytes: number }[]
  apiDays: { day: string; calls: number; requests: number }[]
  notReadable: { label: string; limit: string; where: string; url: string }[]
}

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`)
const amount = (m: UsageMetric, v: number) => (m.unit === 'bytes' ? mb(v) : Math.round(v).toLocaleString('en-GB'))
const pct = (share: number) => `${share < 0.01 && share > 0 ? '<1' : Math.round(share * 100)}%`

export function UsagePanel({ usage, error }: { usage: Usage | null; error: string | null }) {
  if (error) {
    return (
      <p role="status" className="text-sand">
        Usage: {error}
      </p>
    )
  }
  if (!usage) return <p className="text-mist">Loading usage…</p>
  const alerts = usage.metrics.filter((m) => m.alert)
  return (
    <div>
      {alerts.length > 0 && (
        <p role="alert" className="mb-3 rounded-lg border border-coral px-3 py-2 text-coral">
          Over {Math.round(usage.alertAt * 100)}% of a free limit: {alerts.map((m) => `${m.label} (${pct(m.share)})`).join(', ')}.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        {usage.metrics.map((m) => (
          <div key={m.key} className={`rounded-xl border p-3 ${m.alert ? 'border-coral' : 'border-kelp'}`}>
            <p className="text-sm text-mist">{m.label}</p>
            <p className="mt-1 font-display text-3xl font-black tabular-nums">
              {pct(m.share)} <span className="text-base font-normal text-mist">of the free limit</span>
            </p>
            <div
              className="mt-2 h-2 overflow-hidden rounded-full bg-deep"
              role="meter"
              aria-label={m.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, Math.round(m.share * 100))}
            >
              <div className={`h-full ${m.alert ? 'bg-coral' : 'bg-glass'}`} style={{ width: `${Math.min(100, Math.max(1, m.share * 100))}%` }} />
            </div>
            <p className="mt-2 text-sm tabular-nums">
              {amount(m, m.used)} of {amount(m, m.limit)}
            </p>
            <p className="mt-1 text-xs text-mist">{m.note}</p>
          </div>
        ))}
      </div>

      <h3 className="mt-5 mb-2 font-semibold">Not readable automatically</h3>
      <ul className="space-y-1.5 text-sm">
        {usage.notReadable.map((n) => (
          <li key={n.label}>
            <span className="font-semibold">{n.label}</span> <span className="text-mist">(free: {n.limit})</span>:{' '}
            <a href={n.url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-glass">
              {n.where}
            </a>
          </li>
        ))}
      </ul>

      <details className="mt-5">
        <summary className="cursor-pointer font-semibold">Biggest tables, files, Open-Meteo per day</summary>
        <div className="mt-3 grid gap-5 sm:grid-cols-3">
          <table className="text-left text-sm tabular-nums">
            <thead className="text-mist">
              <tr>
                <th className="pr-3 font-normal">Table</th>
                <th className="pr-3 font-normal">Size</th>
                <th className="font-normal">Rows ≈</th>
              </tr>
            </thead>
            <tbody>
              {usage.tables.map((t) => (
                <tr key={t.name}>
                  <td className="pr-3">{t.name}</td>
                  <td className="pr-3">{mb(t.bytes)}</td>
                  <td>{t.rows_estimate.toLocaleString('en-GB')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="text-left text-sm tabular-nums">
            <thead className="text-mist">
              <tr>
                <th className="pr-3 font-normal">Bucket</th>
                <th className="pr-3 font-normal">Files</th>
                <th className="font-normal">Size</th>
              </tr>
            </thead>
            <tbody>
              {usage.storage.map((s) => (
                <tr key={s.bucket}>
                  <td className="pr-3">{s.bucket}</td>
                  <td className="pr-3">{s.files}</td>
                  <td>{mb(s.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="text-left text-sm tabular-nums">
            <thead className="text-mist">
              <tr>
                <th className="pr-3 font-normal">Day (UTC)</th>
                <th className="pr-3 font-normal">Calls</th>
                <th className="font-normal">Requests</th>
              </tr>
            </thead>
            <tbody>
              {usage.apiDays.length === 0 && (
                <tr>
                  <td colSpan={3} className="text-mist">
                    None counted yet
                  </td>
                </tr>
              )}
              {usage.apiDays.map((a) => (
                <tr key={a.day}>
                  <td className="pr-3">{a.day}</td>
                  <td className="pr-3">{a.calls}</td>
                  <td>{a.requests}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className="mt-3 text-xs text-mist">
        Measured {new Date(usage.measuredAt).toLocaleString('en-GB', { timeZone: 'Europe/Madrid' })}. Limits checked 26 Nov 2026; the
        nightly job emails a failed run when one passes {Math.round(usage.alertAt * 100)}%.
      </p>
    </div>
  )
}
