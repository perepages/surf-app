// Loaded lazily (React.lazy) so Recharts doesn't slow down the first screen.

import { useReducedMotion } from 'framer-motion'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts'
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent'
import { averageMiss, type ChartRow } from '../lib/chartData'
import { learnedFrom, type ModelInfo } from '../lib/modelInfo'

// Series colours, validated for the dark surface with the dataviz palette checker
// (lightness band, chroma, colour-blind separation, contrast). Each series also has its own
// line style, so identity never depends on colour alone.
const SERIES = [
  { key: 'simple', name: 'Simple score', color: '#4a8fe0', dash: '6 4', dot: false },
  { key: 'ai', name: 'AI score', color: '#b88310', dash: undefined, dot: false },
  { key: 'surfers', name: 'Surfers', color: '#1ca88a', dash: undefined, dot: true },
] as const

const fmt = (x: number | null | undefined) => (x == null ? '–' : x.toFixed(1))

export default function ForecastVsSurfers({ rows, model }: { rows: ChartRow[]; model?: ModelInfo | null }) {
  const reduce = useReducedMotion()
  const hasAi = rows.some((r) => r.ai != null)
  const hasSurfers = rows.some((r) => r.surfers != null)
  const shown = SERIES.filter((s) => s.key !== 'ai' || hasAi)
  const simpleMiss = averageMiss(rows, 'simple')
  const aiMiss = averageMiss(rows, 'ai')

  return (
    <section aria-labelledby="fvs-title" className="px-4 pt-10 sm:px-8">
      <h2 id="fvs-title" className="font-display text-2xl font-extrabold">
        Forecast vs surfers
      </h2>
      <p className="mt-1 max-w-[60ch] text-sm text-mist">
        Last {rows.length} days. Where the lines split, the forecast was wrong.
      </p>

      {/* Headline: how far off each score was, on days people rated. */}
      {simpleMiss && (
        <p className="mt-3 max-w-[60ch]">
          The simple score was off by <strong className="tabular-nums">{simpleMiss.miss.toFixed(1)}</strong> on average
          {aiMiss ? (
            <>
              , the AI score by <strong className="tabular-nums">{aiMiss.miss.toFixed(1)}</strong>
            </>
          ) : null}{' '}
          ({simpleMiss.days} {simpleMiss.days === 1 ? 'day' : 'days'} with ratings).
        </p>
      )}

      {model?.active && <AiVsForecast model={model} />}

      {/* Legend: always present, with each series' line style. */}
      <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm" aria-label="Legend">
        {shown.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <Swatch color={s.color} dash={s.dash} dot={s.dot} />
            {s.name}
          </li>
        ))}
      </ul>

      <div className="mt-2 h-56 w-full" role="img" aria-label="Line chart of daily simple score, AI score and surfer rating; the same numbers are in the table below.">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
            <CartesianGrid vertical={false} stroke="#0f5257" strokeOpacity={0.6} />
            <XAxis
              dataKey="label"
              tick={{ fill: '#8fb3bc', fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: '#0f5257' }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis domain={[1, 5]} ticks={[1, 2, 3, 4, 5]} tick={{ fill: '#8fb3bc', fontSize: 11 }} tickLine={false} axisLine={false} />
            <Tooltip content={ChartTooltip} cursor={{ stroke: '#8fb3bc', strokeWidth: 1 }} />
            {shown.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.name}
                type="monotone"
                stroke={s.color}
                strokeWidth={2}
                strokeDasharray={s.dash}
                // Surfers: dots with a ring in the surface colour so they stay visible on top of lines.
                dot={s.dot ? { r: 4, fill: s.color, stroke: '#031b26', strokeWidth: 2 } : false}
                activeDot={{ r: 5, stroke: '#031b26', strokeWidth: 2 }}
                connectNulls={false}
                isAnimationActive={!reduce}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {!hasSurfers && (
        <p className="mt-2 text-sm text-mist">No surfer ratings in the last {rows.length} days yet, so there’s nothing to compare against.</p>
      )}
      {!hasAi && <p className="mt-2 text-sm text-mist">The AI score appears here once a model has been trained on enough ratings.</p>}

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-mist hover:text-foam">Show as a table</summary>
        <table className="mt-2 w-full max-w-md tabular-nums">
          <thead className="text-left text-mist">
            <tr>
              <th className="py-1 font-normal">Day</th>
              <th className="py-1 text-right font-normal">Simple</th>
              {hasAi && <th className="py-1 text-right font-normal">AI</th>}
              <th className="py-1 text-right font-normal">Surfers</th>
              <th className="py-1 text-right font-normal">Reports</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.day} className="border-t border-kelp/50">
                <td className="py-1">{r.label}</td>
                <td className="py-1 text-right">{fmt(r.simple)}</td>
                {hasAi && <td className="py-1 text-right">{fmt(r.ai)}</td>}
                <td className="py-1 text-right">{fmt(r.surfers)}</td>
                <td className="py-1 text-right">{r.reports || '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  )
}

