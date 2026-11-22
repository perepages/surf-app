"""Hourly (after the forecast) and after training: write the scores the app shows into `predictions`.

For every active spot, for each hour of the newest live forecast run, up to --hours (72 = the
next 3 days) from now:
  simple_score    always (same rules as the app)
  ai_score        1-5, from the spot's ACTIVE model (models.is_active); null if there is none
  ai_wave_height  m, from the active model's wave-height part; null if it has none
  confidence      the active model's held-out accuracy (1 - test MAE / 4), same for every hour
  reason          e.g. "Offshore wind under 15 km/h — usually better than forecast here", or
                  null when the shown 1-5 value is the same (the app then shows the simple reason)
  model_version   the active model's version; null = simple score only

Upsert on (spot_id, valid_at): each run overwrites future hours with the newest numbers; hours
already past keep their last prediction (the app's "forecast vs surfers" chart reads them);
rows beyond the horizon are deleted. The app's 4th day tab (72-96 h) shows the simple score.
No active model -> AI columns are written as null, so a deactivated model stops showing at once
(the app only uses rows with an ai_score).

Reason: see jobs/reasons.py (Shapley values per group of conditions, in plain words).

Run from the repo root:
  python -m jobs.predict                    # write
  python -m jobs.predict --dry-run --show 5 # print, write nothing
  python -m jobs.predict --dry-run --model-file my.joblib   # try a local model file (dry run only)
Needs scikit-learn (jobs/requirements.txt). Weather data by Open-Meteo.com.
"""
from __future__ import annotations

import argparse
import math
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any

from jobs import log
from jobs.check_connections import ROOT, env, load_dotenv
from jobs.collect_forecast import Supabase, http
from jobs.explore import HISTORICAL, simple_score, ts
from jobs.reasons import reasons
from jobs.train import (active_model, features, first_num, iso, joblib, load_bundle, matrix,
                        predict)

JOB = "predict"
UTC = timezone.utc
Row = dict[str, Any]
UPSERT_BATCH = 500
PREDICT_HOURS = 72  # the next 3 days; rows further ahead are deleted each run
FORECAST_COLS = ("valid_at,lead_hours,marine_model,wave_height,wave_period,wave_direction,"
                 "swell_wave_height,swell_wave_period,swell_wave_direction,sea_level_height,"
                 "wind_speed,wind_direction")

def shown_value(x: float) -> int:
    """The 1-5 value the app shows (JS Math.round: halves round up)."""
    return min(5, max(1, math.floor(x + 0.5)))


def latest_run(db: Supabase, spot_id: str) -> list[Row]:
    sid = urllib.parse.quote(spot_id)
    newest = http(f"{db.base}/forecasts?select=fetched_at&spot_id=eq.{sid}"
                  f"&marine_model=neq.{urllib.parse.quote(HISTORICAL)}&order=fetched_at.desc&limit=1",
                  db.headers)
    if not newest:
        return []
    fetched = urllib.parse.quote(newest[0]["fetched_at"])
    return http(f"{db.base}/forecasts?select={FORECAST_COLS}&spot_id=eq.{sid}"
                f"&fetched_at=eq.{fetched}&order=valid_at", db.headers) or []


def build(spot: Row, forecast: list[Row], bundle: Row | None, now: datetime) -> list[Row]:
    faces = spot["beach_orientation"]
    rows, conds = [], []
    for f in forecast:
        when = ts(f["valid_at"])
        simple = simple_score(f, faces)
        rows.append({"x": {**features(f, f.get("lead_hours"), spot, when), "simple_score": float(simple)},
                     "simple": float(simple),
                     "forecast_height": first_num(f.get("wave_height"), f.get("swell_wave_height"))})
        conds.append(f)
    out = [{"spot_id": spot["id"], "valid_at": iso(ts(f["valid_at"])), "simple_score": int(r["simple"]),
            "ai_score": None, "ai_wave_height": None, "confidence": None, "reason": None,
            "model_version": None, "updated_at": iso(now)} for f, r in zip(conds, rows)]
    if not bundle or not rows:
        return out
    overall, height = bundle.get("overall"), bundle.get("wave_height")
    ref = bundle.get("reference") or {}
    accuracy = (bundle.get("metrics") or {}).get("accuracy")
    ai = predict(overall, rows) if overall is not None else [None] * len(rows)
    with_h = [i for i, r in enumerate(rows) if r["forecast_height"] is not None]
    heights = dict(zip(with_h, predict(height, [rows[i] for i in with_h]))) if height is not None and with_h else {}
    why = (reasons(overall, rows, [float(a) for a in ai], ref, conds, spot["beach_orientation"],
                   shown_value) if overall is not None else [None] * len(rows))
    for i, o in enumerate(out):
        if ai[i] is None:
            continue
        o.update({
            "ai_score": round(float(ai[i]), 2),
            "ai_wave_height": round(float(heights[i]), 2) if i in heights else None,
            "confidence": None if accuracy is None else round(max(0.0, min(1.0, accuracy)), 3),
            "reason": why[i],
            "model_version": bundle["version"],
        })
    return out


