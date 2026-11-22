# Surf App

A self-learning surf forecast. The app shows a forecast, surfers rate how it really was,
and every night a model retrains on those ratings (plus buoy, tide and cam data) to correct
the forecast for each spot. See [CLAUDE.md](CLAUDE.md) for the full plan.

Weather data by [Open-Meteo.com](https://open-meteo.com/).

## Folder structure

```
surf-app/
├── web/                  Frontend: React + Vite + TypeScript + Tailwind + Framer Motion
│   ├── src/              App code (App.tsx is the screen, index.css loads Tailwind)
│   ├── public/           Static files served as-is (favicon, later the PWA icons)
│   ├── index.html        HTML entry point
│   └── vite.config.ts    Vite config (React + Tailwind plugins; reads .env from repo root)
├── jobs/                 Python 3.11+ background jobs, run by GitHub Actions
│   ├── collect.py        Hourly: forecast, tide, buoy, cam snapshot + crowd count
│   ├── collect_forecast.py  Hourly part 1: Open-Meteo forecast + tide -> `forecasts` (done)
│   ├── collect_buoy.py   Hourly part 2: PORTUS buoys -> `observations` (training only)
│   ├── collect_cam.py    Hourly part 3: Windy cam snapshot -> `snapshots` bucket + table
│   ├── add_spot.py       Guided: add a spot (coordinates, nearby cams + buoys to pick, orientation)
│   ├── import_past.py    One-off: my past Vilanova sessions -> `ratings` + historical forecasts
│   ├── explore.py        Local report: where the forecast is wrong (plots in explore_out/, never publish)
│   ├── train.py          Nightly: retrain per spot (or a general model), test on the last 14 days,
│   │                     activate only if it beats the current model and the simple score
│   ├── predict.py        Hourly + nightly: simple + AI scores for the next 3 days -> `predictions`
│   ├── notify.py         Hourly: surf alerts by web push (pywebpush, installed only in Actions)
│   ├── reasons.py        Plain-words reason for each AI score (Shapley values per condition group)
│   └── requirements.txt  Python dependencies for the jobs
├── supabase/
│   └── migrations/       SQL migrations for the Supabase Postgres database (run in order)
├── .github/workflows/
│   ├── collect.yml       Hourly (:17 UTC) + manual: forecast, buoys, cam as separate steps
│   └── train.yml         Nightly (03:23 UTC) + manual: train, then predictions
├── .env.example          Template of every env var; copy to .env (never committed)
├── .gitignore
├── CLAUDE.md             Project plan, rules and status
│
│   Earlier local prototype (SQLite, not yet migrated to the new stack):
├── collector/            Open-Meteo, PORTUS buoy and past-session collectors
├── rate.py, status.py    CLI to rate sessions / show row counts
└── requirements.txt      Prototype dependencies (standard library only)
```

`my_old_data/` (personal photos and screenshots) stays local and is git-ignored.

## Setup

1. Copy `.env.example` to `.env` and fill in the values.
2. Web:
   ```bash
   cd web
   npm install
   npm run dev
   ```
3. Jobs (Python 3.11+):
   ```bash
   python -m venv .venv
   .venv\Scripts\activate
   pip install -r jobs/requirements.txt
   python -m jobs.collect
   ```
   The forecast collector needs only the standard library (Python 3.10+):
   `python -m jobs.collect_forecast --dry-run --show 2` prints without writing.

## Freeing disk space

`clean.ps1` deletes rebuildable folders (node_modules, dist, caches, reports) after listing them
with sizes and asking y/N:

```powershell
powershell -ExecutionPolicy Bypass -File .\clean.ps1 -DryRun
```

## Secrets

Keys live only in `.env` locally and in GitHub Actions secrets / Vercel (or Netlify) env vars
online. Only `VITE_*` variables reach the browser.

## Surf alerts (web push) setup

1. Apply `supabase/migrations/20261122000013_push_alerts.sql` in the Supabase SQL editor.
2. `npm --prefix web run vapid-keys` writes `VITE_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and
   `VAPID_SUBJECT` into `.env` (run once; it refuses to replace existing keys).
3. GitHub > Settings > Secrets and variables > Actions: add `VAPID_PRIVATE_KEY` and
   `VAPID_SUBJECT` (values from `.env`).
4. Vercel > Settings > Environment Variables: add `VITE_VAPID_PUBLIC_KEY` (Production + Preview),
   then redeploy. Never put the private key in Vercel.
5. Push to `main`. The hourly "Hourly collect" run sends alerts after the predictions step;
   its "Run workflow" button has "Send a test surf alert" to check delivery.

Phones: Android (Chrome, Firefox, Samsung Internet, Edge) works in a tab or installed. iPhone
needs iOS 16.4+ and the app added to the Home Screen (Share > Add to Home Screen), opened from
the icon, then "Alert me" on a spot.
