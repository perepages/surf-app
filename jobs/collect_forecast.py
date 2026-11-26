"""Hourly: store the Open-Meteo forecast for every active spot in Supabase `forecasts`.

For each spot in the `spots` table (active = true) this fetches
  - Open-Meteo Marine (best_match): waves, primary + secondary swell, wind waves, swell peak
    period, sea surface temperature, sea level (tide + surge, if available)
  - Open-Meteo Marine (ncep_gfswave016): the full GFS-Wave partition set incl. the TERTIARY
    swell, stored apart in the gfs_* columns (never mixed with best_match's trains)
  - Open-Meteo Forecast: wind speed, direction and gusts at 10 m, precipitation,
    precipitation probability, weather code, CAPE, air temperature
and writes one row per (spot, fetched_at, valid_at) for valid_at = the fetch hour .. +96 h.

The same requests (with 14 past days, is_day and daily sunrise/sunset added) also make the web
app's forecast files, so the app never calls Open-Meteo itself (migration 20):
  forecast-files/spots/<id>.json  every field the app uses, 14 days back .. 5 days ahead
  forecast-files/index.json       all active spots, 72 h back .. 36 h ahead (home screen)
  spot_sun_times                  sunrise/sunset per local day
The web app reads the files through web/api/forecast.ts (cached by Vercel's CDN).

  fetched_at = the UTC hour the job ran in (minutes cut off), so lead_hours (a generated
               column = valid_at - fetched_at) is a whole number: 0, 1, 3, 24, 72 ...
               That is what lets training compare forecasts made 1, 3, 24 and 72 h ahead.
  valid_at   = the UTC hour the row predicts.

Thinning: after storing, runs fetched more than 14 days ago keep only leads 0, 1, 2, 3, 6, 12,
24, 48, 72, 96 h (all spots; --no-thin skips it, --dry-run only counts). See KEEP_LEADS.
Pruning: rows older than 90 days are deleted except the hours training reads around each
rating (migration 21; skipped with --no-thin too).

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
import atexit
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
DAY_VARS = {"is_day": "is_day"}                                # 1 day / 0 night -> boolean
BOOL_COLUMNS = {"is_day"}
SMALLINT_COLUMNS = {c for c in [*WAVE_VARS.values(), *GFS_VARS.values(), "wind_direction"]
                    if c.endswith("direction")}
INT_COLUMNS = {"precipitation_probability", "weather_code"}

# Longest lead time stored. 72 h is the longest comparison we need; 96 h covers the
# 4 days the app shows, so later AI predictions have a forecast for every hour on screen.
MAX_LEAD_HOURS = 96
# Days start at 00:00 UTC, so at 23:00 UTC four days would reach only ~73 h ahead.
FORECAST_DAYS = 5
# Past days in the same requests (one call per API, not two): the app's file shows the last 14
# days (chart, "yesterday" ratings). Only hours from the fetch hour on become `forecasts` rows.
FILE_PAST_DAYS = 14

HTTP_TIMEOUT_S = 30
ATTEMPTS = 3  # per request; waits 2 s, then 4 s, on network errors / 429 / 5xx
UPSERT_BATCH = 500
# Thinning (keeps the database inside the free 500 MB): runs fetched more than KEEP_ALL_DAYS ago
# keep only these leads. ~97 -> 10 rows per run, ~200 -> ~20 MB per spot per year. Lead 0 stays,
# so training still finds the best forecast for every past hour (and the historical rows from
# import_past, which are lead 0); the other leads keep "how accuracy drops further ahead".
KEEP_ALL_DAYS = 14
KEEP_LEADS = (0, 1, 2, 3, 6, 12, 24, 48, 72, 96)
# Older than this: deleted, except the rows training reads (hours around each rating).
# Training never reads anything else, so this doesn't change the AI.
PRUNE_DAYS = 90


# ---------- HTTP ----------

class HttpError(Exception):
    def __init__(self, code: int, body: str) -> None:
        super().__init__(f"HTTP {code}: {body[:200]}")
        self.code = code


# ---------- Open-Meteo usage counter (for /admin, migration 24) ----------
# Every job asks Open-Meteo through http() below, so counting here covers them all. Weight =
# Open-Meteo's published rule (open-meteo.com/en/pricing): one call per 10 variables x 2 weeks
# x 1 location (x models), counted fractionally, never less than 1. Added to api_calls when the
# job ends. Open-Meteo's free limit (10,000/day) is per IP address; our runs come from changing
# GitHub machines, so this total is a worst case.

_OM_USAGE = {"calls": 0.0, "requests": 0}


def open_meteo_weight(url: str) -> float:
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    one = lambda k: (q.get(k) or [""])[0]  # noqa: E731
    variables = sum(len([v for v in one(k).split(",") if v])
                    for k in ("hourly", "daily", "current", "minutely_15"))
    if one("start_date") and one("end_date"):
        days = (datetime.fromisoformat(one("end_date")) - datetime.fromisoformat(one("start_date"))).days + 1
    elif one("forecast_hours") or one("past_hours"):
        days = (int(one("forecast_hours") or 0) + int(one("past_hours") or 0)) / 24
    else:
        days = int(one("forecast_days") or 7) + int(one("past_days") or 0)
    locations = len(one("latitude").split(",")) if one("latitude") else 1
    models = len(one("models").split(",")) if one("models") else 1
    return max(1.0, variables / 10) * max(1.0, days / 14) * locations * models


def _count_open_meteo(url: str) -> None:
    if "open-meteo.com" not in urllib.parse.urlsplit(url).netloc:
        return
    try:
        weight = open_meteo_weight(url)
    except (ValueError, TypeError):
        weight = 1.0
    if _OM_USAGE["requests"] == 0:
        atexit.register(_flush_open_meteo)
    _OM_USAGE["calls"] += weight
    _OM_USAGE["requests"] += 1


def _flush_open_meteo() -> None:
    """Adds this job's Open-Meteo calls to today's api_calls row. Never fails the job."""
    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key and _OM_USAGE["requests"]):
        return
    base = url.strip().rstrip("/")
    base = base if base.startswith("http") else "https://" + base
    try:
        http(f"{base}/rest/v1/rpc/log_api_calls", supabase_headers(key), method="POST",
             body={"p_service": "open-meteo", "p_calls": round(_OM_USAGE["calls"], 2),
                   "p_requests": _OM_USAGE["requests"]})
    except Exception as exc:  # e.g. migration 24 not applied yet
        print(f"(Open-Meteo usage not recorded: {type(exc).__name__}: {str(exc)[:120]})")
    _OM_USAGE.update(calls=0.0, requests=0)


def http(url: str, headers: dict[str, str] | None = None, method: str = "GET",
         body: Any = None) -> Any:
    """Send a request, retrying transient failures; return decoded JSON (None if empty).

    `body` bytes are sent as they are (set Content-Type in `headers`); anything else as JSON.
    Open-Meteo requests are counted for /admin (see _count_open_meteo).
    """
    _count_open_meteo(url)
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
        self.storage = f"{url}/storage/v1"
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

    def upsert_sun_times(self, rows: list[dict[str, Any]]) -> None:
        if rows:
            http(f"{self.base}/spot_sun_times?on_conflict=spot_id,day",
                 {**self.headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
                 method="POST", body=rows)

    def put_file(self, bucket: str, path: str, data: Any) -> None:
        """Upload (or replace) a JSON file in a private bucket."""
        body = json.dumps(data, separators=(",", ":"), allow_nan=False).encode()
        headers = {**self.headers, "Content-Type": "application/json", "x-upsert": "true",
                   "cache-control": "no-cache"}
        http(f"{self.storage}/object/{bucket}/{urllib.parse.quote(path)}", headers,
             method="POST", body=body)

    def get_file(self, bucket: str, path: str) -> Any:
        """A JSON file from a private bucket, or None if it doesn't exist."""
        try:
            return http(f"{self.storage}/object/{bucket}/{urllib.parse.quote(path)}", self.headers)
        except HttpError as exc:
            if exc.code in (400, 404):  # storage answers 400 "not_found" for a missing object
                return None
            raise


