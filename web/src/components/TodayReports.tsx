import { memo } from 'react'
import { hh } from '../lib/format'
import { CROWDS, WAVE_SIZES } from '../lib/ratings'
import type { ReportsState } from '../lib/reports'
import { toScoreValue } from '../scoring/types'

const SCORE_BG = ['', 'bg-s1 text-foam', 'bg-s2 text-foam', 'bg-s3 text-abyss', 'bg-s4 text-abyss', 'bg-s5 text-abyss']

const label = <T extends string>(items: readonly { id: T; label: string }[], id: T | null) =>
  items.find((i) => i.id === id)?.label ?? null

/** Part of the day from the local hour of a session (slots are 09/12/16/19, or "now" if earlier). */
function partOfDay(unix: number, tz: string): string {
  const h = Number(hh(unix, tz))
  if (h < 11) return 'Morning'
  if (h < 14) return 'Midday'
  if (h < 18) return 'Afternoon'
  return 'Evening'
}

/** What surfers reported today: average, most common wave size and crowd, latest comments. */
export const TodayReports = memo(function TodayReports({ reports, timezone }: { reports: ReportsState; timezone: string }) {
  if (reports.status !== 'ready') return null // loading, or summaries not available: no empty box
  const t = reports.today

  return (
    <section aria-labelledby="reports-title" className="px-4 pb-10 sm:px-8">
      <h2 id="reports-title" className="font-display text-2xl font-extrabold">
        Surfers today
      </h2>

      {t.count === 0 ? (
        <p className="mt-2 text-mist">No reports yet today. Surfed? Rate your session and you’ll be the first.</p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-x-8 gap-y-4">
            <div className="flex items-center gap-3">
              <span
                className={`grid size-14 place-items-center rounded-xl font-display text-3xl font-extrabold tabular-nums ${
                  SCORE_BG[toScoreValue(t.avgOverall ?? 1)]
                }`}
              >
                {t.avgOverall?.toFixed(1)}
              </span>
              <span className="text-mist">
                average from {t.count} {t.count === 1 ? 'report' : 'reports'}
              </span>
            </div>
            <dl className="flex gap-8">
              <div>
                <dt className="text-sm text-mist">Waves</dt>
                <dd className="font-display text-2xl font-extrabold">{label(WAVE_SIZES, t.waveSize) ?? '–'}</dd>
              </div>
              <div>
                <dt className="text-sm text-mist">Crowd</dt>
                <dd className="font-display text-2xl font-extrabold">{label(CROWDS, t.crowd) ?? '–'}</dd>
              </div>
            </dl>
          </div>

          {t.comments.length > 0 && (
            <ul className="mt-5 space-y-3">
              {t.comments.map((c, i) => (
                <li key={i} className="flex gap-3">
                  <span
                    className={`grid size-7 shrink-0 place-items-center rounded-md font-display text-lg font-extrabold ${
                      SCORE_BG[toScoreValue(c.overall)]
                    }`}
                    aria-label={`rated ${c.overall}`}
                  >
                    {c.overall}
                  </span>
                  <div className="min-w-0">
                    <p className="break-words">{c.comment}</p>
                    <p className="text-xs text-mist">{partOfDay(c.surfedAt, timezone)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
})
