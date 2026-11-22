"""Hourly: store Puertos del Estado (PORTUS) buoy readings in Supabase `observations`.

TRAINING ONLY: buoy data is never shown publicly (no public grant on `observations`).

PORTUS has no documented API. This uses the JSON API the PORTUS map itself calls
(https://portus.puertos.es, checked 2026-11-22):
  POST portussvr/api/lastData/station/{id}  body ["WAVE","WIND"]
       -> latest reading; tells us which parameter ids the buoy has
  POST portussvr/api/RTData/station/{id}    body [parameter ids]
       -> the last ~48 hourly readings; 'fecha' is UTC; values are text + a factor
          ("94" / 100 = 0.94 m)
It's unofficial and may change; if it breaks, only this file needs fixing (the official
alternative is the Puertos del Estado THREDDS server).

Buoys come from `spots.buoy_ids` of every active spot (config-driven). Vilanova:
1731 Barcelona II (coastal, waves only, 42.5 km ENE) and 2720 Tarragona (deep water,
waves + wind, 61.3 km SSW).

Every run stores the whole ~48 h series and upserts on (spot_id, buoy_id, observed_at):
hours a failed run missed are filled in later, and nothing is duplicated.

Columns:
  wave_height    = Hm0 (significant height, m)
  wave_period    = Tp (peak period, s)
  wave_direction = MeanDirPeak if the buoy has it, else MeanDir (degrees, coming from)
  wind_speed     = WindSpeed, m/s -> km/h (same unit as `forecasts`)
  wind_direction = WindDir (degrees, coming from)
Values PORTUS flags as faulty ('averia') or leaves empty are stored as null.

Run from the repo root:
  python -m jobs.collect_buoy             # fetch + write to Supabase
  python -m jobs.collect_buoy --dry-run   # fetch only, print what would be written
Exit code 1 if any buoy failed (the others are still stored). Standard library only.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from typing import Any

from jobs import log
from jobs.check_connections import ROOT, env, load_dotenv
from jobs.collect_forecast import Supabase, http

JOB = "collect_buoy"
PORTUS_API = "https://portus.puertos.es/portussvr/api"

# PORTUS 'paramEseoo' codes we fetch.
WANTED = ["Hm0", "Tp", "MeanDirPeak", "MeanDir", "WindSpeed", "WindDir"]
MS_TO_KMH = 3.6


class BuoySupabase(Supabase):
    def spots_with_buoys(self) -> list[dict[str, Any]]:
        query = "select=id,buoy_ids&active=eq.true&order=id"
        return http(f"{self.base}/spots?{query}", self.headers)

    def upsert_observations(self, rows: list[dict[str, Any]]) -> None:
        url = f"{self.base}/observations?on_conflict=spot_id,buoy_id,observed_at"
        headers = {**self.headers, "Prefer": "resolution=merge-duplicates,return=minimal"}
        http(url, headers, method="POST", body=rows)


# ---------- PORTUS ----------

def portus_post(path: str, body: Any) -> Any:
    return http(f"{PORTUS_API}/{path}?locale=es", method="POST", body=body)


def fetch_series(buoy_id: str) -> list[dict[str, Any]]:
    """[{'fecha': '2026-11-22 12:00:00.0', 'datos': [{paramEseoo, valor, factor, averia}]}]"""
    latest = portus_post(f"lastData/station/{buoy_id}", ["WAVE", "WIND"]) or {}
    param_ids = [d["id"] for d in latest.get("datos", []) if d.get("paramEseoo") in WANTED]
    if not param_ids:
        raise RuntimeError("PORTUS lists none of the wanted parameters for this buoy")
    return portus_post(f"RTData/station/{buoy_id}", param_ids) or []


def scaled(item: dict[str, Any]) -> float | None:
    raw = item.get("valor")
    if raw in (None, "") or item.get("averia"):
        return None
    try:
        return float(raw) / (item.get("factor") or 1.0)
    except (TypeError, ValueError):
        return None


def direction(value: float | None) -> int | None:
    return None if value is None else int(round(value)) % 360


def entry_to_row(spot_id: str, buoy_id: str, entry: dict[str, Any]) -> dict[str, Any]:
    v = {item.get("paramEseoo"): scaled(item) for item in entry.get("datos", [])}
    observed_at = datetime.strptime(entry["fecha"][:19], "%Y-%m-%d %H:%M:%S")
    wind = v.get("WindSpeed")
    peak_dir = v.get("MeanDirPeak")
    return {
        "spot_id": spot_id,
        "buoy_id": buoy_id,
        "observed_at": observed_at.strftime("%Y-%m-%dT%H:%M:%SZ"),  # PORTUS 'fecha' is UTC
        "wave_height": None if v.get("Hm0") is None else round(v["Hm0"], 2),
        "wave_period": None if v.get("Tp") is None else round(v["Tp"], 2),
        "wave_direction": direction(peak_dir if peak_dir is not None else v.get("MeanDir")),
        "wind_speed": None if wind is None else round(wind * MS_TO_KMH, 1),
        "wind_direction": direction(v.get("WindDir")),
    }


def summary(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return "0 rows"
    latest = rows[-1]
    return (f"{len(rows)} rows, {rows[0]['observed_at']} .. {latest['observed_at']} "
            f"({_hours_old(rows):.1f} h old); latest Hm0 {latest['wave_height']} m, "
            f"Tp {latest['wave_period']} s, dir {latest['wave_direction']}, "
            f"wind {latest['wind_speed']} km/h")


# ---------- entry point ----------

STALE_HOURS = 6  # newest reading older than this = buoy has gone quiet (logged, not a failure)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true",
                        help="fetch and print, don't write to Supabase")
    parser.add_argument("--show", type=int, default=0, metavar="N",
                        help="print the newest N rows of each buoy as JSON")
    args, _ = parser.parse_known_args()  # also run from jobs.collect with its flags

    load_dotenv(ROOT / ".env")
    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        log.fail(JOB, "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (.env or GitHub secrets)")
        return 1
    db = BuoySupabase(url, key)

    print(f"[{JOB}]{' (dry run)' if args.dry_run else ''}")
    failed = []
    series_cache: dict[str, list[dict[str, Any]]] = {}  # a buoy shared by spots is fetched once
    for spot in db.spots_with_buoys():
        for buoy_id in spot.get("buoy_ids") or []:
            label = f"{spot['id']}/{buoy_id}"
            try:
                if buoy_id not in series_cache:
                    series_cache[buoy_id] = fetch_series(buoy_id)
                rows, bad = [], 0
                for entry in series_cache[buoy_id]:
                    try:
                        rows.append(entry_to_row(spot["id"], buoy_id, entry))
                    except (KeyError, TypeError, ValueError):
                        bad += 1  # one malformed reading must not lose the other 47
                rows.sort(key=lambda r: r["observed_at"])
                if bad:
                    log.warn(JOB, f"[{label}] skipped {bad} malformed PORTUS readings "
                                  "(API format changed?)")
                if args.show:
                    print(json.dumps(rows[-args.show:], indent=2))
                if rows and not args.dry_run:
                    db.upsert_observations(rows)
                result = f"[{label}] {'would store' if args.dry_run else 'stored'} {summary(rows)}"
                if not rows or _hours_old(rows) > STALE_HOURS:
                    log.warn(JOB, f"{result}; no reading in the last {STALE_HOURS} h "
                                  "(buoy may be in maintenance)")
                else:
                    log.ok(JOB, result)
            except Exception as exc:  # one bad buoy must not stop the others
                failed.append(label)
                log.fail(JOB, f"[{label}] {type(exc).__name__}: {exc}")

    if failed:
        print(f"[{JOB}] failed: {', '.join(failed)}")
        return 1
    return 0


def _hours_old(rows: list[dict[str, Any]]) -> float:
    newest = datetime.fromisoformat(rows[-1]["observed_at"].replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - newest).total_seconds() / 3600


if __name__ == "__main__":
    sys.exit(main())