def missing_column(exc: Exception, column: str) -> bool:
    """PostgREST's answer when a migration hasn't been applied yet (PGRST204 / 42703)."""
    text = str(exc)
    return isinstance(exc, HttpError) and column in text and (
        "PGRST204" in text or "42703" in text or "Could not find" in text)


def missing_table(exc: Exception) -> bool:
    text = str(exc)
    return isinstance(exc, HttpError) and ("PGRST205" in text or "42P01" in text)


# ---------- Open-Meteo ----------

def utc_key(unix: int) -> str:
    """Open-Meteo unix time -> the 'YYYY-MM-DDTHH:MM' (UTC) key used for every hour here."""
    return datetime.fromtimestamp(unix, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M")


def fetch_om(url: str, spot: dict[str, Any], variables: list[str], model: str,
             past_days: int = 0, daily: str | None = None) -> tuple[dict[str, dict], dict[str, Any]]:
    """Return ({'YYYY-MM-DDTHH:MM' (UTC): {open_meteo_var: value}}, whole response).

    timezone=auto: days (past_days, daily sun times) start at the spot's local midnight; times
    still come back as UTC unix seconds (timeformat=unixtime)."""
    params: dict[str, Any] = {
        "latitude": spot["lat"],
        "longitude": spot["lon"],
        "hourly": ",".join(variables),
        "models": model,
        "timezone": "auto",
        "timeformat": "unixtime",
        "forecast_days": FORECAST_DAYS,
    }
    if past_days:
        params["past_days"] = past_days
    if daily:
        params["daily"] = daily
    body = http(f"{url}?{urllib.parse.urlencode(params)}")
    hourly = body["hourly"]
    times = hourly["time"]
    hours = {
        utc_key(t): {v: (hourly.get(v) or [None] * len(times))[i] for v in variables}
        for i, t in enumerate(times)
    }
    return hours, body


def fetch_hourly(url: str, spot: dict[str, Any], variables: list[str], model: str,
                 past_days: int = 0) -> dict[str, dict]:
    return fetch_om(url, spot, variables, model, past_days)[0]


def fetch_marine(spot: dict[str, Any]) -> tuple[dict[str, dict], dict[str, str]]:
    """Marine values per hour (incl. FILE_PAST_DAYS of past hours, for the app's file) + which
    model produced each hour's waves."""
    wave_vars, sea_vars = list(WAVE_VARS), list(SEA_VARS)
    try:
        primary = fetch_hourly(MARINE_URL, spot, wave_vars + sea_vars, DEFAULT_MODEL, FILE_PAST_DAYS)
    except HttpError as exc:
        if exc.code != 400:
            raise
        # Sea level / temperature are "if available": if Open-Meteo rejects them, keep the waves.
        log.warn(JOB, f"[{spot['id']}] marine API refused sea level/temperature ({exc}); "
                      "continuing without them")
        primary = fetch_hourly(MARINE_URL, spot, wave_vars, DEFAULT_MODEL, FILE_PAST_DAYS)

    models = {t: DEFAULT_MODEL for t in primary}
    gaps = [t for t, row in primary.items() if any(row.get(v) is None for v in CORE_WAVE_VARS)]
    if not gaps:
        return primary, models

    log.info(f"[{spot['id']}] {DEFAULT_MODEL} has nulls in {len(gaps)} hours, "
             f"retrying with {FALLBACK_MARINE_MODEL}")
    fallback = fetch_hourly(MARINE_URL, spot, wave_vars, FALLBACK_MARINE_MODEL, FILE_PAST_DAYS)
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


def fetch_wind(spot: dict[str, Any]) -> tuple[dict[str, dict], dict[str, Any]]:
    """Wind + weather + day/night + daily sun times in one request (same API and model)."""
    return fetch_om(WEATHER_URL, spot, list(WIND_VARS) + list(WEATHER_VARS) + list(DAY_VARS),
                    DEFAULT_MODEL, FILE_PAST_DAYS, daily="sunrise,sunset")


def fetch_gfs_partitions(spot: dict[str, Any]) -> dict[str, dict]:
    return fetch_hourly(MARINE_URL, spot, list(GFS_VARS), GFS_PARTITION_MODEL)


# ---------- rows ----------

def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def column_value(column: str, value: Any) -> Any:
    if value is None:
        return None
    if column in BOOL_COLUMNS:
        return bool(value)
    if column in SMALLINT_COLUMNS:
        return int(round(value)) % 360
    if column in INT_COLUMNS:
        return int(round(value))
    return float(value)


def fetch_spot(spot: dict[str, Any]) -> dict[str, Any]:
    """Every Open-Meteo request for one spot (3-4 calls). The result feeds the `forecasts` rows,
    the sun times and the app's forecast file, so nothing is asked twice."""
    marine, models = fetch_marine(spot)
    try:
        wind, weather_body = fetch_wind(spot)
    except Exception as exc:
        # Waves are the core; an hour with waves but no wind beats losing the hour.
        log.warn(JOB, f"[{spot['id']}] wind request failed ({type(exc).__name__}: {exc}); "
                      "storing waves with empty wind")
        wind, weather_body = {}, {}
    try:
        gfs = fetch_gfs_partitions(spot)
    except Exception as exc:
        log.warn(JOB, f"[{spot['id']}] {GFS_PARTITION_MODEL} partitions failed "
                      f"({type(exc).__name__}: {exc}); storing without the gfs_* columns")
        gfs = {}
    return {
        "marine": marine, "models": models, "wind": wind, "gfs": gfs,
        "timezone": weather_body.get("timezone") or spot.get("timezone") or "UTC",
        "daily": weather_body.get("daily") or {},
        "utc_offset_seconds": weather_body.get("utc_offset_seconds") or 0,
        "fetched_now": datetime.now(timezone.utc),
    }


def build_rows(spot: dict[str, Any], fetched_at: datetime,
               data: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    data = data or fetch_spot(spot)
    marine, models, wind, gfs = data["marine"], data["models"], data["wind"], data["gfs"]
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
                               (DAY_VARS, wind.get(api_time, {})),
                               (GFS_VARS, gfs.get(api_time, {}))):
            for om_name, column in source.items():
                row[column] = column_value(column, values.get(om_name))
        rows.append(row)
    return rows


def sun_rows(spot: dict[str, Any], data: dict[str, Any]) -> list[dict[str, Any]]:
    """spot_sun_times rows: one per local day Open-Meteo gave sun times for."""
    daily, offset = data["daily"], data.get("utc_offset_seconds", 0)
    out = []
    for i, day in enumerate(daily.get("time") or []):
        rise = (daily.get("sunrise") or [None] * (i + 1))[i]
        sets = (daily.get("sunset") or [None] * (i + 1))[i]
        out.append({"spot_id": spot["id"], "day": local_date(day, offset),
                    "sunrise": iso_unix(rise), "sunset": iso_unix(sets)})
    return out


def local_date(unix_midnight: int, offset_s: int) -> str:
    """Local date of a day that starts at `unix_midnight` (local midnight, UTC unix seconds).
    +6 h keeps it right across a daylight-saving change, where today's offset is 1 h off."""
    return datetime.fromtimestamp(unix_midnight + offset_s + 6 * 3600, tz=timezone.utc).strftime("%Y-%m-%d")


def iso_unix(unix: int | None) -> str | None:
    return None if unix is None else iso(datetime.fromtimestamp(unix, tz=timezone.utc))


# ---------- the app's forecast files ----------
# One JSON per spot (`spots/<id>.json`: FILE_PAST_DAYS back to the last forecast day, every
# field the app uses) and one for the home screen (`index.json`: every active spot, the hours
# around now). Columns of numbers instead of one object per hour: ~4x smaller.
# Field names = web/src/lib/forecast.ts HourConditions; change both together (FILE_VERSION).

FILE_VERSION = 1
BUCKET_FILES = "forecast-files"
# app field -> (source, Open-Meteo name, decimals)
FILE_FIELDS: dict[str, tuple[str, str, int]] = {
    "waveHeight": ("marine", "wave_height", 2),
    "wavePeriod": ("marine", "wave_period", 2),
    "waveDirection": ("marine", "wave_direction", 0),
    "swellHeight": ("marine", "swell_wave_height", 2),
    "swellPeriod": ("marine", "swell_wave_period", 2),
    "swellDirection": ("marine", "swell_wave_direction", 0),
    "secondarySwellHeight": ("marine", "secondary_swell_wave_height", 2),
    "secondarySwellPeriod": ("marine", "secondary_swell_wave_period", 2),
    "secondarySwellDirection": ("marine", "secondary_swell_wave_direction", 0),
    "windWaveHeight": ("marine", "wind_wave_height", 2),
    "windWavePeriod": ("marine", "wind_wave_period", 2),
    "windWaveDirection": ("marine", "wind_wave_direction", 0),
    "tide": ("marine", "sea_level_height_msl", 3),
    "seaTemp": ("marine", "sea_surface_temperature", 1),
    "windSpeed": ("wind", "wind_speed_10m", 1),
    "windDirection": ("wind", "wind_direction_10m", 0),
    "windGusts": ("wind", "wind_gusts_10m", 1),
    "isDay": ("wind", "is_day", 0),
    "precipitation": ("wind", "precipitation", 2),
    "precipProb": ("wind", "precipitation_probability", 0),
    "weatherCode": ("wind", "weather_code", 0),
    "cape": ("wind", "cape", 0),
    "airTemp": ("wind", "temperature_2m", 1),
}
# Home screen: wind/rain history for the score (72 h) and enough ahead that a file a few hours
# old still has "now" + the next 4 hours.
INDEX_PAST_H = 72
INDEX_AHEAD_H = 36


def rounded(value: Any, decimals: int) -> Any:
    if value is None:
        return None
    return int(round(value)) if decimals == 0 else round(float(value), decimals)


def build_file(spot: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    keys = sorted(data["marine"])
    if not keys:
        raise ValueError("Open-Meteo returned no hours")
    unix = [int(datetime.strptime(k, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc).timestamp())
            for k in keys]
    if any(b - a != 3600 for a, b in zip(unix, unix[1:])):
        raise ValueError("Open-Meteo hours are not continuous")
    sources = {"marine": data["marine"], "wind": data["wind"]}
    hourly = {field: [rounded(sources[src].get(k, {}).get(name), dec) for k in keys]
              for field, (src, name, dec) in FILE_FIELDS.items()}
    used = set(data["models"].values())
    daily = data["daily"]
    return {
        "v": FILE_VERSION,
        "spotId": spot["id"],
        "fetchedAt": iso(data["fetched_now"].replace(microsecond=0)),
        "timezone": data["timezone"],
        "marineModel": "+".join(m for m in (DEFAULT_MODEL, FALLBACK_MARINE_MODEL) if m in used),
        "start": unix[0],
        "hours": len(unix),
        "hourly": hourly,
        "daily": {
            "date": [local_date(d, data.get("utc_offset_seconds", 0)) for d in daily.get("time") or []],
            "sunrise": list(daily.get("sunrise") or []),
            "sunset": list(daily.get("sunset") or []),
        },
    }


def slice_file(f: dict[str, Any], start: int, end: int) -> dict[str, Any] | None:
    """The hours of a spot file with start <= time < end (for index.json)."""
    a = max(0, (start - f["start"]) // 3600)
    b = min(f["hours"], max(0, -(-(end - f["start"]) // 3600)))
    if a >= b:
        return None
    return {
        "fetchedAt": f["fetchedAt"], "timezone": f["timezone"], "marineModel": f["marineModel"],
        "start": f["start"] + a * 3600, "hours": b - a,
        "hourly": {k: v[a:b] for k, v in f["hourly"].items()},
    }


def build_index(files: dict[str, dict[str, Any]], now: datetime) -> dict[str, Any]:
    hour = int(now.replace(minute=0, second=0, microsecond=0).timestamp())
    spots = {}
    for spot_id, f in sorted(files.items()):
        part = slice_file(f, hour - INDEX_PAST_H * 3600, hour + (INDEX_AHEAD_H + 1) * 3600)
        if part:
            spots[spot_id] = part
    fetched = [p["fetchedAt"] for p in spots.values()]
    return {"v": FILE_VERSION, "fetchedAt": min(fetched) if fetched else iso(now), "spots": spots}


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
    files: dict[str, dict[str, Any]] = {}
    no_is_day = no_sun_table = False
    for spot in spots:
        sid = spot["id"]
        try:
            data = fetch_spot(spot)
        except Exception as exc:  # one bad spot must not stop the others
            failed.append(sid)
            log.fail(JOB, f"[{sid}] {type(exc).__name__}: {exc}")
            continue

        # 1. The app's file (what visitors see), first.
        try:
            f = build_file(spot, data)
            size = len(json.dumps(f, separators=(",", ":")))
            if not args.dry_run:
                db.put_file(BUCKET_FILES, f"spots/{sid}.json", f)
            files[sid] = f
            log.ok(JOB, f"[{sid}] {'would publish' if args.dry_run else 'published'} "
                        f"spots/{sid}.json: {f['hours']} hours, {size // 1024} KB")
        except Exception as exc:
            failed.append(sid)
            log.fail(JOB, f"[{sid}] forecast file: {type(exc).__name__}: {exc}")

        # 2. Sun times (needs migration 20; until then: one warning, skipped).
        if not args.dry_run and not no_sun_table:
            try:
                db.upsert_sun_times(sun_rows(spot, data))
            except Exception as exc:
                if missing_table(exc):
                    no_sun_table = True
                    log.warn(JOB, "spot_sun_times missing: apply migration 20 (forecast_files)")
                else:
                    log.warn(JOB, f"[{sid}] sun times: {type(exc).__name__}: {exc}")

        # 3. Forecast rows for training (lead 0..96 h).
        try:
            rows = build_rows(spot, fetched_at, data)
            if no_is_day:
                for r in rows:
                    r.pop("is_day", None)
            if args.show:
                print(json.dumps(rows[:args.show], indent=2))
            if not args.dry_run:
                try:
                    db.upsert_forecasts(rows)
                except Exception as exc:
                    if not missing_column(exc, "is_day"):
                        raise
                    no_is_day = True
                    log.warn(JOB, "forecasts.is_day missing: apply migration 20 (forecast_files); "
                                  "storing without it")
                    for r in rows:
                        r.pop("is_day", None)
                    db.upsert_forecasts(rows)
            log.ok(JOB, f"[{sid}] {'would store' if args.dry_run else 'stored'} {summary(rows)}")
        except Exception as exc:
            if sid not in failed:
                failed.append(sid)
            log.fail(JOB, f"[{sid}] {type(exc).__name__}: {exc}")

    # 4. index.json for the home screen. A spot whose fetch failed this hour keeps the hours of
    # its last published file, so it doesn't vanish from the list.
    try:
        for spot in spots:
            if spot["id"] not in files and not args.dry_run:
                old = db.get_file(BUCKET_FILES, f"spots/{spot['id']}.json")
                if old and old.get("v") == FILE_VERSION:
                    files[spot["id"]] = old
        index = build_index(files, datetime.now(timezone.utc))
        size = len(json.dumps(index, separators=(",", ":")))
        if not args.dry_run:
            db.put_file(BUCKET_FILES, "index.json", index)
        log.ok(JOB, f"{'would publish' if args.dry_run else 'published'} index.json: "
                    f"{len(index['spots'])} spots, {size // 1024} KB")
    except Exception as exc:
        failed.append("index.json")
        log.fail(JOB, f"index.json: {type(exc).__name__}: {exc}")

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

        # Older than PRUNE_DAYS: deleted, except the hours around ratings that training reads
        # (migration 21, prune_old_forecasts). Same rule: a failure only warns.
        try:
            fn = "count_old_forecasts" if args.dry_run else "prune_old_forecasts"
            n = http(f"{db.base}/rpc/{fn}", db.headers, method="POST", body={"p_days": PRUNE_DAYS})
            log.ok(JOB, f"pruning: {'would delete' if args.dry_run else 'deleted'} {n} rows older than "
                        f"{PRUNE_DAYS} days (kept the 73 h before / 1 h after each rating)")
        except Exception as exc:
            if isinstance(exc, HttpError) and ("PGRST202" in str(exc) or exc.code == 404):
                log.warn(JOB, "prune_old_forecasts missing: apply migration 21 (prune_old_forecasts)")
            else:
                log.warn(JOB, f"pruning failed ({type(exc).__name__}: {exc}); retried next run")

    if failed:
        print(f"[{JOB}] failed spots: {', '.join(failed)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
