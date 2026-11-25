// Under the verdict: the three scores (Waves / Shape / Comfort), why the waves are messy when
// other swells cross the main one, rain / thunderstorm info, safety warnings and a wetsuit tip.

import type { HourConditions } from '../lib/openMeteo'
import { fmt } from '../scoring/physics'
import type { Score } from '../scoring/types'

const BAR = ['', 'bg-s1', 'bg-s2', 'bg-s3', 'bg-s4', 'bg-s5']

function Part({ name, value, note }: { name: string; value: number; note: string }) {
  const v = Math.min(5, Math.max(1, Math.round(value)))
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-mist">{name}</span>
        <span className="font-display text-lg leading-none font-extrabold tabular-nums">{fmt(value, 1)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-abyss/60" role="img" aria-label={`${name} ${fmt(value, 1)} of 5: ${note}`}>
        <div className={`h-full rounded-full ${BAR[v]}`} style={{ width: `${((value - 1) / 4) * 100}%`, minWidth: '6%' }} />
      </div>
      <span className="text-[11px] leading-tight text-mist">{note}</span>
    </div>
  )
}

const wavesNote = (w: number) => (w < 1.5 ? 'too small' : w < 2.5 ? 'small' : w < 3.5 ? 'fun size' : w < 4.5 ? 'good size' : 'big')
const shapeNote = (s: number) => (s >= 4.5 ? 'clean' : s >= 3.5 ? 'fairly clean' : s >= 2.5 ? 'bumpy' : 'messy')

function comfortNote(causes: string[], dark: boolean): string {
  if (dark) return 'dark'
  if (causes.includes('rain')) return 'rain'
  if (causes.includes('drizzle')) return 'some rain'
  if (causes.includes('cold_air') || causes.includes('cold_water')) return 'cold'
  return 'dry'
}

/** "🌧 70% chance of rain · 1.2 mm" / "⛈ Thunderstorm risk" / null when dry and calm. */
export function weatherLine(h: HourConditions): string | null {
  const thunder = h.weatherCode != null && [95, 96, 99].includes(h.weatherCode)
  if (thunder) return '⛈ Thunderstorm forecast'
  const prob = h.precipProb
  const mm = h.precipitation
  if ((prob ?? 0) > 20 || (mm ?? 0) >= 0.1) {
    return [`🌧 ${prob != null ? `${prob}% chance of rain` : 'Rain'}`, mm != null && mm >= 0.1 ? `${fmt(mm, 1)} mm` : null].filter(Boolean).join(' · ')
  }
  return null
}

export function ScoreDetails({ score, hour }: { score: Score; hour: HourConditions }) {
  const p = score.physics
  if (!p || !score.parts) return null
  const dark = p.features.daylight === false
  const weather = weatherLine(hour)
  const temps = [
    hour.airTemp != null ? `Air ${fmt(hour.airTemp)}°C` : null,
    hour.seaTemp != null ? `water ${fmt(hour.seaTemp)}°C` : null,
    p.wetsuit ? `wetsuit ${p.wetsuit}` : null,
  ].filter(Boolean)
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-3">
        <Part name="Waves" value={score.parts.waves} note={wavesNote(score.parts.waves)} />
        <Part name="Shape" value={score.parts.shape} note={shapeNote(score.parts.shape)} />
        <Part name="Comfort" value={score.parts.comfort} note={comfortNote(p.comfortCauses, dark)} />
      </div>

      {p.warnings.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Safety warnings">
          {p.warnings.map((w) => (
            <li key={w.kind} role="alert" className="rounded-lg border border-coral/50 bg-coral/10 px-3 py-2 text-sm font-semibold text-coral-text">
              ⚠ {w.text}
            </li>
          ))}
        </ul>
      )}

      {p.mess && (
        <div className="rounded-lg border border-sand/35 px-3 py-2">
          <p className="text-xs font-semibold tracking-[0.04em] text-sand">WHY THE WAVES ARE MESSY</p>
          <p className="text-sm leading-snug">{p.mess}</p>
        </div>
      )}

      {(weather || temps.length > 0) && (
        <p className="text-sm text-mist">
          {weather && <span className="font-semibold text-foam">{weather}</span>}
          {weather && temps.length > 0 && ' · '}
          {temps.join(' · ')}
        </p>
      )}
    </div>
  )
}
