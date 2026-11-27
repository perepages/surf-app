# When do the free plans run out? (estimate, 2026-11-26; updated for 0.7.2 on 2026-11-27)

Scaling item 6. Limits were checked on the providers' pages on 2026-11-26. Per-visit sizes were
**measured** on the production build (app 0.6.1 plus the unreleased items 1–5: commits fecf019,
6d73f99, da60188) and against the live database. Everything else is an assumption and is marked.
Re-check when the app changes a lot. `/admin` → "Free plan" shows the live numbers.

## Current free limits

| Service | Limit (free) | Source |
|---|---|---|
| Supabase database | 500 MB (over it: requests answer HTTP 402); disk 2 GB, read-only at 95% | supabase.com/pricing, docs "database size" |
| Supabase file storage | 1 GB | supabase.com/pricing |
| Supabase egress | 5 GB / month (+ 5 GB "cached", for the storage CDN) | supabase.com/pricing, docs "egress" |
| Supabase other | 500k Edge Function calls (not used), pauses after 7 days idle (the jobs keep it awake) | supabase.com/pricing |
| Vercel Hobby | 100 GB data transfer, 10 GB origin transfer, **1,000,000 CDN requests**, 1,000,000 function calls, 4 CPU-hours / month; over a limit = that feature stops until 30 days have passed. **Non-commercial only.** | vercel.com/docs/plans/hobby |
| Open-Meteo | 10,000 calls/day, 5,000/h, 600/min, per IP; a call = up to 10 variables × 2 weeks × 1 place, counted fractionally. **Non-commercial only.** | open-meteo.com/en/pricing |
| GitHub Actions | free and unlimited minutes for public repositories | GitHub docs |

## Measured

| What | Size |
|---|---|
| First visit, app files (service worker downloads all 24) | 365 KB compressed (1.2 MB uncompressed) |
| Spot photos | thumbnail 51 KB each (5 on the home page), full photo ~300 KB (desktop) |
| Home page forecast file (`index.json`) | 52 KB, ~10 KB compressed |
| Spot forecast file | 42 KB, 9.4 KB compressed |
| Supabase, home page | 7 requests, ~1 KB of data compressed (+ ~0.7 KB headers each) |
| Supabase, spot page | 5 requests; today ~0.5 KB of data; **with an AI model: 20 days of AI scores = 89 KB, ~5 KB compressed** |
| One app rating in the database | ~3 KB (forecast shown ~2 KB + measured weather + indexes) |
| Database now | 31 MB (forecasts 2 MB, observations 0.4 MB, predictions 0.2 MB) |
| Jobs' growth, 5 spots | ~40 MB/year (buoy readings ~26, predictions ~12; forecasts level off at ~27 MB because of thinning + 90-day pruning) |
| Open-Meteo | 23.6 calls per job run, ~190 a day at 8 runs: **2% of the limit, whatever the number of users** |
| One trained model file | ~0.5–1 MB; today every nightly model is kept, used or not (6 a night once all spots train) |

## Assumptions (not measured)

- A "daily user" (DAU) opens the app **1.3 times a day**; each visit = home page + **1.5 spot pages**.
- **5%** of daily users are new each day (full first download). **2 releases a month** (each user
  downloads ~300 KB of new app files once).
- **5%** of daily users send a rating each day.
- 5 spots. A month = 30 days. Supabase counts egress after compression (its docs say "bytes
  streamed to a connected client"; not stated outright, so the uncompressed case is shown too).

Per daily user and month this gives: Vercel transfer ~2.7 MB, Vercel CDN requests ~215, Supabase
egress ~0.85 MB (uncompressed worst case ~5.5 MB), database +~4.5 KB of ratings a month.

## Estimate

| Limit | 100 DAU | 1,000 DAU | 10,000 DAU | Runs out at |
|---|---|---|---|---|
| Supabase storage | ~0% | ~0% | ~0% | fixed in 0.7.0 (unused models deleted after 7 days): forecast files + 7 days of cam images + ≤ ~8 models ≈ 10 MB |
| **Vercel CDN requests** (1M/month) | 2% | 22% | **215% (used up by about day 14 of each month)** | **~4,650 DAU** (80% at ~3,700) |
| Supabase egress (5 GB/month) | <1% | ~2% | ~10% | **since 0.7.2 (fix 2) mostly not about users**: the page data rides in the CDN-cached forecast answer, so Supabase sends it ~once per 10 min per region (~0.2–0.3 GB/month); per visit only the visit counter (~0.7 KB) and the reads right after a rating. Before: ~5,900 DAU (worst case ~900) |
| **Supabase database** (500 MB) | 80% in ~7.5 years | 80% in ~3.6 years | **80% in ~7 months** | ratings: ~55 KB a year per daily user |
| Vercel data transfer (100 GB) | <1% | 3% | 27% | ~38,000 DAU |
| Vercel function calls (1M) | <5% | ~10% | ~10% | not about users: only CDN refreshes (≤ ~1,700/day/region) |
| Vercel origin transfer (10 GB) | <10% | ~47% | ~47% | not about users; grows with the number of spots (~9 spots → 80%) |
| Open-Meteo (10,000/day) | 2% | 2% | 2% | not about users: ~38 calls/day per spot (80% at ~210 spots) |
| GitHub Actions | free | free | free | public repo |

Other things to watch at 10,000 DAU: OpenStreetMap's map tiles (their policy forbids "heavy
use"; ~1,000+ map views a day would need a tile provider), and the hourly surf-alert step
gets slower with thousands of alerts (sent one by one).

## Cheapest fixes, in order (none needs a new service)

1. ✅ Done in 0.7.0: **delete unused model files** (keep the active one + the last 7 nights).
2. ✅ Done in 0.7.2: **the AI scores, today's reports, 14-day ratings, model info and the spot
   row(s) ride along in the `/api/forecast` answer** (`extras`, read with the public key, CDN 10
   min). No extra Vercel requests; Supabase is read directly only when a part is missing or right
   after a rating. Measured in the dev app: 0 Supabase requests on the home page and on a spot
   page (was 7 and 5).
3. ✅ Done in 0.7.0, now **10 minutes** (0.7.2, because the answer also carries today's reports):
   function calls and origin transfer ÷2 compared with 5 min.
4. **Vercel CDN requests** are the real ceiling on Hobby (~4,000–5,000 DAU). Before that point:
   longer re-check times in the app (15 → 30 min) gain ~20%. Beyond it, the options are a paid
   plan or moving the static site to a host without a request limit (e.g. Cloudflare Pages,
   free; a new service, to decide then).
5. **Database at ~10,000 DAU**: store less per rating (e.g. drop the forecast copy once training
   has used it, or keep only the fields training needs).

Note: Vercel Hobby and Open-Meteo's free API are for **non-commercial use only** (see "Money" in
CLAUDE.md: check licences before ads, sponsors or payments).
