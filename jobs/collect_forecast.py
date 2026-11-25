"""Hourly: store the Open-Meteo forecast for every active spot in Supabase `forecasts`.

For each spot in the `spots` table (active = true) this fetches
  - Open-Meteo Marine (best_match): waves, primary + secondary swell, wind waves, swell peak
    period, sea surface temperature, sea level (tide + surge, if available)
  - Open-Meteo Marine (ncep_gfswave016): the full GFS-Wave partition set incl. the TERTIARY
    swell, stored apart in the gfs_* columns (never mixed with best_match's trains)
  - Open-Meteo Forecast: wind speed, direction and gusts at 10 m, precipitation,
    precipitation probability, weather code, CAPE, air temperature
and writes one row per (spot, fetched_at, valid_at) for valid_at = the fetch hour .. +96 h.

  fetched_at = the UTC hour the job ran in (minutes cut off), so lead_hours (a generated
               column = valid_at - fetched_at) is a whole number: 0, 1, 3, 24, 72 ...
               That is what lets training compare forecasts made 1, 3, 24 and 72 h ahead.
  valid_at   = the UTC hour the row predicts.

Thinning: after storing, runs fetched more than 14 days ago keep only leads 0, 1, 2, 3, 6, 12,
24, 48, 72, 96 h (all spots; --no-thin skips it, --dry-run only counts). See KEEP_LEADS.

No duplicates: the table is unique on (spot_id, fetched_at, valid_at) and rows are upserted,
so running twice in the same hour overwrites that hour's rows with the newer numbers instead
of adding copies.

Nulls: if the default marine model (best_match) returns nulls for an hour, the marine part of
that hour is taken from ncep_gfswave025 instead; `marine_model` records which one was used.
Sea level and sea temperature only exist in the default model, so they are never replaced
(null stays null). If the GFS partition request or the wind/weather request fails, those
columns stay empty for the run (warning); the waves are still stored.

Run from the repo root (reads .env locally, GitHub secrets in Actions):
  python -m jobs.collect_forecast             # fetch + write to Supabase
  python -m jobs.collect_forecast --dry-run   # fetch only, print what would be written
Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (only the spot list is read in --dry-run).
Exit code 1 if any spot failed (the other spots are still stored).
Standard library only (works on Python 3.10+).

Weather data by Open-Meteo.com (non-commercial use).
"""
from __future__ import annotations

import argparse
from http.client import HTTPException
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

from jobs import log
from jobs.check_connections import ROOT, env, load_dotenv, supabase_headers

JOB = "collect_forecast"

MARINE_URL = "https://marine-api.open-meteo.com/v1/marine"
WEATHER_URL = "https://api.open-meteo.com/v1/forecast"

DEFAULT_MODEL = "best_match"
FALLBACK_MARINE_MODEL = "ncep_gfswave025"

GFS_PARTITION_MODEL = "ncep_gfswave016"

# Open-Meteo name -> forecasts column. Wave vars go through the null fallback.
# CORE_WAVE_VARS decide whether an hour needs the fallback (a null in an extra one, e.g. peak
# period, doesn't); when it is used, ALL wave vars of that hour come from the fallback model.
CORE_WAVE_VARS = ["wave_height", "wave_period", "wave_direction", "swell_wave_height",
                  "swell_wave_period", "swell_wave_direction", "wind_wave_height"]
WAVE_VARS = {v: v for v in CORE_WAVE_VARS + [
    "swell_wave_peak_period",
    "secondary_swell_wave_height", "secondary_swell_wave_period",
    "secondary_swell_wave_direction",
    "wind_wave_period", "wind_wave_direction",
]}
SEA_VARS = {  # best_match only, never replaced by the fallback
    "sea_level_height_msl": "sea_level_height",            # m, includes storm surge
    "sea_surface_temperature": "sea_surface_temperature",  # deg C
}
TIDE_VARS = SEA_VARS  # old name
GFS_VARS = {f"{p}_wave_{q}": f"gfs_{p}_wave_{q}"
            for p in ("swell", "secondary_swell", "tertiary_swell", "wind")
            for q in ("height", "period", "direction")}
