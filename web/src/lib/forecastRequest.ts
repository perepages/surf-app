// Where the app gets its forecast. Pure (no browser APIs, no imports) so vite.config.ts can use
// the same values to write the prefetch into index.html: the URLs always match.
//
// The app never calls Open-Meteo itself: the hourly job (jobs/collect_forecast.py) fetches each
// spot once and publishes a file; /api/forecast (web/api/forecast.ts) serves it through
// Vercel's CDN.

/** One spot's file (14 days back .. 5 days ahead), or `all` = the home screen's file. */
export const forecastUrl = (spotId: string) => `/api/forecast?spot=${encodeURIComponent(spotId)}`
export const SPOT_LIST_URL = forecastUrl('all')

/** Must match FILE_VERSION in jobs/collect_forecast.py. */
export const FILE_VERSION = 1

/** A copy downloaded less than this long ago is used without asking again. The job publishes at
 *  most hourly, so asking more often only finds the same file. */
export const CACHE_TTL_MS = 15 * 60 * 1000
/** Small localStorage key with the last download time (index.html reads it without parsing the forecast). */
export const FETCHED_AT_KEY = 'surf:forecast-fetched-at'
/** The forecast itself (when the job asked Open-Meteo) is called old after this: the job runs
 *  at least every 3 h (migration 22), so 4 h means a run was missed. */
export const OLD_AFTER_MS = 4 * 3600 * 1000
