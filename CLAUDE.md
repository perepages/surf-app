# Surf App: a self-learning surf forecast

## Problem
Surf forecasts often say "good" when it's bad, and the other way round. People who live far
from the beach can't go and check in person.

## Idea
One app that is useful from day one and improves itself. It shows the forecast, surfers rate
how it really was, and every night a model retrains on those ratings plus buoy, tide and cam
data to correct the forecast for each spot.

## Spots
Spots are **config-driven**, so more can be added later without code changes.

| Name | Lat | Lon |
|------|-----|-----|
| Vilanova i la Geltrú (Platja de Vilanova) | 41.2097 | 1.7128 |
| Sitges | 41.2332 | 1.8125 |
| Castelldefels | 41.2625 | 1.9855 |
| Barceloneta (Barcelona) | 41.3782 | 2.1944 |
| Bogatell (Barcelona) | 41.3935 | 2.2091 |

Zones for future spots: zone 1 Garraf coast (El Prat later: no cam showing water;
Garraf not recommended: no cam, no coastal wind station), zone 2 Barcelona.

## The loop
1. The app shows the forecast: a simple 1-5 score from Open-Meteo until a trained model exists.
2. Users rate real conditions; each rating is stored with the **exact forecast they saw**.
3. An **hourly job** collects forecast, tide, buoy, cam snapshot + crowd count.
4. A **nightly job** retrains the model per spot.
5. A new model is used **only if it beats the current one** on recent data.
6. The app shows the AI-corrected forecast **with reasons**; it falls back to the simple score.

## Stack
- `web/`: React + Vite + TypeScript + Tailwind + Framer Motion + Recharts, mobile-first PWA,
  hosted on Vercel or Netlify.
- **Supabase**: Postgres database, storage for snapshots, row-level security.
- `jobs/`: Python 3.11+, run by GitHub Actions (hourly collect, nightly train).
- **Models**: scikit-learn / XGBoost. **Crowd counting**: ultralytics YOLO on CPU.

## Data sources (all free)
- **Open-Meteo Marine + Forecast APIs**
  - No API key needed. Non-commercial use only.
  - The UI must show: "Weather data by Open-Meteo.com".
- **Puertos del Estado PORTUS buoys**
  - Training only. Never show the raw data publicly (not via an API, not in the UI).
- **Windy Webcams API v3**
  - Key: `WINDY_API_KEY`.
  - Image URLs expire after 10 minutes, so **download the image immediately**.
    Never store the URL to fetch it later.
- **Community ratings + my own ratings** = ground truth.

## Rules
- Secrets only in `.env` locally and GitHub/Vercel secrets online. **Never commit keys.**
- All times are stored in **UTC**.
- Work **one step at a time**.
- **Ask before** adding libraries or features that aren't listed here.
- After each task, tell me exactly how to run and test it.
- **Keep my laptop light**: nothing scheduled or left running locally (GitHub Actions does the
  hourly/nightly work). Heavy libraries (ultralytics/YOLO, torch, anything big) go in a separate
  requirements file installed **only inside GitHub Actions**, never in `jobs/requirements.txt`
  and never installed locally. `clean.ps1` frees rebuildable space (asks first).
- Keep the **Status** section below up to date with what's done.

## Status
- [x] Project context written (this file, new plan: Supabase + GitHub Actions + PWA).
- [x] Step 1 (2026-11-20): monorepo skeleton. `web/` (Vite React-TS, Tailwind v4 via
  `@tailwindcss/vite`, Framer Motion, placeholder page with Open-Meteo credit, reads `.env`
  from repo root), `jobs/` (placeholder `collect.py` / `train.py`, `requirements.txt`),
  `.github/workflows/collect.yml` + `train.yml` (manual run only, cron commented out),
  `.env.example`, `.gitignore`, README. On GitHub `perepages/surf-app`, branch `main`.
- [x] Step 2 (2026-11-20): Supabase schema in `supabase/migrations/` (apply in order in the SQL
  editor): `...0001_initial_schema` (spots, forecasts, observations, snapshots, ratings, models,
  predictions; RLS; private `snapshots` bucket), `...0002_seed_vilanova` (orientation 165° to
  verify, buoys 1731 + 2720), `...0003_grants` (new Supabase projects don't auto-grant
  `public` tables), `...0004_harden_grants_ratings` (default grants for future tables, public
  can't set `ratings.created_at`, 16 KB cap on `forecast_shown`, community ratings must include
  it). Supabase project exists; migrations 1-3 and 5 applied 2026-11-20 (checked), **migration 4
  not yet**. After applying 4, re-run 5 (its REVOKE drops the `app_version` insert grant).
- [x] Step 3 (2026-11-20): `jobs/check_connections.py` (stdlib only; never prints keys; checks
  Open-Meteo, public key RLS, service key + `snapshots` bucket, Windy key, no secret in a
  `VITE_*` var; `--require-jobs` makes missing jobs vars FAIL) + manual workflow `check.yml`.
  Passes 9/9 locally. Keys: `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` in `.env` +
  Vercel/Netlify; `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`WINDY_API_KEY` in `.env` +
  GitHub Actions secrets.
- [x] Review of steps 1-3 (2026-11-20): check script no longer crashes on network errors or a
  URL without `https://`; workflows use `checkout@v7`/`setup-python@v7` (Node 24), read-only
  `permissions`, `concurrency` (no overlapping runs), off-the-hour cron (`17 * * * *`,
  `23 3 * * *`); no keys in any commit.
- [x] Step 4 (2026-11-20): spot screen for Vilanova in `web/` (asked for as "Step 2" in the
  prompt). Open-Meteo fetched from the browser (`src/lib/openMeteo.ts`, 30-min localStorage
  cache, GFS-wave fallback for null waves, stale copy if the API fails), spot read from
  Supabase `spots` with a built-in fallback (`src/lib/spot.ts`), AI scores from `predictions`
  via plain REST, no new npm packages (`src/lib/predictions.ts`). Score: `src/scoring/simpleScore.ts`
  (simple rules), `resolveScore.ts` swaps in the AI score + "AI-corrected" badge. UI: big
  GO/MAYBE/SKIP for the current hour, 4 day tabs, tide curve, hourly rows (waves, swell
  period/dir, wind + offshore/cross/onshore from `beach_orientation`, tide in cm). Fonts from
  Google Fonts (Big Shoulders Display + Familjen Grotesk). `.claude/launch.json` runs the dev server.
  Not yet: no PWA manifest/offline, AI path untested (no AI rows exist), tide values look
  large (e.g. -62 cm; `sea_level_height_msl` includes surge), score rules uncalibrated.
- [x] Step 4b (2026-11-20): animations (Framer Motion + SVG, no new packages). Selected-hour
  panel `ConditionsPanel.tsx`: `WaveScene.tsx` (crest height = wave height, one crest every
  swell-period seconds; per-frame work is only a transform per layer, paused off screen),
  `WindDial.tsx` (rotates the short way, green offshore / red onshore, sea arc from
  `beach_orientation`), `HourStrip.tsx` (all 96 hours, native swipe + scroll-snap, colour by
  score, sliding selection ring, arrow keys). `TideCurve.tsx` has a pulsing "now" dot and a
  selected-hour line. Day tabs follow the selected hour. `MotionConfig reducedMotion="user"`
  plus manual checks stop the wave loop, springs and pulse under reduced motion. Measured
  60 fps in the desktop browser at phone size; not yet checked on a real phone or with
  reduced motion switched on.