WIND_VARS = {
    "wind_speed_10m": "wind_speed",          # km/h (Open-Meteo default)
    "wind_direction_10m": "wind_direction",  # degrees, where the wind comes from
    "wind_gusts_10m": "wind_gusts",          # km/h
}
WEATHER_VARS = {
    "precipitation": "precipitation",                          # mm in the preceding hour
    "precipitation_probability": "precipitation_probability",  # %
    "weather_code": "weather_code",                            # WMO code, 95/96/99 = thunder
    "cape": "cape",                                            # J/kg
    "temperature_2m": "temperature_2m",                        # deg C
}
SMALLINT_COLUMNS = {c for c in [*WAVE_VARS.values(), *GFS_VARS.values(), "wind_direction"]
                    if c.endswith("direction")}
INT_COLUMNS = {"precipitation_probability", "weather_code"}

# Longest lead time stored. 72 h is the longest comparison we need; 96 h covers the
# 4 days the app shows, so later AI predictions have a forecast for every hour on screen.
MAX_LEAD_HOURS = 96
# Days start at 00:00 UTC, so at 23:00 UTC four days would reach only ~73 h ahead.
FORECAST_DAYS = 5

HTTP_TIMEOUT_S = 30
ATTEMPTS = 3  # per request; waits 2 s, then 4 s, on network errors / 429 / 5xx
UPSERT_BATCH = 500
# Thinning (keeps the database inside the free 500 MB): runs fetched more than KEEP_ALL_DAYS ago
# keep only these leads. ~97 -> 10 rows per run, ~200 -> ~20 MB per spot per year. Lead 0 stays,
# so training still finds the best forecast for every past hour (and the historical rows from
# import_past, which are lead 0); the other leads keep "how accuracy drops further ahead".
KEEP_ALL_DAYS = 14
KEEP_LEADS = (0, 1, 2, 3, 6, 12, 24, 48, 72, 96)


# ---------- HTTP ----------

class HttpError(Exception):
    def __init__(self, code: int, body: str) -> None:
        super().__init__(f"HTTP {code}: {body[:200]}")
        self.code = code


def http(url: str, headers: dict[str, str] | None = None, method: str = "GET",
         body: Any = None) -> Any:
    """Send a request, retrying transient failures; return decoded JSON (None if empty).

    `body` bytes are sent as they are (set Content-Type in `headers`); anything else as JSON.
    """
    headers = dict(headers or {})
    if isinstance(body, bytes):
        data = body
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    else:
        data = None
    for attempt in range(1, ATTEMPTS + 1):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
                text = resp.read().decode("utf-8")
                return json.loads(text) if text.strip() else None
        except urllib.error.HTTPError as exc:
            error: Exception = HttpError(exc.code, exc.read().decode("utf-8", "replace"))
            if exc.code != 429 and exc.code < 500:
                raise error from None  # 4xx: retrying won't help
        except (OSError, HTTPException) as exc:  # timeouts, resets, DNS
            error = exc
        if attempt < ATTEMPTS:
            time.sleep(2 ** attempt)
    raise error


# ---------- Supabase ----------

class Supabase:
    def __init__(self, url: str, key: str) -> None:
        url = url.strip().rstrip("/")
        if not url.startswith("http"):
            url = "https://" + url
        self.base = f"{url}/rest/v1"
        self.headers = supabase_headers(key)

    def active_spots(self) -> list[dict[str, Any]]:
        query = urllib.parse.urlencode({"select": "id,lat,lon", "active": "eq.true", "order": "id"})
        return http(f"{self.base}/spots?{query}", self.headers)

    def thin_old_runs(self, older_than: datetime, delete: bool) -> int:
        """Delete (or with delete=False only count) rows fetched before `older_than` whose lead
        isn't in KEEP_LEADS, for every spot. Returns the number of rows."""
        query = urllib.parse.urlencode({
            "fetched_at": f"lt.{iso(older_than)}",
            "lead_hours": f"not.in.({','.join(map(str, KEEP_LEADS))})",
        })
        method = "DELETE" if delete else "HEAD"
        headers = {**self.headers, "Prefer": "count=exact,return=minimal"}
        for attempt in range(1, ATTEMPTS + 1):
            try:
                req = urllib.request.Request(f"{self.base}/forecasts?{query}", headers=headers, method=method)
                with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S * 4) as resp:
                    total = (resp.headers.get("Content-Range") or "*/0").rsplit("/", 1)[-1]
                    return int(total) if total.isdigit() else 0
            except urllib.error.HTTPError as exc:
                error: Exception = HttpError(exc.code, exc.read().decode("utf-8", "replace"))
                if exc.code != 429 and exc.code < 500:
                    raise error from None
            except (OSError, HTTPException) as exc:
                error = exc
            if attempt < ATTEMPTS:
                time.sleep(2 ** attempt)
        raise error

    def upsert_forecasts(self, rows: list[dict[str, Any]]) -> None:
        url = f"{self.base}/forecasts?on_conflict=spot_id,fetched_at,valid_at"
        headers = {**self.headers, "Prefer": "resolution=merge-duplicates,return=minimal"}
        for i in range(0, len(rows), UPSERT_BATCH):
            http(url, headers, method="POST", body=rows[i:i + UPSERT_BATCH])


