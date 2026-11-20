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
- `web/`: React + Vite + TypeScript + Tailwind + Framer Motion, mobile-first PWA,
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
  `supabase/migrations/` (empty), `.github/workflows/collect.yml` + `train.yml` (manual run
  only, cron commented out), `.env.example`, `.gitignore`, README. Pushed to GitHub `surf-app`.
- [x] Step 2 (2026-11-20): database design approved. `supabase/migrations/`
  `20261120000001_initial_schema.sql` (spots, forecasts, observations, snapshots, ratings,
  models, predictions; RLS: public reads active spots, forecasts, predictions and inserts
  `community` ratings from the last 7 days; everything else service key only; private
  `snapshots` bucket) and `20261120000002_seed_vilanova.sql` (Vilanova, orientation 165°
  to verify, buoys 1731 + 2720), plus `20261120000003_grants.sql` (explicit table grants:
  new Supabase projects don't auto-grant `public` tables). Supabase project exists; all 3
  migrations applied 2026-11-20; `check_connections.py` passes 9/9 locally.
- [x] Step 3 (2026-11-20): `jobs/check_connections.py` (stdlib only; checks Open-Meteo, anon key
  RLS, service key + `snapshots` bucket, Windy key, and that no secret sits in a `VITE_*` var;
  skips checks whose vars are missing) + manual workflow `.github/workflows/check.yml`.
  Keys: `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` in `.env` + Vercel/Netlify;
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`WINDY_API_KEY` in `.env` + GitHub Actions secrets.
- [ ] Not built yet: Supabase project (apply migrations), real jobs, PWA setup, forecast UI.
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
