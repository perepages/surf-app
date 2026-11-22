"""One-off: import my past Vilanova sessions (my_old_data/) into Supabase.

For each session this stores
  1. `ratings`   : my rating, source 'past_session', surfed_at = 14:00 local (time unknown;
                   middle of the agreed 12:00-17:00 window). If I saved a forecast screenshot,
                   its numbers go in `forecast_shown` (= the forecast I actually saw).
  2. `forecasts` : what Open-Meteo said for that local day, from the Marine API (waves, tide)
                   and the Historical Forecast API (wind). Marked `marine_model` =
                   'historical:best_match'. The historical data is stitched from the first
                   hours of successive model runs, so it's stored as lead 0
                   (fetched_at = valid_at). Training must treat these rows apart from live ones.
  3. Buoys: not possible. PORTUS only serves the last ~48 h; older data needs a manual
     data request on portus.puertos.es.

Decisions (2026-11-22): ratings were "2.5 or 3" -> stored as 3; time 14:00 local for all;
Morocco (2023-12-28) and Bogatell (2026-11-05) skipped (not Vilanova). No wave size was noted.
Values below were read by eye from the screenshots (same numbers as the old
collector/import_past.py, re-checked against the images).

Idempotent: re-running updates the same rating (same spot + source + surfed_at) and
skips forecast hours already stored (never overwrites a live forecast row).

Run from the repo root:
  python -m jobs.import_past --dry-run   # show what would be stored
  python -m jobs.import_past             # store
Weather data by Open-Meteo.com
"""
from __future__ import annotations

import argparse
import sys
import urllib.parse
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

from jobs.check_connections import ROOT, env, load_dotenv
from jobs.collect_forecast import (MARINE_URL, TIDE_VARS, WAVE_VARS, WIND_VARS,
                                   Supabase, column_value, http)

HISTORICAL_WEATHER_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
HISTORICAL_MODEL = "historical:best_match"
SOURCE = "past_session"
SPOT_ID = "vilanova"
MS_TO_KMH = 3.6


@dataclass
class SavedHour:
    """One hour from a forecast screenshot, local time. Wind in m/s as the app shows it."""
    local: str
    wave_height: float
    wave_period: float
    wave_direction: float      # degrees, coming from ("<-" arrow on the app = from E = 90)
    wind_ms: float
    wind_direction: float      # degrees, coming from
    gust_ms: float


@dataclass
class Session:
    day: str                   # local date
    utc_offset_h: int          # Spain: +1 winter (CET), +2 summer (CEST)
    rating: int
    files: list[str]
    note: str
    screenshot: str | None = None   # app + model the saved numbers come from
    saved: list[SavedHour] = field(default_factory=list)
    local_time: str = "14:00"


def h(local: str, wh: float, wp: float, wd: float, ws: float, wdir: float, gust: float) -> SavedHour:
    return SavedHour(local, wh, wp, wd, ws, wdir, gust)