# ---------- Open-Meteo ----------

def fetch_hourly(url: str, spot: dict[str, Any], variables: list[str], model: str) -> dict[str, dict]:
    """Return {'YYYY-MM-DDTHH:MM' (UTC): {open_meteo_var: value}}."""
    params = {
        "latitude": spot["lat"],
        "longitude": spot["lon"],
        "hourly": ",".join(variables),
        "models": model,
        "timezone": "UTC",
        "forecast_days": FORECAST_DAYS,
    }
    hourly = http(f"{url}?{urllib.parse.urlencode(params)}")["hourly"]
    times = hourly["time"]
    return {
        t: {v: (hourly.get(v) or [None] * len(times))[i] for v in variables}
        for i, t in enumerate(times)
    }


def fetch_marine(spot: dict[str, Any]) -> tuple[dict[str, dict], dict[str, str]]:
    """Marine values per hour + which model produced each hour's waves."""
    wave_vars, sea_vars = list(WAVE_VARS), list(SEA_VARS)
    try:
        primary = fetch_hourly(MARINE_URL, spot, wave_vars + sea_vars, DEFAULT_MODEL)
    except HttpError as exc:
        if exc.code != 400:
            raise
        # Sea level / temperature are "if available": if Open-Meteo rejects them, keep the waves.
        log.warn(JOB, f"[{spot['id']}] marine API refused sea level/temperature ({exc}); "
                      "continuing without them")
        primary = fetch_hourly(MARINE_URL, spot, wave_vars, DEFAULT_MODEL)

    models = {t: DEFAULT_MODEL for t in primary}
    gaps = [t for t, row in primary.items() if any(row.get(v) is None for v in CORE_WAVE_VARS)]
    if not gaps:
        return primary, models

    log.info(f"[{spot['id']}] {DEFAULT_MODEL} has nulls in {len(gaps)} hours, "
             f"retrying with {FALLBACK_MARINE_MODEL}")
    fallback = fetch_hourly(MARINE_URL, spot, wave_vars, FALLBACK_MARINE_MODEL)
    for t in gaps:
        alt = fallback.get(t)
        if alt is None:
            continue
        nulls_now = sum(primary[t].get(v) is None for v in CORE_WAVE_VARS)
        nulls_alt = sum(alt[v] is None for v in CORE_WAVE_VARS)
        if nulls_alt < nulls_now:
            # Whole wave set from one model, so a row never mixes two models' waves.
            primary[t].update(alt)
            models[t] = FALLBACK_MARINE_MODEL
    return primary, models


def fetch_wind(spot: dict[str, Any]) -> dict[str, dict]:
    """Wind + weather in one request (same API and model)."""
    return fetch_hourly(WEATHER_URL, spot, list(WIND_VARS) + list(WEATHER_VARS), DEFAULT_MODEL)


def fetch_gfs_partitions(spot: dict[str, Any]) -> dict[str, dict]:
    return fetch_hourly(MARINE_URL, spot, list(GFS_VARS), GFS_PARTITION_MODEL)


# ---------- rows ----------

def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def column_value(column: str, value: Any) -> Any:
    if value is None:
        return None
    if column in SMALLINT_COLUMNS:
        return int(round(value)) % 360
    if column in INT_COLUMNS:
        return int(round(value))
    return float(value)


