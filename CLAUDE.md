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
- [ ] Step 9 (2026-11-21, asked for as "Step 3"): deploy `web/` to **Vercel** (Hobby, Git
  integration: push to `main` = production, any other branch = preview URL).
  `web/vercel.json`: Vite preset, `npm ci`, `npm run build`, `dist`; `Cache-Control: no-cache`
  for `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest`; `/assets/*` + `/fonts/*` immutable
  (font files aren't hashed: rename one if it ever changes). Vercel project Root Directory =
  `web`; env vars `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` for Production and Preview
  (Vite reads them from the process env; `envDir: '..'` only matters locally). Checked locally:
  build with host-style env vars works and inlines them. **Not done yet**: Vercel project
  creation (needs the owner's login), live URL, header check on the live site.
- [ ] Open items (do before or while building the jobs):
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
  - **Rotate the Supabase secret key and Windy key** (pasted in chat; old ones still work).
  - Add the 3 GitHub Actions secrets, run Actions > Check connections (not done yet).
  - Supabase free projects **pause after ~7 days without activity**; only the hourly job
    keeps it awake, so schedule it soon after it works.
  - GitHub **disables scheduled workflows after 60 days without commits**; re-enable in the
    Actions tab or keep committing.
  - `forecasts` grows fast (16-day forecast x 24 h x every hour ~ 3M rows/year, beyond the
    500 MB free tier): store fewer lead hours or fetch less often, and prune old rows.
  - `near_beach` and `device_id` are self-reported, so don't trust them blindly in training.
  - `ultralytics` pulls a large CUDA `torch` by default; install the CPU build in Actions.
  - `jobs/requirements.txt` has no upper version bounds; pin once the jobs work.
  - The train job must switch `models.is_active` in one transaction (only one active per spot).
- [ ] Not built yet: real collect/train jobs.
- Earlier local prototype (built under the previous plan; still in this folder, not yet
  migrated):
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
- Note: this machine only has Python 3.10; Python 3.11+ must be installed locally (GitHub
  Actions can use 3.11+ directly).
