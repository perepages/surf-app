// Display helpers. Data is UTC; everything shown is in the spot's local time zone.

const cache = new Map<string, Intl.DateTimeFormat>()
function fmt(timeZone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = timeZone + JSON.stringify(opts)
  let f = cache.get(k)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, ...opts })
    cache.set(k, f)
  }
  return f
}

/** "14:00" */
export const hhmm = (unix: number, tz: string) =>
  fmt(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(unix * 1000)

/** "14" */
export const hh = (unix: number, tz: string) => fmt(tz, { hour: '2-digit', hourCycle: 'h23' }).format(unix * 1000)

/** "Sat" */
export const weekday = (unix: number, tz: string) => fmt(tz, { weekday: 'short' }).format(unix * 1000)

/** "21" */
export const dayOfMonth = (unix: number, tz: string) => fmt(tz, { day: 'numeric' }).format(unix * 1000)

/** Tide in cm with sign, e.g. "+12". The Mediterranean tide is only a few tens of cm. */
export const tideCm = (m: number | null) => (m == null ? '–' : `${m > 0 ? '+' : ''}${Math.round(m * 100)}`)

export const num = (x: number | null, digits = 1) => (x == null ? '–' : x.toFixed(digits))

/** Local date at the spot, "YYYY-MM-DD" (same format as ForecastDay.date). */
export const localDate = (unix: number, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(unix * 1000)
