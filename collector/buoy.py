"""Fetch real buoy measurements from Puertos del Estado (PORTUS) into SQLite.

PORTUS has no documented public API. This uses the JSON API that the PORTUS
map (https://portus.puertos.es) calls itself:
  POST lastData/station/{id}  -> latest reading; tells us which parameter ids exist
  POST RTData/station/{id}    -> recent hourly series (~48 h) for those ids
Timestamps ('fecha') are GMT/UTC: the PORTUS site labels them "GMT".

The API is unofficial and may change. If it breaks, only this file needs fixing
(the official alternative is the Puertos del Estado THREDDS/OPeNDAP server).

RULE: buoy data is for training only. Never redistribute it (API or UI).

Run once:  python -m collector.buoy
"""

import json
import logging
import sqlite3
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from collector.forecast import to_iso, utc_now
from collector.paths import DB_PATH

log = logging.getLogger(__name__)

PORTUS_API = "https://portus.puertos.es/portussvr/api/"
HTTP_TIMEOUT_S = 30


@dataclass(frozen=True)
class Buoy:
    id: int
    name: str
    lat: float
    lon: float


# Chosen for Vilanova i la Geltrú (distance from the spot in the comment).
BUOYS: list[Buoy] = [
    Buoy(1731, "Barcelona II (coastal)", 41.32, 2.20),      # ~42 km NE, waves only
    Buoy(2720, "Tarragona (offshore)", 40.69, 1.47),        # ~62 km S, waves + wind
]

# PORTUS 'paramEseoo' code -> our column name. Values are divided by 'factor'.
PARAM_COLUMNS: dict[str, str] = {
    "Hm0": "hm0_m",               # significant wave height
    "Hmax": "hmax_m",             # maximum wave height
    "Tp": "tp_s",                 # peak period
    "Tm02": "tm02_s",             # mean period
    "MeanDir": "mean_dir_deg",    # mean wave direction (coming from)
    "MeanDirPeak": "peak_dir_deg",  # peak wave direction (coming from)
    "WindSpeed": "wind_speed_ms",  # m/s
    "WindDir": "wind_dir_deg",    # coming from
}

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS buoy_obs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    buoy_id      INTEGER NOT NULL,
    observed_at  TEXT    NOT NULL,  -- UTC, time of the measurement
    fetched_at   TEXT    NOT NULL,  -- UTC, when we downloaded it
    {", ".join(f"{c} REAL" for c in PARAM_COLUMNS.values())},
    UNIQUE (buoy_id, observed_at)
);
"""


# ---------- HTTP ----------

def post_json(path: str, body: Any) -> Any:
    """POST a JSON body to the PORTUS API and decode the JSON response."""
    req = urllib.request.Request(
        PORTUS_API + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
        return json.load(resp)


def fetch_param_ids(buoy: Buoy) -> list[int]:
    """Ids of the parameters this buoy reports that we want to store."""
    latest = post_json(f"lastData/station/{buoy.id}?locale=es", ["WAVE", "WIND"])
    return [d["id"] for d in latest.get("datos", []) if d.get("paramEseoo") in PARAM_COLUMNS]


def fetch_series(buoy: Buoy, param_ids: list[int]) -> list[dict[str, Any]]:
    """Recent hourly series: [{'fecha': ..., 'datos': [...]}, ...]."""
    return post_json(f"RTData/station/{buoy.id}?locale=es", param_ids)


# ---------- shaping ----------

def parse_portus_time(value: str) -> datetime:
    """'2026-11-20 19:00:00.0' (GMT) -> aware UTC datetime."""
    return datetime.strptime(value[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def scale(item: dict[str, Any]) -> float | None:
    """PORTUS sends integers as strings plus a factor: '67' / 100 -> 0.67."""
    raw = item.get("valor")
    if raw in (None, "") or item.get("averia"):
        return None
    return round(float(raw) / (item.get("factor") or 1.0), 3)


def entry_to_row(buoy: Buoy, entry: dict[str, Any], fetched_at: datetime) -> dict[str, Any]:
    """One PORTUS series entry -> one buoy_obs row."""
    row: dict[str, Any] = {c: None for c in PARAM_COLUMNS.values()}
    for item in entry.get("datos", []):
        column = PARAM_COLUMNS.get(item.get("paramEseoo"))
        if column:
            row[column] = scale(item)
    row.update(
        buoy_id=buoy.id,
        observed_at=to_iso(parse_portus_time(entry["fecha"])),
        fetched_at=to_iso(fetched_at),
    )
    return row


def build_rows(buoy: Buoy, fetched_at: datetime) -> list[dict[str, Any]]:
    """Fetch and shape all recent observations for one buoy."""
    param_ids = fetch_param_ids(buoy)
    if not param_ids:
        return []
    return [entry_to_row(buoy, e, fetched_at) for e in fetch_series(buoy, param_ids)]


# ---------- database ----------

def connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    """Open the DB and make sure the buoy table exists."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    return conn


def save_rows(conn: sqlite3.Connection, rows: list[dict[str, Any]]) -> int:
    """Insert rows; an hour already stored for that buoy is kept as is."""
    if not rows:
        return 0
    columns = list(rows[0].keys())
    sql = (
        f"INSERT OR IGNORE INTO buoy_obs ({', '.join(columns)}) "
        f"VALUES ({', '.join(':' + c for c in columns)})"
    )
    before = conn.total_changes
    with conn:
        conn.executemany(sql, rows)
    return conn.total_changes - before


# ---------- entry point ----------

def collect_all() -> int:
    """Fetch and store recent observations for every buoy. Returns rows added.

    One failing buoy is logged and skipped; if every buoy fails, raise so the
    run is recorded as an error.
    """
    fetched_at = utc_now()
    total, failures = 0, []
    conn = connect()
    try:
        for buoy in BUOYS:
            try:
                rows = build_rows(buoy, fetched_at)
            except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as exc:
                log.warning("[buoy %s] PORTUS fetch failed: %s", buoy.id, exc)
                failures.append(f"{buoy.id}: {exc}")
                continue
            inserted = save_rows(conn, rows)
            latest = max((r["observed_at"] for r in rows), default="-")
            log.info("[buoy %s %s] %d obs received, %d new, latest %s",
                     buoy.id, buoy.name, len(rows), inserted, latest)
            total += inserted
    finally:
        conn.close()
    if failures and len(failures) == len(BUOYS):
        raise RuntimeError("all buoys failed: " + "; ".join(failures))
    return total


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    collect_all()