SESSIONS = [
    Session(
        day="2022-02-26", utc_offset_h=1, rating=3,
        files=["Screenshot_2026-11-20-21-33-36-459_com.strava.jpg"],
        note="Screenshot 'Surf Vilanova i la Geltrú'. Rated '2.5 or 3', stored 3. Date from the "
             "app calendar (Sat 26). Forecast seen on the session day, time unknown.",
        screenshot="Surf forecast app, GFS27 model, 3-hourly",
        saved=[
            h("2022-02-26 01:00", 0.5, 4, 90, 1.4, 135, 1.3),
            h("2022-02-26 04:00", 0.5, 5, 90, 1.4, 112.5, 1.3),
            h("2022-02-26 07:00", 0.8, 5, 90, 3.7, 90, 3.6),
            h("2022-02-26 10:00", 1.3, 7, 90, 4.7, 90, 4.4),
            h("2022-02-26 13:00", 1.3, 6, 90, 6.9, 90, 6.8),
            h("2022-02-26 16:00", 1.0, 4, 90, 6.0, 90, 6.1),
            h("2022-02-26 19:00", 0.7, 4, 90, 4.2, 100, 4.8),
            h("2022-02-26 22:00", 0.7, 4, 90, 3.2, 90, 4.0),
            h("2022-02-27 01:00", 0.7, 5, 90, 3.2, 90, 3.8),
        ],
    ),
    Session(
        day="2022-04-14", utc_offset_h=2, rating=3,
        files=["Screenshot_2026-11-20-21-33-31-142_com.strava.jpg"],
        note="Screenshot 'Surf in Vilanova. 2'. Rated '2.5 or 3', stored 3. Date from the app "
             "calendar (Thu 14, GMT+2). Forecast seen on the session day, time unknown.",
        screenshot="Surf forecast app, GFS27 model, hourly",
        saved=[
            h("2022-04-14 12:00", 1.5, 6, 90, 6.2, 90, 10),
            h("2022-04-14 13:00", 1.6, 7, 90, 8.5, 90, 13),
            h("2022-04-14 14:00", 1.7, 7, 90, 11, 90, 15),
            h("2022-04-14 15:00", 1.7, 6, 90, 11, 90, 14),
            h("2022-04-14 16:00", 1.6, 5, 90, 7.8, 90, 11),
            h("2022-04-14 17:00", 1.5, 5, 90, 5.6, 90, 9.0),
            h("2022-04-14 18:00", 1.5, 5, 90, 6.4, 80, 11),
            h("2022-04-14 19:00", 1.4, 6, 90, 7.2, 70, 12),
            h("2022-04-14 20:00", 1.3, 7, 90, 6.4, 70, 11),
        ],
    ),
    Session(
        day="2023-11-12", utc_offset_h=1, rating=3,
        files=["IMG-20231112-WA0031.jpg", "IMG-20231112-WA0032.jpg"],
        note="WhatsApp photos (small clean waves, ~5 surfers). Rated '2.5 or 3', stored 3. "
             "No forecast saved; no location in the photos.",
    ),
]


# ---------- time ----------

def local_to_utc(local: str, offset_h: int) -> datetime:
    naive = datetime.strptime(local, "%Y-%m-%d %H:%M")
    return (naive - timedelta(hours=offset_h)).replace(tzinfo=timezone.utc)


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------- 1. rating ----------

def forecast_shown(s: Session) -> dict[str, Any] | None:
    if not s.saved:
        return None
    return {
        "kind": "past_session_screenshot",
        "provider": s.screenshot,
        "seen_at": None,  # on the session day, exact time unknown
        "files": s.files,
        "units": {"wave_height": "m", "wave_period": "s", "wind_speed": "km/h",
                  "directions": "degrees, coming from"},
        "hours": [{
            "valid_at": iso(local_to_utc(r.local, s.utc_offset_h)),
            "wave_height": r.wave_height,
            "wave_period": r.wave_period,
            "wave_direction": r.wave_direction,
            "wind_speed": round(r.wind_ms * MS_TO_KMH, 1),
            "wind_direction": r.wind_direction,
            "wind_gusts": round(r.gust_ms * MS_TO_KMH, 1),
        } for r in s.saved],
        "note": s.note,
    }


def rating_row(s: Session) -> dict[str, Any]:
    return {
        "spot_id": SPOT_ID,
        "surfed_at": iso(local_to_utc(f"{s.day} {s.local_time}", s.utc_offset_h)),
        "overall": s.rating,
        "wave_size": None,
        "source": SOURCE,
        "forecast_shown": forecast_shown(s) or {"kind": "past_session_no_forecast",
                                                 "files": s.files, "note": s.note},
    }


def store_rating(db: Supabase, row: dict[str, Any]) -> str:
    query = urllib.parse.urlencode({"select": "id", "spot_id": f"eq.{row['spot_id']}",
                                    "source": f"eq.{SOURCE}", "surfed_at": f"eq.{row['surfed_at']}"})
    existing = http(f"{db.base}/ratings?{query}", db.headers)
    headers = {**db.headers, "Prefer": "return=minimal"}
    if existing:
        http(f"{db.base}/ratings?id=eq.{existing[0]['id']}", headers, method="PATCH", body=row)
        return f"updated rating id {existing[0]['id']}"
    http(f"{db.base}/ratings", headers, method="POST", body=[row])
    return "inserted rating"


# ---------- 2. historical forecast ----------

