"""Hourly: attach the MEASURED weather to each rating (ratings.weather_measured).

Ratings must separate waves from weather (docs/surf_theory.md section 7.4): a rainy day with good
waves must not be learned as "bad waves". The surfer can say so with the optional tap "Was the
weather the problem?" (ratings.weather_problem); this job adds what the weather stations
actually measured, so training and later checks don't rely on the tap or the forecast alone.

For every rating without weather_measured, surfed more than DELAY_H ago (station data arrives
~1 h late) and less than --days (10) days ago, from the spot's Meteocat XEMA stations
(spots.wind_station / spots.weather_station; Generalitat open-data portal, dataset nzvn-apee,
no key, readings every 30 min, times UTC):
  session window = surfed_at - 1 h .. surfed_at + 1 h
  rain_mm         precipitation in the session window          (weather station, var 35)
  rain_24h_mm     precipitation in the 24 h before surfed_at   (weather station, var 35)
  temp_c, humidity_pct, sun_wm2   means in the window          (vars 32, 33, 36)
  wind_kmh, wind_dir              vector mean in the window    (wind station, vars 30 m/s, 31)
  gust_kmh                        strongest gust in the window (wind station, var 50)
plus the station codes, how many readings were used, and when it was measured. A value the
station doesn't measure is null. No readings at all yet = tried again next hour (until --days).

  python -m jobs.rating_weather             # write
  python -m jobs.rating_weather --dry-run   # print, write nothing
  python -m jobs.rating_weather --days 400  # backfill older ratings (stations keep years)
Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Standard library only.
Station data: Servei Meteorològic de Catalunya (Meteocat), open data. Never shown publicly.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any

from jobs import log
from jobs.check_connections import ROOT, env, load_dotenv
from jobs.collect_forecast import Supabase, http

JOB = "rating_weather"
UTC = timezone.utc
Row = dict[str, Any]
XEMA_URL = "https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json"
DELAY_H = 2
WINDOW_H = 1      # session = surfed_at +- 1 h
RAIN_BACK_H = 24
WIND_CODES = ("30", "31", "50")
WEATHER_CODES = ("32", "33", "35", "36")


def ts(s: str) -> datetime:
    s = s.replace("Z", "+00:00")
    t = datetime.fromisoformat(s)
    return (t if t.tzinfo else t.replace(tzinfo=UTC)).astimezone(UTC)


def readings(station: str, codes: tuple[str, ...], start: datetime, end: datetime) -> list[tuple[str, datetime, float]]:
    """(variable code, reading time UTC, value) for readings in [start, end)."""
    if not station or not station.isalnum():  # also keeps the query safe
        return []
    where = (f"codi_estacio='{station}' AND codi_variable in({','.join(repr(c) for c in codes)}) AND "
             f"data_lectura >= '{start:%Y-%m-%dT%H:%M:%S}' AND data_lectura < '{end:%Y-%m-%dT%H:%M:%S}'")
    q = {"$select": "codi_variable,data_lectura,valor_lectura", "$where": where,
         "$order": "data_lectura", "$limit": 5000}
    out = []
    for r in http(f"{XEMA_URL}?{urllib.parse.urlencode(q)}") or []:
        try:
            out.append((r["codi_variable"], ts(r["data_lectura"]), float(r["valor_lectura"])))
        except (KeyError, TypeError, ValueError):
            continue  # a malformed reading is skipped, not fatal
    return out


def _mean(vals: list[float]) -> float | None:
    return round(sum(vals) / len(vals), 1) if vals else None


def summarise(surfed_at: datetime, wind_rows: list, weather_rows: list, wind_station: str | None,
              weather_station: str | None, now: datetime) -> Row:
    lo, hi = surfed_at - timedelta(hours=WINDOW_H), surfed_at + timedelta(hours=WINDOW_H)
    win = lambda rows, code: [(t, v) for c, t, v in rows if c == code and lo <= t < hi]  # noqa: E731

    rain_session = [v for _, v in win(weather_rows, "35")]
    rain_day = [v for c, t, v in weather_rows if c == "35" and surfed_at - timedelta(hours=RAIN_BACK_H) <= t < surfed_at]
    speeds = dict(win(wind_rows, "30"))
    dirs = dict(win(wind_rows, "31"))
    pairs = [(speeds[t], dirs[t]) for t in speeds if t in dirs]
    wind_kmh = wind_dir = None
    if pairs:  # vector mean: 350° and 10° average to 0°, not 180°
        u = sum(s * math.sin(math.radians(d)) for s, d in pairs) / len(pairs)
        v = sum(s * math.cos(math.radians(d)) for s, d in pairs) / len(pairs)
        wind_kmh = round(sum(s for s, _ in pairs) / len(pairs) * 3.6, 1)
        wind_dir = round(math.degrees(math.atan2(u, v)) % 360)
    gusts = [v for _, v in win(wind_rows, "50")]
    return {
        "source": "meteocat_xema",
        "wind_station": wind_station, "weather_station": weather_station,
        "window": [lo.strftime("%Y-%m-%dT%H:%MZ"), hi.strftime("%Y-%m-%dT%H:%MZ")],
        "rain_mm": round(sum(rain_session), 1) if rain_session else None,
        "rain_24h_mm": round(sum(rain_day), 1) if len(rain_day) >= RAIN_BACK_H else None,
        "temp_c": _mean([v for _, v in win(weather_rows, "32")]),
        "humidity_pct": _mean([v for _, v in win(weather_rows, "33")]),
        "sun_wm2": _mean([v for _, v in win(weather_rows, "36")]),
        "wind_kmh": wind_kmh, "wind_dir": wind_dir,
        "gust_kmh": round(max(gusts) * 3.6, 1) if gusts else None,
        "readings": len([1 for _, t, _ in wind_rows + weather_rows if lo <= t < hi]),
        "measured_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def measure(rating: Row, spot: Row, now: datetime) -> Row | None:
    """The summary for one rating, or None if the stations have nothing for it (yet)."""
    surfed = ts(rating["surfed_at"])
    end = surfed + timedelta(hours=WINDOW_H)
    wind_st, weather_st = spot.get("wind_station"), spot.get("weather_station")
    weather_rows = readings(weather_st, WEATHER_CODES, surfed - timedelta(hours=RAIN_BACK_H), end) if weather_st else []
    wind_rows = readings(wind_st, WIND_CODES, surfed - timedelta(hours=WINDOW_H), end) if wind_st else []
    out = summarise(surfed, wind_rows, weather_rows, wind_st, weather_st, now)
    return out if out["readings"] else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="print, write nothing")
    ap.add_argument("--days", type=int, default=10, help="look back this many days (default 10)")
    ap.add_argument("--spot", help="only this spot id")
    args, _ = ap.parse_known_args()  # also run from jobs.collect with its flags
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    load_dotenv(ROOT / ".env")
    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        log.fail(JOB, "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (.env or GitHub secrets)")
        return 1
    db = Supabase(url, key)
    now = datetime.now(UTC).replace(microsecond=0)
    print(f"[{JOB}] {now:%Y-%m-%dT%H:%M:%SZ}{' (dry run)' if args.dry_run else ''}")

    try:
        spots = {s["id"]: s for s in http(f"{db.base}/spots?select=id,wind_station,weather_station", db.headers)}
    except Exception as exc:
        if "wind_station" in str(exc):
            log.warn(JOB, "spots has no wind_station/weather_station columns (apply migration "
                          "20261125000019_rating_weather.sql); nothing done")
            return 0
        raise
    q = {"select": "id,spot_id,surfed_at", "weather_measured": "is.null", "order": "surfed_at"}
    qs = urllib.parse.urlencode(q)
    qs += f"&surfed_at=lt.{urllib.parse.quote((now - timedelta(hours=DELAY_H)).isoformat())}"
    qs += f"&surfed_at=gt.{urllib.parse.quote((now - timedelta(days=args.days)).isoformat())}"
    if args.spot:
        qs += f"&spot_id=eq.{urllib.parse.quote(args.spot)}"
    todo = http(f"{db.base}/ratings?{qs}", db.headers) or []

    done = waiting = failed = 0
    for r in todo:
        spot = spots.get(r["spot_id"]) or {}
        if not (spot.get("wind_station") or spot.get("weather_station")):
            continue  # no stations configured for this spot
        try:
            m = measure(r, spot, now)
        except Exception as exc:  # one rating (or a station outage) must not stop the others
            failed += 1
            log.warn(JOB, f"rating {r['id']} ({r['spot_id']}): {type(exc).__name__}: {exc}")
            continue
        if m is None:
            waiting += 1
            continue
        if args.dry_run:
            print(f"        rating {r['id']} {r['spot_id']} {r['surfed_at'][:16]}: {json.dumps(m)}")
        else:
            http(f"{db.base}/ratings?id=eq.{int(r['id'])}", {**db.headers, "Prefer": "return=minimal"},
                 method="PATCH", body={"weather_measured": m})
        done += 1
    msg = (f"{done} ratings {'would get' if args.dry_run else 'got'} measured weather, "
           f"{waiting} waiting for station data, {failed} failed, of {len(todo)} without it")
    (log.warn if failed else log.ok)(JOB, msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
