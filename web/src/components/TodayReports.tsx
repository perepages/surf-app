import { memo } from 'react'
import { hh } from '../lib/format'
import { CROWDS, WAVE_SIZES } from '../lib/ratings'
import type { ReportsState } from '../lib/reports'

const label = <T extends string>(items: readonly { id: T; label: string }[], id: T | null) =>
  items.find((i) => i.id === id)?.label ?? null

/** Part of the day from the local hour of a session (slots are 09/12/16/19, or "now" if earlier). */
function partOfDay(unix: number, tz: string): string {
  const h = Number(hh(unix, tz))
  if (h < 11) return 'morning'
  if (h < 14) return 'midday'
  if (h < 18) return 'afternoon'
  return 'evening'
}

/**
 * "Surfers today": average rating, most common wave size and crowd, the latest comment, and the
 * rate button. The button is always there, even while reports load or can't be loaded.
 */
export const TodayReports = memo(function TodayReports({
  reports,
  timezone,
  onRate,
}: {
  reports: ReportsState
  timezone: string
  onRate: () => void
}) {
  const t = reports.status === 'ready' ? reports.today : null
  const tags = t ? [label(WAVE_SIZES, t.waveSize), label(CROWDS, t.crowd)].filter((x): x is string => !!x) : []
  const [latest, ...older] = t?.comments ?? []

  return (
    <section aria-labelledby="reports-title" className="mx-4 flex flex-col gap-3.5 rounded-3xl border border-line bg-card px-6 py-5 sm:mx-8">
      <div className="flex items-baseline justify-between">
        <h2 id="reports-title" className="font-display text-[26px] font-extrabold">
          Surfers today
        </h2>
        {t && t.count > 0 && (
          <span className="text-[13px] text-mist">
            {t.count} {t.count === 1 ? 'report' : 'reports'}
          </span>
        )}
      </div>

      {t && t.count === 0 && <p className="text-mist">No reports yet today. Surfed? Rate your session and you’ll be the first.</p>}

      {t && t.count > 0 && (
        <>
          <div className="flex items-center gap-3">
            <span className="font-display text-5xl leading-none font-black tabular-nums">{t.avgOverall?.toFixed(1)}</span>
            <span className="text-sm leading-tight text-mist">
              average rating
              <br />
              out of 5
            </span>
          </div>
          {tags.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label="Most reported">
              {tags.map((tag) => (
                <li key={tag} className="rounded-full bg-sea px-3 py-1.5 text-[13px]">
                  {tag}
                </li>
              ))}
            </ul>
          )}
          {latest && (
            <p className="text-[15px] leading-relaxed break-words">
              “{latest.comment}” <span className="text-mist">· {latest.overall}/5 · {partOfDay(latest.surfedAt, timezone)}</span>
            </p>
          )}
          {older.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-mist hover:text-foam">
                {older.length} more {older.length === 1 ? 'comment' : 'comments'}
              </summary>
              <ul className="mt-2 space-y-2">
                {older.map((c, i) => (
                  <li key={i} className="break-words">
                    “{c.comment}” <span className="text-mist">· {c.overall}/5 · {partOfDay(c.surfedAt, timezone)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      <button
        type="button"
        onClick={onRate}
        className="flex h-16 flex-col justify-center rounded-2xl bg-foam px-5 text-left text-abyss transition-colors hover:bg-glass"
      >
        <span className="font-display text-[26px] leading-none font-extrabold">I surfed — rate it</span>
        <span className="text-xs text-[#2c4a52]">Tell the forecast how it really was</span>
      </button>
    </section>
  )
})