def fetch_day(lat: float, lon: float, first: date, last: date) -> dict[str, dict[str, Any]]:
    """{'YYYY-MM-DDTHH:MM' UTC: {open_meteo_var: value}} for waves+tide and wind."""
    common = {"latitude": lat, "longitude": lon, "timezone": "UTC",
              "start_date": first.isoformat(), "end_date": last.isoformat()}
    out: dict[str, dict[str, Any]] = {}
    for url, variables in ((MARINE_URL, list(WAVE_VARS) + list(TIDE_VARS)),
                           (HISTORICAL_WEATHER_URL, list(WIND_VARS))):
        hourly = http(f"{url}?{urllib.parse.urlencode({**common, 'hourly': ','.join(variables)})}")["hourly"]
        for i, t in enumerate(hourly["time"]):
            out.setdefault(t, {}).update({v: hourly[v][i] for v in variables})
    return out


def historical_rows(s: Session, lat: float, lon: float) -> list[dict[str, Any]]:
    start = local_to_utc(f"{s.day} 00:00", s.utc_offset_h)
    end = start + timedelta(hours=23)
    data = fetch_day(lat, lon, start.date(), end.date())
    rows = []
    for t, values in sorted(data.items()):
        valid_at = datetime.strptime(t, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
        if not start <= valid_at <= end:
            continue
        row: dict[str, Any] = {"spot_id": SPOT_ID, "fetched_at": iso(valid_at),
                               "valid_at": iso(valid_at), "marine_model": HISTORICAL_MODEL}
        for source in (WAVE_VARS, TIDE_VARS, WIND_VARS):
            for om_name, column in source.items():
                row[column] = column_value(column, values.get(om_name))
        rows.append(row)
    return rows


def around(rows: list[dict[str, Any]], at: datetime, key: str, hours: int = 1) -> Any:
    vals = [r[key] for r in rows
            if r.get(key) is not None
            and abs(datetime.fromisoformat(r["valid_at"].replace("Z", "+00:00")) - at)
            <= timedelta(hours=hours)]
    return round(sum(vals) / len(vals), 2) if vals else None


# ---------- entry point ----------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="show, don't store")
    args = parser.parse_args()
    load_dotenv(ROOT / ".env")
    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        print("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set")
        return 1
    db = Supabase(url, key)
    spot = http(f"{db.base}/spots?select=lat,lon&id=eq.{SPOT_ID}", db.headers)[0]

    failed = 0
    for s in SESSIONS:
        rating = rating_row(s)
        at = datetime.fromisoformat(rating["surfed_at"].replace("Z", "+00:00"))
        print(f"\n{s.day} {s.local_time} local = {rating['surfed_at']}  rating {s.rating}/5")
        try:
            hist = historical_rows(s, spot["lat"], spot["lon"])
            saved = (forecast_shown(s) or {}).get("hours", [])
            print(f"  saved forecast : {len(saved)} hours"
                  + (f"; around 14:00: wave {around(saved, at, 'wave_height', 2)} m, "
                     f"wind {around(saved, at, 'wind_speed', 2)} km/h" if saved else " (none saved)"))
            print(f"  open-meteo hist: {len(hist)} hours; around 14:00: "
                  f"wave {around(hist, at, 'wave_height')} m {around(hist, at, 'wave_period')} s "
                  f"from {around(hist, at, 'wave_direction')} deg, "
                  f"wind {around(hist, at, 'wind_speed')} km/h from {around(hist, at, 'wind_direction')} deg, "
                  f"tide {around(hist, at, 'sea_level_height')} m")
            if args.dry_run:
                print("  (dry run: nothing stored)")
                continue
            print(f"  {store_rating(db, rating)}")
            # ignore-duplicates: a historical row has the same key as a live lead-0 row
            # (fetched_at = valid_at), so for a recent session it must never overwrite one.
            http(f"{db.base}/forecasts?on_conflict=spot_id,fetched_at,valid_at",
                 {**db.headers, "Prefer": "resolution=ignore-duplicates,return=minimal"},
                 method="POST", body=hist)
            print(f"  sent {len(hist)} forecast hours ({HISTORICAL_MODEL}; existing hours kept)")
        except Exception as exc:
            failed = 1
            print(f"  FAILED: {type(exc).__name__}: {exc}")
    print("\nBuoys: not imported (PORTUS keeps ~48 h; older data needs a manual data request).")
    return failed


if __name__ == "__main__":
    sys.exit(main())