def build_rows(spot: dict[str, Any], fetched_at: datetime) -> list[dict[str, Any]]:
    marine, models = fetch_marine(spot)
    try:
        wind = fetch_wind(spot)
    except Exception as exc:
        # Waves are the core; an hour with waves but no wind beats losing the hour.
        log.warn(JOB, f"[{spot['id']}] wind request failed ({type(exc).__name__}: {exc}); "
                      "storing waves with empty wind")
        wind = {}
    try:
        gfs = fetch_gfs_partitions(spot)
    except Exception as exc:
        log.warn(JOB, f"[{spot['id']}] {GFS_PARTITION_MODEL} partitions failed "
                      f"({type(exc).__name__}: {exc}); storing without the gfs_* columns")
        gfs = {}
    last = fetched_at + timedelta(hours=MAX_LEAD_HOURS)
    rows = []
    for api_time in sorted(marine):
        valid_at = datetime.strptime(api_time, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
        if not fetched_at <= valid_at <= last:
            continue  # past hours aren't forecasts; beyond 96 h isn't needed
        row: dict[str, Any] = {
            "spot_id": spot["id"],
            "fetched_at": iso(fetched_at),
            "valid_at": iso(valid_at),
            "marine_model": models[api_time],
        }
        # Every row gets every column (PostgREST bulk upserts need identical keys).
        for source, values in ((WAVE_VARS, marine[api_time]), (SEA_VARS, marine[api_time]),
                               (WIND_VARS, wind.get(api_time, {})),
                               (WEATHER_VARS, wind.get(api_time, {})),
                               (GFS_VARS, gfs.get(api_time, {}))):
            for om_name, column in source.items():
                row[column] = column_value(column, values.get(om_name))
        rows.append(row)
    return rows


def summary(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return "0 rows"
    def count_null(col: str) -> int:
        return sum(r[col] is None for r in rows)
    fallback = sum(r["marine_model"] != DEFAULT_MODEL for r in rows)
    return (f"{len(rows)} rows, valid {rows[0]['valid_at']} .. {rows[-1]['valid_at']}; "
            f"{fallback} hours from {FALLBACK_MARINE_MODEL}; nulls: wave_height "
            f"{count_null('wave_height')}, secondary {count_null('secondary_swell_wave_height')}, "
            f"gfs_tertiary {count_null('gfs_tertiary_swell_wave_height')}, "
            f"wind_speed {count_null('wind_speed')}, rain {count_null('precipitation')}, "
            f"sea_level {count_null('sea_level_height')}, "
            f"sst {count_null('sea_surface_temperature')}")


# ---------- entry point ----------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true",
                        help="fetch and print, don't write to Supabase")
    parser.add_argument("--show", type=int, default=0, metavar="N",
                        help="print the first N rows of each spot as JSON")
    parser.add_argument("--no-thin", action="store_true",
                        help=f"don't thin runs older than {KEEP_ALL_DAYS} days")
    args, _ = parser.parse_known_args()  # also run from jobs.collect with its flags

    load_dotenv(ROOT / ".env")
    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        log.fail(JOB, "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (.env or GitHub secrets)")
        return 1
    db = Supabase(url, key)

    fetched_at = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    print(f"[{JOB}] fetched_at={iso(fetched_at)}{' (dry run)' if args.dry_run else ''}")
    spots = db.active_spots()
    if not spots:
        log.fail(JOB, "No active spots in the spots table.")
        return 1

    failed = []
    for spot in spots:
        try:
            rows = build_rows(spot, fetched_at)
            if args.show:
                print(json.dumps(rows[:args.show], indent=2))
            if not args.dry_run:
                db.upsert_forecasts(rows)
            log.ok(JOB, f"[{spot['id']}] {'would store' if args.dry_run else 'stored'} {summary(rows)}")
        except Exception as exc:  # one bad spot must not stop the others
            failed.append(spot["id"])
            log.fail(JOB, f"[{spot['id']}] {type(exc).__name__}: {exc}")

    # Thin old runs. A failure here only warns: this hour's forecast is already stored, and the
    # next hour tries again.
    if not args.no_thin:
        cutoff = fetched_at - timedelta(days=KEEP_ALL_DAYS)
        try:
            n = db.thin_old_runs(cutoff, delete=not args.dry_run)
            log.ok(JOB, f"thinning: {'would delete' if args.dry_run else 'deleted'} {n} rows of runs "
                        f"before {iso(cutoff)} (kept leads {', '.join(map(str, KEEP_LEADS))} h)")
        except Exception as exc:
            log.warn(JOB, f"thinning old runs failed ({type(exc).__name__}: {exc}); retried next hour")

    if failed:
        print(f"[{JOB}] failed spots: {', '.join(failed)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
