"""Fetch hourly wave + wind forecasts from Open-Meteo and store them in SQLite.

Every run stores one row per (spot, fetch time, predicted time). Keeping the fetch
time next to the predicted time lets us later compare forecasts made 1, 3, 24
and 72 hours ahead against what really happened.

Weather data by Open-Meteo.com (non-commercial use).

Run once:  python -m collector.forecast
"""

import json
import logging
import sqlite3
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from collector.paths import DB_PATH  # data lives outside OneDrive, see paths.py
from collector.spots import SPOTS, Spot

log = logging.getLogger(__name__)

MARINE_URL = "https://marine-api.open-meteo.com/v1/marine"
WEATHER_URL = "https://api.open-meteo.com/v1/forecast"

MARINE_VARS = [
    "wave_height",
    "wave_period",
    "wave_direction",
    "swell_wave_height",
    "swell_wave_period",
    "swell_wave_direction",
    "wind_wave_height",
]
WIND_VARS = ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"]
# Sea level incl. tides and storm surge, metres relative to mean sea level.
# Only the default model has it (GFS wave returns nulls), so it is fetched on its
# own and never goes through the marine fallback.
TIDE_VARS = ["sea_level_height_msl"]

DEFAULT_MODEL = "best_match"
FALLBACK_MARINE_MODEL = "ncep_gfswave025"

# 4 days covers the longest lead time we care about (72 h) plus margin.
FORECAST_DAYS = 4
HTTP_TIMEOUT_S = 30

# Where a forecast row came from:
#   open_meteo             live hourly collector (this file)
#   open_meteo_historical  Open-Meteo Historical Forecast API, filled in afterwards
#   saved_by_me            numbers copied from my own screenshots of other forecast apps
SOURCE_LIVE = "open_meteo"

FORECASTS_TABLE = f"""
CREATE TABLE IF NOT EXISTS forecasts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    spot             TEXT    NOT NULL,
    source           TEXT    NOT NULL DEFAULT '{SOURCE_LIVE}',
    fetched_at       TEXT,              -- UTC, when the forecast was made/seen (NULL = unknown)
    forecast_time    TEXT    NOT NULL,  -- UTC, the hour this row predicts
    lead_hours       INTEGER,           -- forecast_time minus fetched_at hour (NULL = unknown)
    marine_model     TEXT    NOT NULL,  -- model or provider (e.g. best_match, surfline)
    {", ".join(f"{v} REAL" for v in MARINE_VARS)},
    {", ".join(f"{v} REAL" for v in WIND_VARS)},
    {", ".join(f"{v} REAL" for v in TIDE_VARS)},
    note             TEXT,
    UNIQUE (spot, source, fetched_at, forecast_time)
)"""
SCHEMA = f"""
{FORECASTS_TABLE};
CREATE INDEX IF NOT EXISTS idx_forecasts_lookup
    ON forecasts (spot, forecast_time, lead_hours);
"""


# ---------- time helpers ----------

def utc_now() -> datetime:
    """Current time in UTC, truncated to whole seconds."""
    return datetime.now(timezone.utc).replace(microsecond=0)


def to_iso(dt: datetime) -> str:
    """Format a UTC datetime as 'YYYY-MM-DDTHH:MM:SSZ'."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_api_time(value: str) -> datetime:
    """Open-Meteo returns 'YYYY-MM-DDTHH:MM' in the requested timezone (UTC here)."""
    return datetime.strptime(value, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)


# ---------- HTTP ----------

def get_json(url: str, params: dict[str, Any]) -> dict[str, Any]:
    """GET a URL with query params and decode the JSON body."""
    full_url = f"{url}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(full_url, timeout=HTTP_TIMEOUT_S) as resp:
        return json.load(resp)


def fetch_hourly(url: str, spot: Spot, variables: list[str], model: str) -> dict[str, list]:
    """Fetch the 'hourly' block for a spot; returns {'time': [...], var: [...]}."""
    params = {
        "latitude": spot.lat,
        "longitude": spot.lon,
        "hourly": ",".join(variables),
        "timezone": "UTC",
        "forecast_days": FORECAST_DAYS,
        "models": model,
    }
    return get_json(url, params)["hourly"]


# ---------- shaping ----------

def hourly_to_rows(hourly: dict[str, list], variables: list[str]) -> dict[str, dict[str, Any]]:
    """Turn column arrays into {api_time: {var: value}}."""
    return {
        t: {v: hourly.get(v, [None] * len(hourly["time"]))[i] for v in variables}
        for i, t in enumerate(hourly["time"])
    }


def has_nulls(row: dict[str, Any]) -> bool:
    return any(value is None for value in row.values())


def fetch_marine(spot: Spot) -> dict[str, tuple[str, dict[str, Any]]]:
    """Marine rows keyed by time, each tagged with the model that produced it.

    If the default model returns nulls for any hour, fetch the GFS wave model
    and use its row for those hours instead.
    """
    primary = hourly_to_rows(fetch_hourly(MARINE_URL, spot, MARINE_VARS, DEFAULT_MODEL), MARINE_VARS)
    result = {t: (DEFAULT_MODEL, row) for t, row in primary.items()}

    if not any(has_nulls(row) for row in primary.values()):
        return result

    log.info("[%s] default marine model returned nulls, retrying with %s", spot.slug, FALLBACK_MARINE_MODEL)
    fallback = hourly_to_rows(
        fetch_hourly(MARINE_URL, spot, MARINE_VARS, FALLBACK_MARINE_MODEL), MARINE_VARS
    )
    for t, row in primary.items():
        if has_nulls(row) and t in fallback:
            result[t] = (FALLBACK_MARINE_MODEL, fallback[t])
    return result


def fetch_wind(spot: Spot) -> dict[str, dict[str, Any]]:
    """Wind rows keyed by time."""
    return hourly_to_rows(fetch_hourly(WEATHER_URL, spot, WIND_VARS, DEFAULT_MODEL), WIND_VARS)


def fetch_tide(spot: Spot) -> dict[str, dict[str, Any]]:
    """Sea-level (tide) rows keyed by time, from the default marine model."""
    return hourly_to_rows(fetch_hourly(MARINE_URL, spot, TIDE_VARS, DEFAULT_MODEL), TIDE_VARS)


def build_rows(spot: Spot, fetched_at: datetime) -> list[dict[str, Any]]:
    """Merge marine + wind + tide into DB rows, keeping only hours at or after the fetch hour."""
    marine = fetch_marine(spot)
    wind = fetch_wind(spot)
    tide = fetch_tide(spot)
    fetch_hour = fetched_at.replace(minute=0, second=0)

    rows = []
    for api_time, (model, marine_row) in sorted(marine.items()):
        forecast_time = parse_api_time(api_time)
        lead = forecast_time - fetch_hour
        if lead < timedelta(0):
            continue  # past hours of today are not forecasts
        rows.append(
            {
                "spot": spot.slug,
                "fetched_at": to_iso(fetched_at),
                "forecast_time": to_iso(forecast_time),
                "lead_hours": int(lead.total_seconds() // 3600),
                "marine_model": model,
                **marine_row,
                **wind.get(api_time, {v: None for v in WIND_VARS}),
                **tide.get(api_time, {v: None for v in TIDE_VARS}),
            }
        )
    return rows


# ---------- database ----------

def connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    """Open the DB and make sure the schema exists."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    upgrade_old_table(conn)
    conn.executescript(SCHEMA)
    return conn