def predict_spot(db: Supabase, spot: Row, args: argparse.Namespace, now: datetime) -> bool:
    until = now + timedelta(hours=args.hours)
    forecast = [f for f in latest_run(db, spot["id"]) if ts(f["valid_at"]) <= until]
    if not forecast:
        log.warn(JOB, f"[{spot['id']}] no live forecast stored yet; nothing to predict")
        return True
    ok, bundle, source = True, None, "no active model: simple score only"
    if args.model_file:
        bundle, source = joblib.load(args.model_file), f"local file {args.model_file}"
    else:
        current = active_model(db, spot["id"])
        if current:
            try:
                bundle, source = load_bundle(db, current["artifact_path"]), f"model {current['version']}"
            except Exception as exc:
                # Still write: AI columns go null, so the app falls back to the simple score.
                ok = False
                source = f"model {current['version']} unloadable: simple score only"
                log.fail(JOB, f"[{spot['id']}] active model {current['version']} can't be loaded "
                              f"({type(exc).__name__}: {exc}); writing the simple score only")
    rows = build(spot, forecast, bundle, now)
    for r in rows[:args.show]:
        print(f"        {r['valid_at']} simple {r['simple_score']} ai {r['ai_score']} "
              f"height {r['ai_wave_height']} | {r['reason'] or ''}")
    changed = sum(r["ai_score"] is not None and shown_value(r["ai_score"]) != r["simple_score"] for r in rows)
    summary = (f"{len(rows)} hours {rows[0]['valid_at']} .. {rows[-1]['valid_at']} ({source}); "
               f"AI changes the shown score in {changed}")
    if args.dry_run:
        log.ok(JOB, f"[{spot['id']}] would write {summary}; dry run")
        return ok
    headers = {**db.headers, "Prefer": "resolution=merge-duplicates,return=minimal"}
    for i in range(0, len(rows), UPSERT_BATCH):
        http(f"{db.base}/predictions?on_conflict=spot_id,valid_at", headers, method="POST",
             body=rows[i:i + UPSERT_BATCH])
    # Rows beyond the horizon (left by an earlier, longer run) would never be refreshed until
    # they come within range: remove them so the app never shows an old AI score there.
    http(f"{db.base}/predictions?spot_id=eq.{urllib.parse.quote(spot['id'])}"
         f"&valid_at=gt.{urllib.parse.quote(iso(until))}",
         {**db.headers, "Prefer": "return=minimal"}, method="DELETE")
    log.ok(JOB, f"[{spot['id']}] wrote {summary}")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--spot", help="only this spot id (default: every active spot)")
    parser.add_argument("--dry-run", action="store_true", help="compute and print, write nothing")
    parser.add_argument("--show", type=int, default=0, metavar="N", help="print the first N hours")
    parser.add_argument("--hours", type=int, default=PREDICT_HOURS, metavar="N",
                        help=f"predict up to N hours from now (default {PREDICT_HOURS} = 3 days)")
    parser.add_argument("--model-file", help="use this local model file instead of the active "
                                             "model (only with --dry-run)")
    args, _ = parser.parse_known_args()  # also run from jobs.collect with its flags
    if args.model_file and not args.dry_run:
        parser.error("--model-file only works with --dry-run (only activated models go live)")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    load_dotenv(ROOT / ".env")
    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        log.fail(JOB, "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (.env or GitHub secrets)")
        return 1
    db = Supabase(url, key)
    now = datetime.now(UTC).replace(microsecond=0)
    query = "select=id,lat,lon,beach_orientation&order=id"
    query += f"&id=eq.{urllib.parse.quote(args.spot)}" if args.spot else "&active=eq.true"
    spots = http(f"{db.base}/spots?{query}", db.headers)
    if not spots:
        log.fail(JOB, "No matching spots.")
        return 1
    print(f"[{JOB}] {iso(now)}{' (dry run)' if args.dry_run else ''}")
    failed = []
    for spot in spots:
        try:
            if not predict_spot(db, spot, args, now):
                failed.append(spot["id"])
        except Exception as exc:  # one spot failing must not stop the others
            failed.append(spot["id"])
            log.fail(JOB, f"[{spot['id']}] {type(exc).__name__}: {exc}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