const times = (n: number) => `${n} ${n === 1 ? 'time' : 'times'}`

/**
 * Per rated hour (not per day): was the AI score or the raw forecast closer to what the surfer
 * said? Counted by the database (spot_model_info), as the app shows the scores (whole 1-5).
 */
function AiVsForecast({ model }: { model: ModelInfo }) {
  const { compared, aiCloser, simpleCloser, days } = model
  const same = Math.max(0, compared - aiCloser - simpleCloser)
  const learned = learnedFrom(model)
  const parts = [
    { n: aiCloser, label: 'AI closer', color: SERIES[1].color },
    { n: same, label: 'Same', color: '#3d6470' },
    { n: simpleCloser, label: 'Forecast closer', color: SERIES[0].color },
  ].filter((p) => p.n > 0)

  return (
    <div className="mt-4 max-w-[60ch]">
      {compared > 0 ? (
        <>
          <p>
            On <strong className="tabular-nums">{compared}</strong> rated {compared === 1 ? 'hour' : 'hours'} in the last{' '}
            {days} days, the AI was closer to what surfers said <strong className="tabular-nums">{times(aiCloser)}</strong>,
            the raw forecast <strong className="tabular-nums">{times(simpleCloser)}</strong>
            {same > 0 ? <> (equally close {times(same)})</> : null}.
          </p>
          {/* One bar, split by who was closer; a 2px gap between segments, labels below. */}
          <div className="mt-2 flex h-2 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
            {parts.map((p) => (
              <span key={p.label} style={{ flexGrow: p.n, backgroundColor: p.color }} className="h-full first:rounded-l-full last:rounded-r-full" />
            ))}
          </div>
          <ul className="mt-1 flex flex-wrap gap-x-4 text-xs text-mist" aria-hidden>
            {parts.map((p) => (
              <li key={p.label} className="flex items-center gap-1.5 tabular-nums">
                <span className="size-2 rounded-full" style={{ backgroundColor: p.color }} />
                {p.label} {p.n}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-mist">No rated hours with an AI score in the last {days} days yet.</p>
      )}
      {learned && (
        <p className="mt-2 text-sm text-mist">
          The AI score has {learned.charAt(0).toLowerCase() + learned.slice(1)} so far. Every rating helps it.
        </p>
      )}
    </div>
  )
}

function ChartTooltip({ active, payload, label }: TooltipContentProps<ValueType, NameType>) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload as ChartRow
  return (
    <div className="rounded-lg border border-kelp bg-abyss/95 px-3 py-2 text-sm shadow-lg">
      <p className="mb-1 font-semibold">{label}</p>
      {SERIES.filter((s) => s.key !== 'ai' || row.ai != null).map((s) => (
        <p key={s.key} className="flex items-center gap-2 tabular-nums">
          <Swatch color={s.color} dash={s.dash} dot={s.dot} />
          <span className="text-mist">{s.name}</span>
          <span className="ml-auto pl-3">{fmt(row[s.key])}</span>
        </p>
      ))}
      <p className="mt-1 text-xs text-mist">
        {row.reports ? `${row.reports} ${row.reports === 1 ? 'report' : 'reports'}` : 'No reports'}
      </p>
    </div>
  )
}

function Swatch({ color, dash, dot }: { color: string; dash?: string; dot: boolean }) {
  return (
    <svg width="22" height="10" aria-hidden className="shrink-0">
      <line x1="1" x2="21" y1="5" y2="5" stroke={color} strokeWidth="2" strokeDasharray={dash} />
      {dot && <circle cx="11" cy="5" r="3.5" fill={color} stroke="#031b26" strokeWidth="1.5" />}
    </svg>
  )
}