def upgrade_old_table(conn: sqlite3.Connection) -> None:
    """Bring a forecasts table from an older version up to the current schema.

    v1 lacked the tide column; v2 lacked source/note and required fetched_at and
    lead_hours. SQLite can't relax NOT NULL in place, so v2 tables are rebuilt:
    copy rows into a new table (existing rows get source = 'open_meteo').
    """
    existing = {row[1] for row in conn.execute("PRAGMA table_info(forecasts)")}
    if not existing or "source" in existing:
        return
    for column in TIDE_VARS:
        if column not in existing:
            conn.execute(f"ALTER TABLE forecasts ADD COLUMN {column} REAL")
    old_columns = [row[1] for row in conn.execute("PRAGMA table_info(forecasts)")]
    with conn:
        conn.execute("DROP INDEX IF EXISTS idx_forecasts_lookup")
        conn.execute("ALTER TABLE forecasts RENAME TO forecasts_old")
        conn.execute(FORECASTS_TABLE)
        cols = ", ".join(old_columns)
        conn.execute(f"INSERT INTO forecasts ({cols}) SELECT {cols} FROM forecasts_old")
        conn.execute("DROP TABLE forecasts_old")
    log.info("upgraded forecasts table (added source/note, %d rows kept)",
             conn.execute("SELECT COUNT(*) FROM forecasts").fetchone()[0])


def save_rows(conn: sqlite3.Connection, rows: list[dict[str, Any]]) -> int:
    """Insert rows; duplicates (same spot/fetch/predicted time) are ignored."""
    if not rows:
        return 0
    columns = list(rows[0].keys())
    sql = (
        f"INSERT OR IGNORE INTO forecasts ({', '.join(columns)}) "
        f"VALUES ({', '.join(':' + c for c in columns)})"
    )
    with conn:
        cursor = conn.executemany(sql, rows)
    return cursor.rowcount


# ---------- entry point ----------

def already_fetched_this_hour(conn: sqlite3.Connection, spot: Spot, fetched_at: datetime) -> bool:
    """True if this spot already has a forecast fetched in the same UTC hour.

    One forecast vintage per hour is enough; a second run in the same hour would
    only add near-identical rows with the same lead_hours (duplicates for analysis).
    """
    hour_start = to_iso(fetched_at.replace(minute=0, second=0))
    row = conn.execute(
        "SELECT 1 FROM forecasts WHERE spot = ? AND source = ? AND fetched_at >= ? LIMIT 1",
        (spot.slug, SOURCE_LIVE, hour_start),
    ).fetchone()
    return row is not None


def collect_all() -> int:
    """Fetch and store forecasts (waves, wind, tide) for every collected spot. Returns rows added."""
    fetched_at = utc_now()
    total = 0
    conn = connect()
    try:
        for spot in (s for s in SPOTS if s.collect):
            if already_fetched_this_hour(conn, spot, fetched_at):
                log.info("[%s] forecast already fetched this hour, skipping", spot.slug)
                continue
            inserted = save_rows(conn, build_rows(spot, fetched_at))
            log.info("[%s] fetched_at=%s stored %d hourly rows", spot.slug, to_iso(fetched_at), inserted)
            total += inserted
    finally:
        conn.close()
    return total


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    collect_all()
