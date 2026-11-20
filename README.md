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
│   ├── train.py          Nightly: retrain per spot, promote only if it beats the current model
│   └── requirements.txt  Python dependencies for the jobs
├── supabase/
│   └── migrations/       SQL migrations for the Supabase Postgres database (run in order)
├── .github/workflows/
│   ├── collect.yml       Runs jobs/collect.py (hourly once enabled)
│   └── train.yml         Runs jobs/train.py (nightly once enabled)
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

## Secrets

Keys live only in `.env` locally and in GitHub Actions secrets / Vercel (or Netlify) env vars
online. Only `VITE_*` variables reach the browser.
