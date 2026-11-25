"""Hourly (after the forecast) and after training: write the scores the app shows into `predictions`.

For every active spot, for each hour of the newest live forecast run, up to --hours (72 = the
next 3 days) from now:
  simple_score    always (the old simple rules; kept until the app uses the physics score)
  physics_waves / physics_shape / physics_overall   always: jobs/physics.py (rule-based), with
                  the 72 h before the run (from earlier runs) for wind history and rain
  ai_waves / ai_shape   the spot's ACTIVE model (models.is_active): physics + learned correction
  ai_score        overall(ai_waves, ai_shape): wave quality WITHOUT comfort (rain, cold and
                  safety are rules, applied in the app with each user's preferences)
  ai_wave_height  m, from the active model's wave-height part; null if it has none
  confidence      the active model's held-out accuracy (1 - test MAE / 4), same for every hour
  reason          e.g. "Offshore wind under 15 km/h — usually better than forecast here", or
                  null when the shown 1-5 value is the same as the physics one
  model_version   the active model's version; null = physics score only

Upsert on (spot_id, valid_at): each run overwrites future hours with the newest numbers; hours
already past keep their last prediction (the app's "forecast vs surfers" chart reads them);
rows beyond the horizon are deleted. The app's 4th day tab (72-96 h) shows the simple score.
No active model -> AI columns are written as null, so a deactivated model stops showing at once
(the app only uses rows with an ai_score). An active model from the engine before physics-v1
is not used (AI columns null, warning) until training replaces it.

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
from jobs import physics
from jobs.reasons import reasons
from jobs.train import (ENGINE, HISTORY_H, active_model, corrected, first_num, history_rows,
                        iso, joblib, load_bundle, model_input, predict)

JOB = "predict"
UTC = timezone.utc
Row = dict[str, Any]
UPSERT_BATCH = 500
PREDICT_HOURS = 72  # the next 3 days; rows further ahead are deleted each run
STALE_AFTER_H = 3   # warn when the newest stored forecast run is older than this
FORECAST_COLS = "*"

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


def build(spot: Row, forecast: list[Row], bundle: Row | None, now: datetime,
          history: list[Row] | None = None) -> list[Row]:
    faces = spot["beach_orientation"]
    series = physics.series_of([*(history or []), *forecast])
    rows, conds = [], []
    for f in forecast:
        x, res = model_input(f, spot, series, ts(f["valid_at"]), f.get("lead_hours"))
        rows.append({"x": x, "physics_waves": res["waves"], "physics_shape": res["shape"],
                     "physics_overall": res["overall"],
                     "forecast_height": first_num(f.get("wave_height"), f.get("swell_wave_height"))})
        conds.append(f)
    out = [{"spot_id": spot["id"], "valid_at": iso(ts(f["valid_at"])),
            "simple_score": int(simple_score(f, faces)),
            "physics_waves": round(r["physics_waves"], 2), "physics_shape": round(r["physics_shape"], 2),
            "physics_overall": round(r["physics_overall"], 2),
            "ai_score": None, "ai_waves": None, "ai_shape": None, "ai_wave_height": None,
            "confidence": None, "reason": None, "model_version": None, "updated_at": iso(now)}
           for f, r in zip(conds, rows)]
    if not bundle or not rows:
        return out
    if bundle.get("engine") != ENGINE:
        raise OldEngine(bundle.get("version"))
    height = bundle.get("wave_height")
    ref = bundle.get("reference") or {}
    accuracy = (bundle.get("metrics") or {}).get("accuracy")
    # A model that breaks here (e.g. odd values in a new forecast) must not stop the physics
    # scores being written: the caller catches this and writes `out` as it is.
    waves = corrected(bundle.get("waves"), rows, "physics_waves")
    shape = corrected(bundle.get("shape"), rows, "physics_shape")
    ai = [physics.overall_score(a, b) for a, b in zip(waves, shape)]
    with_h = [i for i, r in enumerate(rows) if r["forecast_height"] is not None]
    heights = dict(zip(with_h, predict(height, [rows[i] for i in with_h]))) if height is not None and with_h else {}
    try:
        why = reasons(bundle, rows, ai, ref, conds, faces, shown_value)
    except Exception as exc:  # the scores are still right; the app shows the physics reason
        log.warn(JOB, f"[{spot['id']}] reasons failed ({type(exc).__name__}: {exc}); AI scores "
                      "written without them")
        why = [None] * len(rows)
    for i, o in enumerate(out):
        o.update({
            "ai_score": round(float(ai[i]), 2),
            "ai_waves": round(float(waves[i]), 2),
            "ai_shape": round(float(shape[i]), 2),
            "ai_wave_height": round(float(heights[i]), 2) if i in heights else None,
            "confidence": None if accuracy is None else round(max(0.0, min(1.0, accuracy)), 3),
            "reason": why[i],
            "model_version": bundle["version"],
        })
    return out


class OldEngine(Exception):
    """An active model trained before physics-v1: its features no longer exist."""


def predict_spot(db: Supabase, spot: Row, args: argparse.Namespace, now: datetime) -> bool:
    until = now + timedelta(hours=args.hours)
    run = latest_run(db, spot["id"])
    forecast = [f for f in run if ts(f["valid_at"]) <= until]
    if not forecast:
        log.warn(JOB, f"[{spot['id']}] no live forecast stored yet; nothing to predict")
        return True
    fetched = ts(forecast[0]["fetched_at"])
    if now - fetched > timedelta(hours=STALE_AFTER_H):
        # The forecast collector has been failing: say so here too (it's the step people see).
        log.warn(JOB, f"[{spot['id']}] newest stored forecast is from {iso(fetched)} "
                      f"({(now - fetched).total_seconds() / 3600:.0f} h old); check the forecast step")
    ok, bundle, source = True, None, "no active model: physics score only"
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
                source = f"model {current['version']} unloadable: physics score only"
                log.fail(JOB, f"[{spot['id']}] active model {current['version']} can't be loaded "
                              f"({type(exc).__name__}: {exc}); writing the physics score only")
    history = history_rows(db, spot["id"], ts(forecast[0]["valid_at"]) - timedelta(hours=HISTORY_H),
                           ts(forecast[0]["valid_at"]))
    try:
        rows = build(spot, forecast, bundle, now, history)
    except OldEngine:
        log.warn(JOB, f"[{spot['id']}] active model {bundle.get('version')} is from the engine before "
                      f"{ENGINE}: physics scores only until training replaces it")
        source = "old-engine model ignored: physics score only"
        rows = build(spot, forecast, None, now, history)
    except Exception as exc:
        if not bundle:
            raise
        # Write the simple score anyway (AI columns null), so the app never shows an AI score
        # from an older run next to a newer forecast.
        ok, source = False, f"model {bundle.get('version')} failed: physics score only"
        log.fail(JOB, f"[{spot['id']}] the active model failed on this forecast "
                      f"({type(exc).__name__}: {exc}); writing the physics score only")
        rows = build(spot, forecast, None, now, history)
    for r in rows[:args.show]:
        print(f"        {r['valid_at']} simple {r['simple_score']} physics {r['physics_overall']} "
              f"(waves {r['physics_waves']} shape {r['physics_shape']}) ai {r['ai_score']} "
              f"(waves {r['ai_waves']} shape {r['ai_shape']}) height {r['ai_wave_height']} | "
              f"{r['reason'] or ''}")
    changed = sum(r["ai_score"] is not None
                  and shown_value(r["ai_score"]) != shown_value(r["physics_overall"]) for r in rows)
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
    query = "select=id,lat,lon,beach_orientation,swell_window_min,swell_window_max&order=id"
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