- [x] Step 5 (2026-11-20): "I surfed — rate it" button + bottom sheet (`RateSheet.tsx`,
  `src/lib/ratings.ts`). When = today/yesterday x morning (09h) / midday (12h) / afternoon (16h)
  / evening (19h) local, preselected to the latest slot that has started; overall 1-5; optional
  wave size, surface (glassy / a bit choppy / blown out stored as `glassy`/`choppy`/`messy`),
  crowd, comment (280 chars). Fastest path: open, 1-5, send = 3 taps. Inserts into `ratings`
  with `return=minimal`, `source='community'`, random `device_id` in localStorage, and
  `forecast_shown` = the conditions + score (simple or AI) the app had for that hour, its
  `fetched_at`, and `past_at_fetch` (true for hours already over when fetched, e.g. yesterday:
  those are Open-Meteo's latest numbers, not a forecast seen in advance). Open-Meteo is now
  fetched with `past_days=1` (cache v2); the UI still starts at today. App version from
  `web/package.json` (now 0.1.0) via Vite `define`. **Needs migration 5**
  (`...0005_ratings_app_version`, adds `ratings.app_version`); without it the insert fails
  with "Could not find the 'app_version' column". Thank-you screen tested with a stubbed
  save; no real row written yet.
- [x] Step 6 (2026-11-21): rating protection. Migration `...0006_protect_ratings` (applied and
  tested 2026-11-21 against the live database; test rows deleted): `spots.timezone` (default Europe/Madrid); public gets insert-only on the
  rating columns (REVOKE ALL first, so no update/delete/select); insert policy now needs a
  16-64 char `device_id` and `surfed_at` from yesterday 00:00 spot time to now + 1 h;
  `ratings_flat_not_good` check (wave_size flat with overall >= 3, all sources);
  `ratings_rate_limit` BEFORE INSERT trigger (security definer, advisory lock) = max 3
  community ratings per device in a rolling 24 h. App: same checks before sending
  (`contradiction()`, local send log in `surf:rating-log`), friendly errors, optional
  on-device location check (`src/lib/nearBeach.ts`: within 3 km and accuracy <= 1 km ->
  `near_beach = true`, otherwise left null; coordinates never leave the function), privacy
  page at `#privacy` (`PrivacyPage.tsx`, `CONTACT` constant empty = no removal contact shown).
  Tested in the browser with faked location/saves. Limits: device ids can be rotated (clearing
  site data gives a new id), so the 3/day limit stops casual spam, not a determined attacker.
- [x] Step 7 (2026-11-21): surfer reports + chart. Migration `...0007_public_report_summaries`
  (applied and tested on the live database 2026-11-21; test rows deleted): SECURITY DEFINER functions `spot_reports_today(p_spot_id)` (count,
  avg, most common wave size/crowd, last 5 comments with score + surfed_at) and
  `spot_daily_ratings(p_spot_id, p_days<=60)`; sources 'community' + 'me'; never return
  device ids, forecast copies or row ids; raw ratings stay private. App: `TodayReports.tsx`
  under the rate button (hidden while the functions are missing), refreshed after a send;
  `ForecastVsSurfers.tsx` (Recharts 3, lazy-loaded chunk ~117 KB gz) for the last 14 days:
  simple score = daylight-hour mean recomputed from Open-Meteo `past_days=14` (forecast cache
  v3), AI = predictions daylight mean when present, surfers = daily average; headline
  "off by X on average"; legend, dash/dot styles, tooltip, table view. Series colours
  #4a8fe0 / #b88310 / #1ca88a pass the dataviz validator on #031b26. Comments are now public:
  privacy page + rating form say so. Tested with faked report data in the browser.
  Note: anonymous public comments have no moderation yet (hide/delete needs the SQL editor).
- [x] Step 8 (2026-11-21): PWA + performance, no new npm packages. `public/manifest.webmanifest`
  (standalone, icons 192/512 + maskable, from `public/icons/icon.svg`), iPhone tags +
  `apple-touch-icon.png`, safe-area padding. Service worker hand-made: `web/sw/sw.template.js`
  -> `dist/sw.js` by a plugin in `vite.config.ts` (precaches every built file, cache-first
  shell, keeps the previous version's cache; data APIs not touched). Offline data: last good
  forecast/spot/AI/reports in localStorage (`lastGood.ts`), read in the first render; offline
  notice. Speed: fonts self-hosted (`public/fonts`, Google Fonts no longer contacted), CSS
  inlined into index.html at build, instant boot text, Open-Meteo prefetched from index.html
  (`forecastRequest.ts` builds the URLs for app + build), spot/forecast/AI/reports load in
  parallel, below-the-fold sections + chart + rating form + privacy page load when needed,
  Framer Motion via `LazyMotion` (`motionFeatures.ts`), memoised sections, verdict word no
  longer slides in. Lighthouse mobile (simulated slow 4G): Perf 44 -> ~59, A11y 97 -> 100,
  SEO 90 -> 100, CLS 0.097 -> 0, TBT 1.8 s -> ~0.8 s; reports in `lighthouse-reports/`
  (gitignored). Local Lighthouse reports files at uncompressed size although the server sends
  brotli, so its simulation is pessimistic. Real throttling (`npm run measure`, 4x CPU):
  repeat visit forecast in ~1.0-1.3 s on slow 4G and 4G, offline start works, Chrome says
  installable; first visit on 4G ~2.5-5 s (noisy), slow 4G ~5-7 s: the 2 s goal is met for
  repeat visits only. `npm run serve:dist` = compressed local server. Not tested on a real
  iPhone/Android yet. Hosting must serve `sw.js` and `index.html` with `Cache-Control: no-cache`.
- [x] Review of steps 4-8 (2026-11-21): no keys in code, git or `dist/` (only `VITE_SUPABASE_URL`
  + publishable key reach the browser). Fixed:
  - **Service worker served the previous version's page forever** (`caches.match` searches the
    oldest cache first). Now this version's cache first (`fromCache` in `sw.template.js`);
    precache uses `cache: 'no-cache'`. Tested: a new build is served on the second start.
  - **No network time limits**: a weak signal could leave "Checking the sea…" / "Sending…" up
    forever. `src/lib/http.ts` `withTimeout` (Open-Meteo 20 s, incl. the index.html prefetch;
    Supabase 15 s), then the saved copy is used; a slow rating send says it may not be saved.
  - **No error boundary**: any crash or a lazy chunk failing (offline first visit) blanked the
    page. `components/ErrorBoundary.tsx`: app-level fallback (reload + Open-Meteo credit) in
    `main.tsx`, per-section "Couldn't show … Reload" for the lazy sections, rating form and
    privacy page. Tested by deleting the chart chunk.
  - Device id used `crypto.randomUUID` only (missing on iOS < 15.4 and on plain-http LAN
    addresses): falls back to `getRandomValues`.
  - App left open never refreshed: forecast now re-checked every 5 min while visible (refetch
    after 30 min); today's reports every 15 min while visible and when back online, and a copy
    from an earlier day is dropped instead of shown as "today".
- [x] Step 9 (2026-11-21, asked for as "Step 3"): deploy `web/` to **Vercel** (Hobby, Git
  integration: push to `main` = production, any other branch = preview URL behind Vercel's
  login). `web/vercel.json`: Vite preset, `npm ci`, `npm run build`, `dist`; `Cache-Control:
  no-cache` for `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest`; `/assets/*` + `/fonts/*`
  immutable (font files aren't hashed: rename one if it ever changes). Vercel project Root
  Directory = `web`; env vars `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` for Production and
  Preview. Vercel project exists: **production is `https://isitworthsurf.vercel.app`**;
  `https://surfwithai.vercel.app` is set up in Vercel as a 307 redirect to it. Since 2026-11-22
  production runs `main` 75d523c (app 0.2.0), live ~60 s after the push: `/`, `/rate`, `/admin`,
  `og.png`, `sw.js`, manifest all 200; `no-cache` on page/sw/manifest; `X-Frame-Options: DENY`;
  `/api/admin` answers "Wrong password" (so `ADMIN_PASSWORD` is set there; a real login is
  still unconfirmed); `og:image` still points at `surfwithai` (see "Pick the main address").
- [x] Step 10 (2026-11-21): share kit. Live address `https://surfwithai.vercel.app` (one place:
  `web/src/lib/site.ts`, also the share title/description). Short link **`/rate`** opens the app
  with the rating form up (`OPENED_TO_RATE` in `App.tsx`, then the address is set back to `/`;
  `vercel.json` rewrites `/rate` to `index.html`; the service worker serves it offline too;
  `#rate` works as well). `index.html`: title, description, canonical, Open Graph + Twitter tags
  filled at build by the `shareTags` plugin in `vite.config.ts`; `og.png` is left out of the
  service-worker precache. `npm run share-kit` (`scripts/share-kit.mjs`; draws with headless
  Chrome, QR via the **`qrcode` devDependency**, approved, never shipped to phones) writes
  `public/og.png` (1200x630) and `web/share-kit/`: `poster-a5.pdf` (A5, 1 page, QR 60 mm =
  2 mm modules, version 3-M), `poster-a5.png`, `share-square.png`, `share-story.png`,
  `qr-rate.svg|png`, plus a README with a message to paste. Checked: built tags, `/rate` opens
  the form and a reload doesn't, the QR's data is the `/rate` URL (no decoder at hand: scan it
  with a phone before printing), measure script still passes (service worker, offline,
  installable). The browser pane can't register service workers (pane limit, not the app).
  `.claude/launch.json` has `web-prod-alt` (serve:dist on 4174). Not done: real link previews
  can only be checked once deployed (WhatsApp caches previews; test with a fresh link).
- [x] Step 11 (2026-11-21): cookie-free analytics + `/admin`. Migration 8
  (`...0008_admin_and_counts`, applied and tested on the live database 2026-11-21): `ratings.hidden`/`hidden_at` (public can't set
  them), the two public summary functions now skip hidden ratings, `daily_counts` (UTC day x
  kind `visit`/`visit_app`/`install`, no public access) + `count_event(p_kind)` (security
  definer, adds 1). App: `src/lib/analytics.ts` counts one visit per app start (after load,
  idle; `visit_app` when standalone) and `appinstalled`; only on the live origin (`SITE_URL`),
  never localhost/previews; no cookie, id or local storage. Reload = another visit (opens,
  not people); iPhone never reports installs; anyone with the public key can inflate counts.
  `/admin` (lazy `AdminPage.tsx`, chosen in `main.tsx`, no counting there): password form,
  7/30-day tiles, 30-day table (visits, installed app, installs, ratings, hidden), latest 50
  ratings with "Hide as spam"/"Show again". Server: Vercel function `web/api/admin.ts`
  (POST, `Authorization: Bearer <ADMIN_PASSWORD>`, constant-time compare, 1 s delay on a wrong
  password, refuses to run if the password is < 16 chars; uses `SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY` server-side; device ids cut to 6 chars). In `npm run dev` the
  same handler runs via the `devApi` plugin (reads root `.env`; a generated `ADMIN_PASSWORD` is
  in the local `.env`). `vercel.json`: `/admin` rewrite + `noindex`; service worker skips
  `/api/`. Privacy page mentions the counters and the admin. Tested locally: wrong/missing
  password 401, GET 405, bad input 400, right password reaches Supabase (fails until
  migration 8: friendly "Database not ready" message); UI tested with stubbed data (login
  error, tiles, table, hide/show, phone width); no count sent from localhost.
  Live test (2026-11-21, test rows/counts removed afterwards): admin summary, public
  `count_event` (+1 seen by admin; unknown kind ignored), public can't read/insert
  `daily_counts` or set `hidden`, hide removes a rating from `spot_reports_today` and
  `spot_daily_ratings` and the admin table shows it hidden, show again restores it, unknown id
  404. On the Vercel preview the function runs (answers "Wrong password"); a successful login
  there is **not confirmed yet** (see the review below). Train job must skip
  `hidden = true`. Supabase returns max 1000 rows per request: the 30-day ratings count caps
  there.
- [x] Review of steps 9-11 (2026-11-22): no keys, passwords or `.env` in any commit on any
  branch (checked by value); `dist/` ignored. Fixed:
  - **Visit counter would never have counted**: it only ran on the `SITE_URL` origin
    (`surfwithai`), but production is served from `isitworthsurf` (redirect). Now it's on when
    Vercel builds for production (`__COUNT_VISITS__` = `VERCEL_ENV === 'production'` in
    `vite.config.ts`, declared in `src/globals.d.ts`), on any address; preview and local builds
    compile it to `false` (checked in the built JS). Needs Vercel's "Automatically expose
    System Environment Variables" (on by default), else counting is silently off.
  - **Admin password moved from the `Authorization` header to the JSON body** (`password`):
    Vercel's preview protection may handle `Authorization` itself (likely cause of "Wrong
    password" on the preview), and headers can't carry ñ/é. Both ends trim spaces; `Bearer`
    still accepted for scripts; non-object bodies -> 400. Tested locally (body, wrong, ñ,
    header fallback) and in the browser (no Authorization header sent).
  - Admin shows a warning when the 30-day ratings query hits Supabase's 1000-row limit
    (`ratingsCapped`) instead of a silently low number.
  - `vercel.json`: `trailingSlash: false` (`/admin/`, `/rate/` redirect to the plain path) and
    `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy` on every path.
  Not fixed (listed below in open items).
- [x] Step 12 (2026-11-22): `jobs/collect_forecast.py` (stdlib only, Python 3.10+; `jobs/collect.py`
  now runs it, so the `collect.yml` workflow does too). For every `spots` row with `active = true`:
  Open-Meteo Marine (wave height/period/direction, swell height/period/direction, wind wave
  height, `sea_level_height_msl` -> `sea_level_height`) + Forecast (wind speed/direction/gusts
  10 m, km/h). `fetched_at` = the UTC hour of the run (minutes cut), so `lead_hours` is a whole
  number; rows for lead 0..96 h (`forecast_days=5`, so 96 h is reached at any hour). Upsert on
  `(spot_id, fetched_at, valid_at)` = a rerun in the same hour overwrites, never duplicates
  (checked live: two runs -> 97 rows; leads 1/3/24/72 present). Hours where `best_match` has a
  null wave value take the whole wave set from `ncep_gfswave025` if that has fewer nulls
  (`marine_model` says which; sea level is never replaced). If the API rejects sea level, waves
  are still stored. Retries 3x on network/429/5xx; one failing spot doesn't stop the others
  (exit 1). `--dry-run`, `--show N`. Fallback tested with faked nulls (GFS wave gives swell 0.0,
  not null). Rows from the live test (fetched_at 2026-11-22 12:00 UTC) were kept. Hourly cron (`17 * * * *` UTC)
  enabled in `collect.yml`, but GitHub runs schedules only from `main` and needs the 3 secrets. Not done: ~850k rows/year/spot (see `forecasts` growth item); no buoy/cam yet.
- [x] Step 13 (2026-11-22): `jobs/collect_buoy.py` (stdlib only; `jobs/collect.py` runs it after
  the forecast step; each step runs even if the other fails). Buoys from `spots.buoy_ids` of
  active spots; chosen for Vilanova: **1731** Barcelona II (coastal, waves only, 42.5 km ENE) +
  **2720** Tarragona (deep water, waves + wind, 61.3 km SSW). Also considered: 1712 Tarragona
  coastal (46.5 km WSW, 15 m deep, waves only); nearest wind otherwise = Barcelona port met
  stations (~40 km, sheltered). Uses the PORTUS map's unofficial JSON API (`lastData` +
  `RTData`, POST, no key, ~48 hourly readings, times UTC). Columns: `wave_height` = Hm0,
  `wave_period` = Tp, `wave_direction` = MeanDirPeak else MeanDir, `wind_speed` = WindSpeed
  m/s x 3.6 = km/h, `wind_direction` = WindDir; faulty/empty = null. Upsert on
  `(spot_id, buoy_id, observed_at)`: whole 48 h each run fills gaps, no duplicates (checked
  live: two runs -> 47 + 48 rows, kept). Public key can't read `observations` (checked, 401).
  Warns when a buoy's newest reading is > 6 h old. If PORTUS changes its API, only this file
  breaks. Old SQLite `collector/buoy.py` left as is.
- [x] Step 14 (2026-11-22): `jobs/collect_cam.py` (stdlib only; third step of `jobs/collect.py`).
  Windy cams within 5 km of Vilanova: **1793884698** "Vilanova i la Geltru - North-west" (3Cat,
  1.3 km, looks along the beach at the breakers) = **chosen**, saved in `spots.windy_cam_id`
  (live, and migration `...0009_vilanova_cam` as a record); 1715343359 Avinguda de Rocacrespa
  (2.1 km, rooftops, no sea). Each run per spot with a cam: skip outside sunrise - 20 min ..
  sunset + 20 min (Open-Meteo daily sun times); Windy `webcams/{id}?include=images` -> download
  the `preview` image at once (URL never stored); `taken_at` = Windy `lastUpdatedOn`, so an
  un-updated cam isn't stored twice and an image > 2 h old is skipped; upload to the private
  `snapshots` bucket as `<spot>/<YYYY-MM-DDTHHMMSSZ>.jpg` + `snapshots` row (crowd counts
  empty, quality 'ok'). Cleanup: snapshots > 60 days old are deleted (file, then row), except
  the single one nearest to each non-hidden rating of that spot within 2 h of `surfed_at`;
  200 per spot per run. `--dry-run`, `--any-time`. Tested live: snapshot stored and downloaded
  back, second run skipped (same image), public key refused on file and table; cleanup with
  fake 70-day-old snapshots + a test rating + a hidden one kept only the right one (test data
  deleted; the real first snapshot was kept). **Free Windy plan = 400x224 preview only**: too
  small for YOLO to count surfers in the water (a few pixels each) at Vilanova.
  ~12 KB/image x ~11 a day = ~8 MB per 60 days.
  **Crowd counting stays in the plan** (decided 2026-11-22): build it as its own step anyway,
  so it works for future spots whose cams show people clearly (or for Vilanova if a larger
  image becomes available). It should decide per snapshot whether the image is usable for
  counting (e.g. too small/dark -> leave `crowd_water`/`crowd_beach` empty and set `quality`),
  not be hard-wired off or on per spot.
- [x] Step 15 (2026-11-22): `.github/workflows/collect.yml` runs every collector hourly (cron
  `17 * * * *` UTC, only from `main`) + "Run workflow" button with two options (dry run, cam at
  night). Steps: "Check secrets are set" (names missing ones, never values), then "Forecast +
  tide", "Buoys", "Cam snapshot + cleanup", each `python -m jobs.collect --only <step>` with
  `if: !cancelled()`, so one failing collector turns only its step red, the rest still run,
  and the run ends failed (GitHub emails the repo owner). Secrets `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `WINDY_API_KEY` from repository secrets; inputs reach the shell
  via env only. Logging: `jobs/log.py` (OK/WARN/FAIL lines; in Actions also `::warning`/`::error`
  annotations and a per-step table on the run's Summary page). Fixed a bug found while testing:
  `collect_forecast.http` shadowed the `http.client` module, so any network error crashed
  instead of retrying (affected all three collectors). Tested locally with `GITHUB_ACTIONS=true`
  (dry runs, a missing key, an unreachable Supabase); **not yet run on GitHub** (needs the
  secrets and a push).
- [x] Step 16 (2026-11-22): past sessions -> Supabase with `jobs/import_past.py` (one-off, stdlib,
  idempotent; `--dry-run`). `my_old_data/` holds: 2 GFS27 surf-app screenshots of Vilanova
  (2022-02-26, 2022-04-14), 2 WhatsApp photos (2023-11-12, no location/time in the files),
  a Morocco (Tamraght) forecast 2023-12-28, and Bogatell surf-forecast.com/Surfline screenshots
  + a 13 s video (2026-11-05). Imported only the 3 Vilanova sessions (Morocco + Bogatell
  skipped, my choice): `ratings` rows 32-34, `source='past_session'`, overall 3 ("2.5 or 3"),
  surfed_at 14:00 local (time unknown), no wave size noted; the screenshot numbers (wind
  m/s -> km/h) are in `forecast_shown` (`kind: past_session_screenshot`, `seen_at` null),
  2023-11-12 has `kind: past_session_no_forecast`. Open-Meteo for each local day: 72 rows in
  `forecasts` with `marine_model = 'historical:best_match'` and `fetched_at = valid_at` (lead
  0; the historical API stitches the first hours of each model run) -> **training must keep
  these apart from live rows**. Sea level is null for the 2022 days. No buoy data for these
  dates (PORTUS: manual request only). The old SQLite `collector/import_past.py` is superseded.
- [x] Review of steps 12-16 (2026-11-22): no keys in any file or in git history on any branch
  (checked by value: service key, Windy key, admin password); `.env`, `my_old_data/`,
  `__pycache__` ignored. Fixed:
  - **`import_past.py` could overwrite live forecasts**: its historical rows (fetched_at =
    valid_at) share the key of the hourly job's lead-0 rows, and it upserted with merge. Now
    `ignore-duplicates` (existing rows are never replaced). Re-run checked: still 72 rows.
  - Forecast: a failed **wind** request lost the whole hour; now waves are stored with empty
    wind + a warning.
  - Buoys: one **malformed PORTUS reading** made the whole buoy fail; now it's skipped and
    counted in a warning.
  - Cam: if the **sun-times** request failed, no snapshot was taken; now it takes one anyway
    with a warning (a dark image is cheap and pruned after 60 days).
  - (Found while building step 15: `http` hid the `http.client` module, so network errors
    crashed instead of retrying.)
  Tested by forcing each failure. Not fixed: see open items (forecasts growth, hourly
  failure emails, PORTUS from GitHub's servers untested, no automated tests for `jobs/`).
- [x] Step 17 (2026-11-22): `jobs/explore.py` (stdlib only, nothing trained or written to
  Supabase). Per spot: joins `forecasts` (shortest-lead live row, else historical, else
  `--past-days N` (default 3) of Open-Meteo recent past fetched on the fly, not stored),
  `observations` per buoy at the same hour, nearest `snapshots` crowd count (60 min), non-hidden
  `ratings` (de-duplicated on device + surfed_at). Python copy of `simpleScore.ts` (keep in
  sync). Writes `explore_out/<spot>/` (gitignored, has raw buoy data: never publish):
  `report.html` + 4 hand-made SVGs (forecast vs buoy over time + scatter, simple score vs
  rating, error by wind sector (calm < 10 km/h apart), error by sea-level thirds) + `hours.csv`,
  `ratings.csv`; prints a plain-words summary. First run (2 days of buoys, 3 ratings): spot
  forecast 0.08 m under buoy 1731 and 0.32 m under 2720; the big miss was the westerly wind
  event on 22 Nov morning (2720 2.2 m vs 1.0 m forecast, its wind 41-52 km/h vs 28 forecast).
  Open-Meteo `sea_level_height` sits at about -0.45..-0.62 m, so the "tide" groups only split a
  ~15 cm range. Rating data far too thin to say anything about the score.
- [x] Step 18 (2026-11-22): `jobs/train.py` (scikit-learn `HistGradientBoostingRegressor`, missing
  values handled natively; no XGBoost). Per active spot: non-hidden ratings ("flagged" = hidden in
  /admin), de-duplicated on device + surfed_at, weights me/past_session 1.0, community
  near_beach 0.8, other community 0.5. Features from `forecast_shown` (app `conditions`, or the
  screenshot hour nearest surfed_at), gaps filled from `forecasts`: swell height/period/direction
  relative to the beach, wave height + simple score (added, not in the brief), wind speed +
  onshore/cross components, tide, solar hour (UTC + lon/15, no time zones), month, lead hours.
  Two models, each learning a **correction** to a baseline (so little data = stays near the
  baseline): overall 1-5 (baseline simple score) and real wave height (rated size in metres,
  e.g. waist 0.7 / head 1.6, else first buoy's Hm0; baseline forecast height). Test = most recent
  20% of rated days (at least `--min-test`); needs 30 train / 10 test ratings, else the spot is
  skipped (exit 0, the normal state now: 3 ratings). Saved model is refit on all rows, uploaded
  to new private bucket **`models`** (migration `...0010_models_bucket`; bucket created live via
  the Storage API 2026-11-22) as `<spot>/<version>.joblib` + `.json` metrics, plus a `models` row
  (`accuracy` = 1 - test MAE/4, `is_active = false`). Tested: synthetic data (model MAE 0.51 vs
  simple 0.68), live save + download + public key refused, test row/files deleted.
  `jobs/requirements.txt` now pinned (scikit-learn 1.4.2, numpy 1.23.5, scipy 1.13.0, joblib
  1.4.0); `train.yml` installs it.
- [x] Migration 10 checked live (2026-11-22): `models` bucket private; with the public key a probe
  file is invisible in listings, unreadable (3 URL forms) and can't be deleted; probe removed.
- [x] Step 19 (2026-11-22): model activation + predictions + schedules.
  - `train.py` now compares the new model with the **current active model on the same test days**
    and activates it (migration `...0011_activate_model`: `activate_model(p_model_id)`, one
    transaction, service key only) only if its error is lower than both the simple score's and
    the current model's (the current one may have seen those days: errs toward keeping it; if it
    can't be loaded, only the simple score must be beaten). Comparison saved in the `.json`
    (`vs_current`). `--no-activate`. Bundle now has `reference` (feature medians) and each model
    remembers its feature list (`features_`), so a model with other features still loads.
  - `jobs/predict.py`: for the newest live forecast run (lead 0-96 h) upserts `predictions`
    (`simple_score` always; `ai_score`, `ai_wave_height`, `confidence` = model accuracy,
    `reason`, `model_version` from the active model, else null so a deactivated model disappears
    at once). Past hours keep their last prediction (the app's 14-day chart uses them). Reason:
    replaced in Step 20 (`jobs/reasons.py`).
    `--dry-run`, `--show N`, `--model-file` (dry run only).
  - Workflows: `collect.yml` installs `jobs/requirements.txt` (pip cache) and runs
    "Predictions" after the forecast step every hour; `train.yml` cron **enabled** (`23 3 * * *`
    UTC, from `main` only) and runs predict after training.
  - Tested: synthetic model on the real forecast (reasons, wave height, confidence), live write
    of 97 simple-only rows (kept: invisible to the app, which reads only rows with `ai_score`),
    clear error while migration 11 is missing. The app's AI path itself was never run against
    real rows (deliberately: production reads `predictions`, so no fake AI scores were written).
  - Migration 11 applied and tested live (2026-11-22, test models + files deleted afterwards):
    switching A -> B leaves exactly one active, repeat is a no-op, unknown id refused (HTTP 500,
    errcode P0002; harmless, the job only activates ids it just inserted, but `http()` retries
    5xx so it takes ~6 s), public key gets 401. With an active model whose file can't be loaded:
    train says so and only has to beat the simple score; predict exits 1 (red step) and writes
    simple-only rows. With a real (synthetic) model saved via `train.save` + activated: predict
    --dry-run used it (85 of 97 hours changed, reasons + heights), train compared against it.
- [x] Step 20 (2026-11-22): reason text from the model, `jobs/reasons.py` (used by `predict.py`,
  shown in the app under the score: `Verdict.tsx` (for the current hour since the step 24 redesign).
  Exact group Shapley values (SHAP's math, no `shap` library): 6 groups (wind, swell, waves,
  tide, time of day, season; lead time and the simple score stay fixed), 2^6 = 64 model calls
  per hour with left-out groups at their training median; they add up exactly to correction(hour)
  - correction(ordinary hour). Words: "<condition range> — usually better|worse than forecast
  here", e.g. "Offshore wind under 15 km/h — …", "Long-period swell — …", "Waves 0.5–1 m",
  "Higher sea level than usual", "Early morning", "Winter days"; a second condition joins with
  "and" if it pushes at least half as hard; swell names only the parts that matter (size /
  period / direction, each tested alone); "Days like this — …" when the spot-wide difference
  outweighs any one condition or no group pushes >= 0.15 points; null when the shown 1-5 value
  doesn't change (the app keeps the simple reason). Tested: Shapley sums exact; synthetic models
  name the planted cause (light offshore wind, swell period, spot-wide +1); real forecast dry run
  ~3 s for 97 hours; longest reason 91 chars = 2 lines at phone width (checked in the dev app
  with a stubbed predictions response, nothing written to the database).
- [x] Step 21 (2026-11-22): nightly flow as asked (supersedes parts of steps 18-19).
  - `train.py`: test set = ratings of the **last 14 days** (`--test-days`, was "newest 20% of
    days"); fit on older ratings only. Activate only if the new model beats the simple score on
    those days AND the current active model on the test ratings the current model never saw
    (bundle `max_rating_id`; last night's model saw ~13 of the 14 days, so comparing on all of
    them would always favour it). Fewer than `--min-test` (10) such ratings = keep the current
    model; equal error = keep. Unloadable current model = only the simple score must be beaten.
  - **General model**: spots without `--min-train` (30) older + `--min-test` (10) recent ratings
    get one model trained on the ratings of ALL spots (inactive spots too; features are relative
    to each beach). Same evaluation (all spots' last 14 days), saved once as
    `models/general/general-<ts>.joblib` + `.json`, one `models` row per spot using it, activated
    per spot by the same rule; it never replaces a spot's own model (bundle `scope`
    'spot'/'general'). Too few ratings across all spots = nothing changes.
  - `predict.py`: next **72 h** only (`--hours`, was 96 h); rows beyond the horizon are deleted
    each run, so the app's 4th day tab shows the simple score.
  - `train.yml`: nightly 03:23 UTC (from `main`): secrets check, `train --test-days 14`, then
    `predict --hours 72`; "Run workflow" button with dry run / no-activate options.
    `collect.yml`: predictions now run after ALL collectors (newest forecast).
  - Tested: fake 3-spot data with mocked database calls: 8 activation scenarios (none, saw-all,
    older worse/equal, unloadable, general vs own, general vs general, no win vs simple) and the
    whole nightly flow (busy spot own model; 25-rating and 0-rating spots get the general one).
    Live: train dry run (Vilanova -> general -> too few ratings, unchanged), predict wrote 74 h
    and removed the 72-96 h rows (simple-only, nothing user-visible).
- [x] Step 22 (2026-11-22): the app shows the AI model to users.
  - Migration `...0012_model_info` (applied + tested live 2026-11-22): `models.n_ratings`, `n_spots`, `scope`
    (written by `train.py`; if the columns are missing it saves without them + a warning) and
    public `spot_model_info(p_spot_id, p_days<=60, default 14)` (security definer, counts only):
    active model version/scope/n_ratings/n_spots, and over the last 14 days each non-hidden
    community/'me' rating (de-duplicated) matched with that hour's prediction that had an AI
    score: `compared`, `ai_closer`, `simple_closer` (AI rounded as shown; ties in neither).
  - App: `lib/modelInfo.ts` (`useModelInfo`, saved copy `surf:last:model:<spot>`, refresh on
    online + every 15 min; null if the function is missing = nothing new shown). `Score.simple`
    (set by `resolveScore` for AI scores). `Verdict`: "4/5 Good" + AI-corrected badge +
    "Forecast alone 1/5 Flat" (small) + reason + "Learned from 212 surfer reports" (" across N
    spots" for a general model). `ConditionsPanel`: "AI-corrected · forecast alone 1" for other
    hours. Chart section: "On 25 rated hours in the last 14 days, the AI was closer to what
    surfers said 18 times, the raw forecast 4 times (equally close 3 times)" + a split bar
    (AI-score colour / grey / simple-score colour, text labels) + "The AI score has learned from
    212 surfer reports so far. Every rating helps it."
  - Tested in the dev app at phone size with stubbed predictions + model info (nothing written
    to the database; stub copies removed from that browser's storage): without the function the
    app is unchanged (404 handled); with it, everything above shows. `tsc` + build pass.
    Bump `web/package.json` version when releasing this.
  - Live test of `spot_model_info` (2026-11-22, throwaway spot `zz-test`, all rows deleted after):
    public key can call it, still can't read `models`/`ratings`; Vilanova = no active model.
    Planted 10 ratings: 5 compared (hidden, past_session, > 14 days, no AI score that hour and a
    same-device duplicate excluded), AI closer 3 / forecast 1 / tie 1 (4.5 counts as 5; :20/:40
    round to the nearest hour); `p_days` 999 -> 60; inactive spot -> not active;
    `train.insert_model_row` wrote n_ratings/n_spots/scope.
- [x] Step 24 (2026-11-22): app redesign built from the chosen mockup ("A final" on the design
  canvas https://claude.ai/artifact/54XbAZFVxhvnrzmuCSknWE, EPIC changed to purple).
  - Colours (`index.css`): page `sea` #0d3d4c (lighter than the old #031b26), cards `card`
    #134b5c, borders `line`, `mist` lightened to #a9c8cf (contrast on cards). Scores say what to
    do: s1 coral SKIP, s2 sand MAYBE, s3/s4 greens GO, s5 **purple #8b5cf6 EPIC** (white text +
    glow). Shared in `ScoreChip.tsx` (`SCORE_CLASS`, `SCORE_WORD`, `ScoreBadge`); rating form
    and /admin use it too. `index.html` boot colours, theme-color and manifest updated.
  - Sections: Right now (`Verdict.tsx`: big GO/MAYBE/SKIP + wave line, score, label + pill, AI
    chip + forecast alone, reason, learned-from, 2x2: waves, **wave power**, wind with
    Offshore/Cross-shore/Onshore tag, tide value + trend + **small tide curve**) → Surfers today
    (`TodayReports.tsx`, now always shown with the rate button inside) → Today
    (`DayPlan.tsx` `TodayCard`: dawn / 10h / now or 13h / 16h / last daylight hour, each with
    score, height, power bars, wind arrow + tag; "See every hour") → Next days (`NextDays`: best
    window, height, power word, wind tag, score + SKIP/MAYBE/GO/EPIC; tap opens that day) → Who
    called it (`ForecastVsSurfers.tsx` restyled; scoreboard when a model is active; chart colours
    kept, re-validated on the new card colour).
  - Hour by hour: `HourSheet.tsx` (lazy, bottom sheet like the rating form): day tabs, a table
    row per daylight hour + one after sunset (dimmed): score, waves + period, power (brighter =
    stronger), wind arrow + speed + off/cross/on. Escape / Done close it; focus returns.
  - `lib/conditions.ts`: `wavePower` = 0.49 × H² × T kW/m (weak < 2, medium 2-5, strong 5-10,
    heavy 10+; deep-water estimate, real nearshore power is lower) and `windInfo` (relation,
    labels, colours, arrow rotation). `Glyphs.tsx`: `WindArrow`, `PowerMeter`, `TideMini`.
  - Removed (replaced): `ConditionsPanel`, `WaveScene`, `WindDial`, `HourStrip`, `HourList`,
    `TideCurve`, `DirectionArrow`, App's `DayTabs`. Main JS 361 → 296 KB.
  - **Not built: the live cam tile** (Windy terms for public display + our snapshots are in a
    private bucket; needs a decision).
  - Checked in the dev app at phone size: real forecast (SKIP coral, MAYBE sand), hour sheet
    (tabs, Escape, Done, focus back, day rows open their day), rating form colours; AI state
    with stubbed predictions + model info (EPIC purple, Who called it scoreboard; stubs removed
    from that browser). `tsc` + build pass. **Released 2026-11-22** as app 0.3.0 (commit 3f46cee on
    `main`, live on isitworthsurf.vercel.app ~40 s after the push; /, /rate, /admin answer 200).
- [x] Released 2026-11-22: steps 12-22 committed on `test-preview` (5 commits, secret scan
  clean), `main` fast-forwarded to it and pushed (`main` = `test-preview` = 75d523c). Vercel
  deploys production from `main`; the hourly (:17) and nightly (03:23 UTC) schedules are now
  active on GitHub. App version 0.2.0.
- [x] Go-live setup done by hand 2026-11-22 (step by step with me):
  - Supabase secret key replaced (`jobs_nov_2026`, new-style `sb_secret_`; old key deleted) and
    Windy key replaced (`jobs_nov_2026`; old one deleted); local `.env` updated; check 9/9 OK.
  - GitHub Actions secrets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WINDY_API_KEY` added.
    "Check connections" green; "Hourly collect" dry run + real run green (forecast run 13:00 UTC,
    both buoys 13:00, cam snapshot 13:44, predictions written 13:54, all seen in the database);
    "Nightly train" dry run green. Both scheduled workflows are **enabled** and running.
  - Vercel: `SUPABASE_SERVICE_ROLE_KEY` updated (Production + Preview), `SUPABASE_URL` and
    `ADMIN_PASSWORD` present, production redeployed; **/admin login confirmed working**.
- [x] Review of steps 17-24 (2026-11-22): no keys, passwords or `.env` in any file or commit on
  any branch (checked by value for the service key, Windy key and admin password, and by
  pattern for `sb_secret_` / JWT keys). Python simple score still matches `simpleScore.ts`.
  Fixed (unattended runs):
  - **A network blip at 03:23 could replace a better model**: if downloading the current active
    model failed, `train.py` treated it as "unloadable" and activated any new model that beat the
    simple score. Model files are now downloaded with 3 tries (`download()`, network/429/5xx);
    if that still fails the current model is **kept**. Only a real failure (404 = file gone,
    can't unpickle) counts as unloadable.
  - **A model crashing on a new forecast stopped the whole predictions write** for that spot,
    leaving the previous hour's AI scores in place. `predict.py` now writes the simple-score rows
    anyway (AI columns null, step red); if only the reason text fails, the AI scores are still
    written without reasons (warning).
  - **`train.py` crashed on a rating with `forecast_shown` = null** (`.get` on None), failing the
    whole spot. Now treated as "nothing shown".
  - `predict.py` warns when the newest stored forecast run is > 3 h old (`STALE_AFTER_H`), so a
    failing or silent collector shows up in the predictions step too.
  Tested by forcing each failure (crashing model, crashing reasons, 503 x3 -> kept, 404 ->
  unloadable, null forecast_shown) and with live dry runs of train + predict; `tsc` passes.
  **Found while testing: no scheduled run has started yet.** Both workflows are enabled and the
  cron is on `main`, but at 17:20 UTC the only runs were the manual ones from 13:51-13:56; the
  newest stored forecast was from 13:00. GitHub sends no email when a run never starts.
  App (steps 22-24) reviewed: no crash paths found beyond the open items below.
- [x] Step 25 (2026-11-22, asked for as "Step 7"): `python jobs/add_spot.py` (stdlib only;
  `--dry-run` asks everything and inserts nothing; `q` stops at any question). Asks the name and
  coordinates (Google Maps "lat, lon" paste); checks the point with Open-Meteo: elevation API
  (sea = 0 m; > 5 m = "on land") and the Marine sea cell it snaps to (it always snaps to the
  nearest sea cell, so a point on land still "has waves"; > 30 km = not local), plus a time-zone
  suggestion. Id = slug from the name before "(" (checked unique, `general` reserved). Cams:
  Windy `webcams?nearby=lat,lon,10` (title, km, compass direction, image age, windy.com link;
  URLs not stored). Buoys: PORTUS `GET estaciones/rt/WAVE` (+ `/WIND` list), wave stations
  within 150 km (max 8), each checked live with `lastData` (waves / wind / newest reading age);
  suggests the nearest live buoy + the nearest live one with wind. Orientation in degrees or a
  compass point (SSE = 158). Time zone checked with `zoneinfo`. Shows the row, inserts into
  `spots` (active) after "y". Warns if an existing spot is < 1 km away. Tested: bad answers
  re-asked, inland point refused, live insert of `zz-test` (Sitges cam + 1731/2720) picked up by
  dry runs of collect_forecast, collect_buoy, collect_cam, predict and train, then deleted (no
  rows left in any table). **The web app still shows only `DEFAULT_SPOT_ID` (vilanova)**: a new
  spot is collected and trained on, but users can't see or rate it until a spot picker exists.
  Wind-only met stations (e.g. Barcelona port) aren't listed (wave buoys only).
- [x] Step 26 (2026-11-22): home screen = all spots. **New npm packages (asked for): `leaflet`
  1.9.4 + `@types/leaflet` (dev)**; no react-leaflet.
  - Routes (`lib/route.ts`, no router library): `/` = spot list, `/spot/<id>` = the old spot
    screen (back link "‹ All spots", "☆ Add to your spots"). `/rate` now goes to
    `/spot/vilanova` with the form open. `vercel.json` rewrites `/spot/:id` to `index.html`
    (no-cache); the service worker already serves the shell for any page (offline works).
  - Data (`lib/spotList.ts`): active spots from `spots` (saved copy, else built-in), ONE
    Open-Meteo marine + ONE forecast request for all spots (multi-location, past 1 h + next 4 h;
    GFS-wave fallback for null waves), AI score for the current hour from `predictions`
    (`spot_id=in.(…)`), crowd = most common crowd in today's surfer reports
    (`spot_reports_today` per spot; cams can't count people yet). Saved copy
    `surf:last:spot-list:v1`, refreshed like the spot screen (30 min / hour change / online).
  - List (`HomeScreen.tsx`): best score now first (then wave height, name); "Your spots"
    (favourites) on top, then the rest. Row: score, name + beach, GO/SKIP word, AI tag, wind tag,
    "after dark", `MiniWave.tsx` (CSS transform loop: height = wave height, speed from period,
    score colour; off under reduce motion), height + period, crowd dots + "Busy · 3 reports".
  - Favourites (`lib/favourites.ts`): `surf:favourites` in localStorage, synced across screens
    and tabs, never sent. List/Map choice remembered (`surf:home-view`).
  - Map (`SpotMap.tsx`, lazy chunk ~45 KB gz + 6 KB CSS, downloaded only when opened): OSM
    tiles `tile.openstreetmap.org` with "© OpenStreetMap contributors", score-coloured markers
    (sand ring = favourite), names always shown when ≤ 8 spots, tap/Enter opens the spot.
    Privacy page mentions OpenStreetMap + favourites. OSM's tile policy is fine for low traffic;
    a busy app should move to a tile provider with a key.
  - Forecast cache is now one copy per spot (opening another spot no longer drops the first);
    the index.html prefetch only runs on `/spot/<id>` and `/rate`, per spot
    (`surf:forecast-fetched-at:<id>`). `measure-pwa.mjs` waits for the first spot row on `/`.
  - Tested in the dev app at phone size with 4 stubbed spots (stubs in that browser only,
    nothing written to the database; removed afterwards): ranking (stubbed AI 4 first), crowd
    levels, favourites move to "Your spots" and sync with the spot page, map markers + labels +
    tap → `/spot/castelldefels`, back button, unknown spot message, `/rate`. Prod build: measure
    script = service worker, offline start, installable all OK; map CSS + tiles load. `tsc`,
    lint (warnings only), build pass. Main JS 296 → 311 KB.
  - Not done: bump `web/package.json` to 0.4.0 when releasing; with only Vilanova in `spots` the
    list has one row; share tags/poster still say "Vilanova Surf"; not checked on a real phone.
- [x] Step 27 (2026-11-22): optional surf alerts by web push. **New library (approved): `pywebpush`
  2.0.3** in `jobs/requirements-push.txt`, installed ONLY in GitHub Actions (not in
  `jobs/requirements.txt`, never locally). No new npm packages.
  - Migration `...0013_push_alerts` (applied 2026-11-22, checked live): `push_subscriptions` (endpoint, p256dh,
    auth, spot_id, min_score 2-5, last_sent_at, notified_until, failures; unique endpoint+spot; no
    public access) + public SECURITY DEFINER `push_subscribe` (only real push services: FCM,
    Mozilla, Apple, Windows; spot must be active; max 10 spots per phone; changing the score
    resets `notified_until`), `push_unsubscribe(endpoint, spot|null)`, `push_alerts(endpoint)`.
    Knowing the endpoint = owning the alert.
  - Keys: `npm --prefix web run vapid-keys` (`web/scripts/vapid-keys.mjs`, Node built-in crypto)
    wrote `VITE_VAPID_PUBLIC_KEY` (raw P-256 point), `VAPID_PRIVATE_KEY` (raw 32-byte scalar,
    never printed) and `VAPID_SUBJECT` (`https://isitworthsurf.vercel.app`) into the local `.env`
    on 2026-11-22; refuses to overwrite (new keys break every existing alert; `--force`).
  - `jobs/notify.py` (last step of `collect.yml`, hourly, only when the `VAPID_PRIVATE_KEY` secret
    is set): per alert, the spot's `predictions` for the next 24 h, AI score else simple (half-up
    rounding like the app), daylight hours only (Open-Meteo sun times, hour middle; fallback
    06-18 UTC); first run of consecutive hours >= min = the window. Skips a window already
    announced (`notified_until`) and anything within 12 h of the last alert. Title = best hour
    ("Sitges: 4/5 Good tomorrow at 11h"), body = window ("4/5 or better tomorrow 10-13h.
    AI-corrected forecast."), opens `/spot/<id>`, TTL = until the window ends. 404/410 -> row
    deleted; other errors count `failures` (10 -> deleted); 401/403 (our VAPID key wrong) never
    counts against the phone, fails the step. Endpoints are never logged (host + row id only).
    `--dry-run` (no pywebpush needed), `--test` (test push to every alert). Workflow "Run
    workflow" has a "Send a test surf alert" box. Missing table -> warning, exit 0.
  - App: "🔔 Alert me" on each spot page (favourite button now "☆ Save"); lazy `AlertSheet.tsx`
    (3+ / 4+ / only 5, turn on / change / off; explains iPhone Home Screen install, blocked
    notifications, unsupported browsers); `lib/push.ts` (permission asked straight from the tap,
    resubscribes if the key changed, local copy `surf:alerts`, synced with `push_alerts`; the
    browser subscription is dropped when the last alert is turned off). Service worker: `push`
    always shows a notification (tag per spot), `notificationclick` focuses an open window and
    navigates, else opens one. Privacy page section "Surf alerts". README has the setup steps.
  - Tested: notify logic with mocked database + sender (send + patch, already told, 12 h limit,
    410 delete, 10th failure delete, 403 not counted, half-up 3.5 -> 4, daylight filter,
    window wording across midnight); live `--dry-run` (table missing -> warning). Headless Chrome
    on the prod build: service worker ready, real subscription with our VAPID key (FCM endpoint,
    keys OK), notifications show; saving failed with 404 as expected (migration 13 missing).
    Sheet checked at phone size (blocked + picker states). `tsc`, lint, build pass.
  - Live since 0.4.0: migration 13 applied, Vercel public key in the bundle, GitHub secrets
    found (the alerts step ran in the 18:10 UTC manual run). **Still unconfirmed: a push actually
    delivered to a phone** (no alert existed at a send so far) and the tap opening the spot. Not handled: `pushsubscriptionchange` (Firefox can rotate a subscription; the
    old one gets 410 and is deleted, the user must turn the alert on again). Anyone with the
    public key could add fake subscriptions on real push hosts; they die at the first send (404).
- [x] Released 2026-11-22: steps 25-27 as app **0.4.0** (`main` fast-forwarded to `test-preview`
  and pushed; Vercel deploys production from `main`). Same day: migration 13 applied, VAPID
  secrets in GitHub and `VITE_VAPID_PUBLIC_KEY` in Vercel (all confirmed live).
- [x] Fix 2026-11-22 (after the 0.4.0 release): turning on an alert showed "Unexpected end of JSON
  input" although the alert WAS saved: `push_subscribe` returns nothing (HTTP 204, empty body)
  and `rpc()` in `lib/supabase.ts` always parsed JSON. `rpc()` now returns null for an empty
  body. Checked with headless Chrome on the prod build against the live database: on -> "Done",
  button "Alert 4+", off -> row deleted. Migration 13 and the Vercel public key confirmed live
  (bundle has the key; functions answer; fake endpoint refused; table not readable publicly).
- [x] Review of steps 25-27 (2026-11-22): no keys, passwords or `.env` in any file, in `web/dist`
  or anywhere in git history (checked by value: VAPID private key, service key, Windy key, admin
  password; and by pattern). The browser only gets `VITE_SUPABASE_URL`, the publishable key and
  the VAPID public key. pywebpush 2.0.3 / py-vapid source checked: `webpush()` arguments match
  and py-vapid reads our raw 32-byte private key. Fixed:
  - **A push-service or network outage would have deleted every alert**: `notify.py` counted any
    failed send towards the 10-failures removal. Now network errors, 429 and 5xx are retried
    next hour without counting; only the phone's own rejections (400-type, unusable keys) count;
    401/403 (our key) never count and turn the step red.
  - **One error stopped all alerts**: a network exception from pywebpush (requests), a failed
    predictions read, a bad time zone or a failed database write after a send crashed the whole
    run. Now isolated per spot and per alert (`notify_spot` / `notify_one`); `Sender.send` never
    raises. Paused spots (`active = false`) are skipped quietly instead of warning every hour.
  - **Alerts for other spots could silently disappear** on browsers that don't report the
    subscription's key (`options.applicationServerKey` null): every "Turn on" made a new push
    address and left the other spots on the old one. Now only a KNOWN different key resubscribes;
    when the push address changes, all of the phone's alerts are re-saved under the new one
    (`surf:push-endpoint` remembers the last one), and opening a spot page repairs alerts the job
    dropped after the browser renewed its address (only with permission granted).
  - `jobs/requirements-push.txt`: py-vapid, http-ece, cryptography capped below their next major
    version (an unattended run can't break on a new release); pip cache covers that file.
  - Service worker: alert URLs must be a path on this site (`//other.site` refused); tapping an
    alert opens a new window when the open one can't be navigated (not controlled by the worker).
  - Map: only click/Enter opens a spot (any key press on a focused marker did).
  - At most 6 spot forecasts saved on the phone (oldest dropped): a full localStorage would also
    stop the device id and the rating limit from saving.
  Tested: mocked notify run (sent, 410 removed, 400 x10 removed, 500 / network / 429 kept and
  retried, 403 fails without counting, paused spot, broken spot and failed write isolated) and
  the real `Sender` with a fake pywebpush (exceptions -> codes, claims not reused). Headless
  Chrome on the prod build against the live database: alert on -> "Done", simulated renewed push
  address -> alert re-saved on reopen, off -> row and endpoint key removed (no test rows left);
  cache cap kept the 6 newest. Live `notify --dry-run` OK. `tsc`, lint, build pass.
  **Not deployed yet** (on `test-preview`, not `main`).
- [x] Step 28 (2026-11-22): 12-month backtest without surfers, `python -m jobs.backtest` (nothing
  written to Supabase, live app untouched; `--offline` reuses the cache). Downloads 22 Nov 2025 -
  21 Nov 2026 into `explore_out/backtest/raw/` (gitignored; has PORTUS data, never publish):
  Open-Meteo archived Marine (+ GFS-wave fill) and Historical Forecast wind at the spot, Marine at
  the buoy position as a control, **PORTUS buoy 1731 hourly history** (unofficial
  `historicosSerialTime/estacion/WAVE/{id}` endpoint behind portus.puertos.es's time-series
  charts; POST, one parameter per request, times UTC, checked against stored observations),
  **Meteocat XEMA station YR Vilanova** (3.3 km, 10 m wind every 30 min, open-data dataset
  `nzvn-apee`, no key). Observed score = same rules on buoy Hm0/Tp/dir + station wind. Model =
  `train.fit`/`predict` with the observed score as the target, first 9 months train / last 3 test.
  Results (4,375 daylight hours): same score 49%, within 1 point 82%, GO/not GO right 77%; said GO
  but it wasn't 1% of hours, missed GO 22% (55% of GO hours); forecast 0.59 points low on average.
  Beach forecast waves 0.20 m below the buoy, Open-Meteo at the buoy only 0.10 m low: half is
  model error, half the beach being more sheltered (so the real missed-GO rate is lower). Wind
  within 0.1 km/h on average. AI on the last 3 months: same score 46% -> 51%, miss 0.75 -> 0.60,
  missed GO 23% -> 12%, but false GO 2% -> 6%. This model must not go live (it partly learned
  "beach = buoy"). crowd_water: 2 snapshots, 0 counted, so that check isn't possible yet.
- [x] Step 29 (2026-11-22): zone 1 + 2 spots. Scouted Garraf, Sitges, Castelldefels, El Prat,
  Barceloneta, Bogatell (Windy cams checked by their daylight image, PORTUS buoys, Meteocat
  stations with 10 m wind, orientation from the OSM coastline; Vilanova checks out at 162-166°).
  Added live with `add_spot.py` (active): **sitges** (165°, cam 1701435626 = the beach up close),
  **barceloneta** (130°, cam 1450823411 = wide view from a tower, beach water only 3% of the image),
  **bogatell** (130°, no cam); all buoys 1731 + 2720. Points are ~150 m off the sand (on land
  add_spot refuses them). Open-Meteo's nearest sea cell is 3.3 km (Sitges), 9.7 km (Barceloneta),
  7.2 km (Bogatell) away. They show up in the app's spot list and map at once.
  - Cam water area: migration `...0014_cam_water_area` (**not applied yet**: apply in the SQL
    editor; it also stores the areas for vilanova/sitges/barceloneta; now applied): `spots.cam_water_area`
    jsonb `{cam_id, points [[x,y] 0..1], image, drawn_at}`, checked by `valid_cam_area()`
    (applied 2026-11-22 by me; checked: 3 areas stored, an invalid one refused);
    ignored when `windy_cam_id` changes. `python -m jobs.cam_area --spot ID` writes
    `explore_out/cam_areas/ID.html` (Windy daylight image + stored area in yellow; click to draw,
    copy the `--save "x,y ..."` command); `--points` previews, `--save` stores, `--all`.
    Helpers for the counting step: `area_for(spot)`, `inside(x, y, points)`, `share_of_image`.
  - Backtest now per spot: `python -m jobs.backtest [--spot ID ...] [--station CODE]`, reports in
    `explore_out/backtest/<spot>/`; station per spot in `STATIONS` (vilanova/sitges YR,
    barceloneta/bogatell Y7 Port de Barcelona - Bocana Sud; the city station X4 is a rooftop).
    Daylight hours, same score / GO right / said GO wrongly / missed GO, AI miss raw -> AI:
    vilanova 49% / 77% / 1% / 22%, 0.75 -> 0.61; sitges 49% / 77% / 2% / 21%, 0.73 -> 0.61;
    barceloneta 51% / 80% / 4% / 15%, 0.71 -> 0.57; bogatell 50% / 79% / 4% / 17%, 0.72 -> 0.58.
    Open-Meteo is 0.10 m low at the buoy itself at every spot; the forecast wind at the
    Barcelona spots is 6.6 km/h below the harbour-mouth station (exposed breakwater).
  - Dry runs: collect_forecast, collect_buoy, collect_cam, train include all 4 spots; train puts
    the 3 new ones (0 ratings) on the general model; predict waits for their first stored
    forecast (next hourly run).
  - Free limits: repo is public, so Actions minutes are unlimited (hourly run 0.7 min). Storage:
    ~10 MB per cam for 60 days of snapshots. **Database is the limit**: ~200 MB/year/spot of
    `forecasts`, 4 spots would reach 500 MB in ~7 months: fixed by step 30 (thinning).
- [x] Step 30 (2026-11-22): forecast thinning (option "thin by lead time", chosen by me).
  `collect_forecast.py`, after storing each hour: runs fetched more than `KEEP_ALL_DAYS` (14) days
  ago keep only `KEEP_LEADS` 0, 1, 2, 3, 6, 12, 24, 48, 72, 96 h, for all spots (one PostgREST
  DELETE with `count=exact`). ~97 -> 10 rows per run: ~200 -> ~20 MB/year/spot. Lead 0 stays, so
  train/explore still find the best forecast for every past hour; historical past-session rows
  (lead 0) untouched (72 still there). A thinning failure only warns (forecast already stored,
  retried next hour); `--dry-run` only counts, `--no-thin` skips. Tested live with a throwaway
  inactive spot (a 20-day-old run kept exactly the 10 leads, a 13-day-old run kept all 97; test
  rows + spot deleted) and with a forced failure (warning, exit 0). That live run also stored the
  21:00 UTC forecast for all 4 spots. **Runs on GitHub only once pushed to `main`.**
- [x] Step 31 (2026-11-22): **castelldefels** added (Escola Catalana de Surf is there): 41.2625,
  1.9855, faces 180°, **no cam** (the only one near, 1793912103, points at the sky), buoys 1731 +
  2720, Open-Meteo sea cell 6.4 km away. Backtest station XL El Prat (11.7 km, 10 m wind; YY
  Viladecans is closer but has only 2 m wind): same score 58%, GO right 81%, said GO wrongly 3%,
  missed GO 17%; AI miss 0.61 -> 0.53. Dry runs: forecast, buoys and train include it (general
  model). Committed with steps 28-31 on `test-preview` (not pushed).
- [ ] Before printing posters: pick the main address (see open items) and fill `CONTACT` in
  `PrivacyPage.tsx`.
- [x] Step 23 (2026-11-22): laptop footprint check (nothing deleted).
  - No scheduled task, Startup entry or Run key for the old `run_all.py` (it was never
    scheduled). Found 3 forgotten local dev servers (`npm --prefix web run dev`, started 21 Nov
    from earlier sessions); stopped with my OK (npm wrappers + 3 vite processes, ports
    5173-5175 free; no surf-app node/python process left).
  - Old SQLite `C:\Users\pages\surf-app-data\surf.db` (172 KB; `snapshots` folder empty,
    `logs\collector.log`) vs Supabase: the 3 Vilanova past sessions + their forecasts are in
    Supabase (ratings 32-34 + 72 historical rows). Only local: **80 buoy readings** (1731 + 2720,
    18 Nov 21:00 - 20 Nov 12:00 UTC; PORTUS can't give them again), one live forecast run
    fetched 20 Nov (151 rows), the Bogatell report (rating 4 + 56 forecast rows; skipped on
    purpose in step 16; its source files are in `my_old_data/`), the `collector_runs` log.
    Decided 2026-11-22: **not** copied to Supabase (not needed), so `surf-app-data` is safe to
    delete whenever I want (it is not deleted yet).
  - Local Python (3.10 main install): no torch, ultralytics or xgboost. scikit-learn/scipy/
    numpy/joblib (~200 MB) are there for running train/predict locally. TensorFlow (1.3 GB) and
    OpenCV (121 MB) are installed too but not used by this project.
  - Project 221 MB: `web/node_modules` 193 MB, `.venv` 18 MB (empty: only pip/setuptools, made
    20 Nov, unused), `my_old_data` 4.6 MB, `lighthouse-reports` 2.4 MB, `web/dist` 1 MB. Outside:
    pip cache 1.0 GB, npm cache 1.0 GB. The project is inside OneDrive, so `node_modules`
    (thousands of files) is also synced to the cloud.
  - `clean.ps1` (repo root): lists rebuildable folders (`web/node_modules`, `web/dist`, `.venv`,
    `__pycache__`, `.pytest_cache`, `explore_out`, `lighthouse-reports`) with sizes and asks
    y/N before deleting; `-DryRun` only lists; `-GlobalCaches` adds the pip + npm caches. Never
    touches code, `.env`, `my_old_data`, `web/share-kit`, `.git`. Tested: dry run and "n" delete
    nothing.
- [ ] Open items:
  - **Pick the main address**: `SITE_URL` (QR poster, `/rate` link, canonical, `og:url`,
    `og:image`) is `surfwithai.vercel.app`, which only 307-redirects to the production address
    `isitworthsurf.vercel.app`. Either make `surfwithai` the production domain in Vercel
    (Settings > Domains) or change `src/lib/site.ts` and re-run `npm run share-kit` before
    printing posters. Some link-preview crawlers don't follow redirects for `og:image`.
  - `/rate` opens the form only once the forecast has loaded; if Open-Meteo fails and there's no
    saved copy, the error screen shows and the form doesn't open.
  - Anyone with the public key can call `count_event` and inflate visits/installs.
  - Admin brute force: 1 s delay per wrong guess but parallel requests aren't limited; keep the
    password long and random (16+ characters enforced).
  - Fill in `CONTACT` in `PrivacyPage.tsx` before going public.
  - Comments are public with no moderation; the per-device limit is beaten by clearing site
    data (anyone with the public key can script inserts). Before launch: a way to hide comments,
    and maybe an IP-based limit (Edge Function) or a captcha if spam appears.
  - A rating send that times out may still have been saved; sending again can duplicate it
    (the 3/day limit caps this). Training should de-duplicate same device + surfed_at.
  - The location check can stay on "Checking…" if the permission prompt is ignored (the
    geolocation timeout starts after the answer).
  - "Today" for reports' saved copy uses the phone's date, not the spot's time zone (same in
    Spain; matters only for far-away users).
  - An app kept open offline for 4+ days runs out of forecast hours and shows the first one.
  - An invalid `spots.timezone` would make every rating insert fail; check new spots.
  - Bump `web/package.json` version on releases: it's the `app_version` stored with ratings
    (the service worker cache updates on its own from file hashes).
  - No automated tests and no ESLint config in `web/` (type-check only: `npx tsc -b`).
  - **First scheduled "Hourly collect" run seen 2026-11-22 20:44 UTC** (success, 0.7 min; GitHub
    starts schedules late, not at :17). Nightly not seen yet. Earlier note, kept for reference:
    scheduled runs were never seen (checked 18:19 UTC on 2026-11-22, after the 0.4.0 push
    changed `collect.yml`): only manual runs in Actions, for both workflows. Without them there
    is no hourly data, no predictions and **no surf alerts**. Next: Actions > Hourly collect >
    "..." > Disable workflow, then Enable; if still nothing, trigger `workflow_dispatch` from an
    outside scheduler (needs a GitHub token with workflow scope).
  - Surf alerts: anyone with the public key can add fake subscriptions on real push hosts. With a
    good window they die at the first send (404), but alerts that never trigger (e.g. min 5) stay
    forever. Add a total row cap or a per-hour insert limit in a migration if spam appears.
  - Surf alerts use the latest `predictions` even if the predict step has been failing (it warns
    when the forecast is > 3 h old; notify doesn't check again).
  - `check_connections.py` doesn't check that `VAPID_PRIVATE_KEY` matches `VITE_VAPID_PUBLIC_KEY`;
    a mismatch shows only as 401/403 in the alerts step.
  - A spot set to `active = false` disappears from the list, but its page (`/spot/<id>`) still
    shows the copy saved on phones that opened it before.
  - Home screen: one `spot_reports_today` call per spot per refresh, and all spots in one
    Open-Meteo URL; fine for tens of spots, revisit at ~100.
  - No way to edit or delete a spot except the Supabase table editor (`add_spot.py` only adds).
  - OpenStreetMap's public tiles are fine for low traffic; a busy app needs a tile provider.
  - **No alert when runs silently stop** (GitHub only emails failed runs). Idea: show "last
    forecast stored" in `/admin`, or a free uptime pinger on a tiny status endpoint.
  - Hourly predict (collect, :17) and the nightly one (03:23) are in different concurrency
    groups. On the rare night the 03:17 run ends after the nightly run, it writes one hour of
    predictions from the previous model (fixed by the next hourly run).
  - **`models` storage growth**: once a spot has enough ratings, every night saves a new
    `.joblib` + `.json` + `models` row, even when the model is not activated; nothing is ever
    deleted. Add pruning (e.g. inactive models > 30 days) before the 1 GB free storage matters.
  - The 4th day in Next days / Hour by hour mixes AI hours (up to 72 h ahead) with simple-score
    hours after that.
  - A broken collector fails **every hour**, and GitHub emails each failed scheduled run: fix
    or disable the workflow quickly (Actions > Hourly collect > ... > Disable workflow).
  - Supabase free projects **pause after ~7 days without activity**; the hourly job keeps it
    awake once it runs from `main`.
  - GitHub **disables scheduled workflows after 60 days without commits**; re-enable in the
    Actions tab or keep committing.
  - `forecasts` growth: thinned since step 30 (~20 MB/year/spot after 14 days + ~5 MB for the
    last 14 days of full runs per spot); 500 MB holds roughly 15-20 spots for years.
    `observations`, `predictions` and `snapshots` rows are small; recheck at ~20 spots.
  - Training notes: skip `ratings.hidden`; de-duplicate same device + surfed_at; rows with
    `marine_model = 'historical:best_match'` are lead-0 history, not live forecasts;
    `past_session` ratings keep the screenshot forecast in `forecast_shown.hours` (different
    shape from the app's); `ncep_gfswave025` rows report swell as 0.0, not null; buoy 1731
    has no wind.
  - `near_beach` and `device_id` are self-reported, so don't trust them blindly in training.
  - Crowd counting **deferred** (Vilanova's 400x224 cam images are too small). When built:
    `ultralytics` pulls a large CUDA `torch` by default; install the CPU build, from its own
    requirements file, **only in Actions** (never on my laptop).
  - The collectors use only the standard library; training needs `jobs/requirements.txt` (pinned
    scikit-learn etc.; `train.yml` installs it). Keep the pins equal wherever models are loaded.
  - No automated tests for `jobs/` (tested by hand with dry runs and forced failures).
- [ ] Not built yet: crowd counting (deferred). Hourly predict adds a scikit-learn install to
  every collect run (more Actions minutes; fine if the repo is public, watch the 2,000 min/month
  limit if private).
- Earlier local prototype (built under the previous plan; still in this folder). Its forecast,
  buoy and past-session parts are **superseded** by `jobs/collect_forecast.py`,
  `jobs/collect_buoy.py`, `jobs/import_past.py`; the SQLite data was not migrated:
  - `collector/` (Python, local SQLite in `C:\Users\pages\surf-app-data\surf.db`, paths in
    `collector/paths.py`): `forecast.py` (Open-Meteo marine + wind + tide, falls back to
    `ncep_gfswave025` when the default model returns nulls), `buoy.py` (PORTUS buoys 1731
    Barcelona II and 2720 Tarragona via the unofficial map JSON API, ~48 h history),
    `import_past.py` (my old sessions from `my_old_data/`), `run_all.py` (runs all steps,
    logs to `collector_runs`). Webcam step and hourly scheduling were never done.
  - `rate.py` (CLI for my 1-5 ratings, whole numbers only) and `status.py` (row counts).
  - Old spot coordinates were 41.21061, 1.71594; there was also a past-data-only Bogatell
    (Barcelona) spot (41.3946, 2.2077) with one reported session (2026-11-05, rating 4).
  - PORTUS buoy data for past dates needs a manual data request on portus.puertos.es.
- Note: this machine only has Python 3.10; the collectors work on 3.10 (stdlib only). Python
  3.11+ is needed locally once training libraries come in (GitHub Actions uses 3.11).
