"""Import my past sessions (my_old_data/) with forecast + reality + my rating.

For each session this stores:
  1. ratings    : my rating (source 'past_session', or 'reported' if I didn't surf)
  2. forecasts  : numbers I saved from other apps' screenshots (source 'saved_by_me')
  3. forecasts  : what Open-Meteo's models said that day, from the Historical
                  Forecast API + Marine API (source 'open_meteo_historical')
  4. buoy_obs   : NOT possible automatically. PORTUS only serves the last ~48 h;
                  older buoy data needs a manual data request on portus.puertos.es.

Idempotent: re-running replaces this script's rows instead of duplicating them.
Values below were read by eye from the screenshots in my_old_data/.

Run:  python -m collector.import_past
Weather data by Open-Meteo.com
"""

import json
import logging
import sqlite3
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

from collector.forecast import MARINE_URL, MARINE_VARS, TIDE_VARS, WIND_VARS, connect, to_iso, utc_now
from collector.spots import Spot, get_spot

log = logging.getLogger(__name__)

HISTORICAL_WEATHER_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
HTTP_TIMEOUT_S = 60
MS_TO_KMH = 3.6
COMPASS = {"N": 0, "NNE": 22.5, "NE": 45, "ENE": 67.5, "E": 90, "ESE": 112.5, "SE": 135, "SSE": 157.5,
           "S": 180, "SSW": 202.5, "SW": 225, "WSW": 247.5, "W": 270, "WNW": 292.5, "NW": 315, "NNW": 337.5}

SOURCE_SAVED = "saved_by_me"
SOURCE_HISTORICAL = "open_meteo_historical"


@dataclass
class SavedRow:
    """One forecast hour copied from a screenshot (local time; None = not shown)."""
    local: str                       # 'YYYY-MM-DD HH:MM' local time
    wave_h: float | None = None
    wave_p: float | None = None
    wave_dir: float | None = None    # degrees, coming from
    wind_kmh: float | None = None
    wind_dir: float | None = None    # degrees, coming from
    gust_kmh: float | None = None
    swell_h: float | None = None
    swell_p: float | None = None
    swell_dir: float | None = None


@dataclass
class SavedForecast:
    provider: str                    # stored in marine_model
    seen_local: str | None           # when I looked at it (local), None = unknown
    note: str
    rows: list[SavedRow]


@dataclass
class PastSession:
    spot: str
    day: str                         # local date 'YYYY-MM-DD'
    utc_offset_h: int                # Spain: +1 winter, +2 summer (from the screenshots)
    rating: int
    source: str                      # 'past_session' or 'reported'
    note: str
    start: str = "12:00"             # local, agreed window "midday and afternoon"
    end: str = "17:00"
    saved: list[SavedForecast] = field(default_factory=list)


def gfs_row(local: str, h: float, p: float, wdir: float, wind_ms: float, wind_dir: float, gust_ms: float) -> SavedRow:
    """Row from the GFS27 surf app screenshots (wind in m/s there)."""
    return SavedRow(local, wave_h=h, wave_p=p, wave_dir=wdir, wind_kmh=round(wind_ms * MS_TO_KMH, 1),
                    wind_dir=wind_dir, gust_kmh=round(gust_ms * MS_TO_KMH, 1))


def sf_row(local: str, h: float, p: float, wind_kmh: float, wind_from: str) -> SavedRow:
    """Row from the surf-forecast.com screenshot (all swell from ENE)."""
    return SavedRow(local, wave_h=h, wave_p=p, wave_dir=COMPASS["ENE"], wind_kmh=wind_kmh,
                    wind_dir=COMPASS[wind_from])


# Arrow "←" on the app = moving west = coming FROM the east (90°). "↖" = from SE, "↙" = from NE.
SESSIONS: list[PastSession] = [
    PastSession(
        spot="vilanova", day="2022-02-26", utc_offset_h=1, rating=3, source="past_session",
        note="Screenshot 'Surf Vilanova i la Geltrú'. I said '2.5 or 3', stored as 3. Date deduced from the "
             "app calendar (Sat 26, then 28 -> 01) and confirmed.",
        saved=[SavedForecast("app_gfs27", None, "Surf app, GFS27, 3-hourly; seen on the session day (time unknown)", [
            gfs_row("2022-02-26 01:00", 0.5, 4, 90, 1.4, 135, 1.3),
            gfs_row("2022-02-26 04:00", 0.5, 5, 90, 1.4, 112.5, 1.3),
            gfs_row("2022-02-26 07:00", 0.8, 5, 90, 3.7, 90, 3.6),
            gfs_row("2022-02-26 10:00", 1.3, 7, 90, 4.7, 90, 4.4),
            gfs_row("2022-02-26 13:00", 1.3, 6, 90, 6.9, 90, 6.8),
            gfs_row("2022-02-26 16:00", 1.0, 4, 90, 6.0, 90, 6.1),
            gfs_row("2022-02-26 19:00", 0.7, 4, 90, 4.2, 100, 4.8),
            gfs_row("2022-02-26 22:00", 0.7, 4, 90, 3.2, 90, 4.0),
            gfs_row("2022-02-27 01:00", 0.7, 5, 90, 3.2, 90, 3.8),
        ])],
    ),
    PastSession(
        spot="vilanova", day="2022-04-14", utc_offset_h=2, rating=3, source="past_session",
        note="Screenshot 'Surf in Vilanova. 2'. I said '2.5 or 3', stored as 3. Date deduced (Thursday 14, "
             "summer time, water 14°C) and confirmed.",
        saved=[SavedForecast("app_gfs27", None, "Surf app, GFS27, hourly; seen on the session day (time unknown)", [
            gfs_row("2022-04-14 12:00", 1.5, 6, 90, 6.2, 90, 10),
            gfs_row("2022-04-14 13:00", 1.6, 7, 90, 8.5, 90, 13),
            gfs_row("2022-04-14 14:00", 1.7, 7, 90, 11, 90, 15),
            gfs_row("2022-04-14 15:00", 1.7, 6, 90, 11, 90, 14),
            gfs_row("2022-04-14 16:00", 1.6, 5, 90, 7.8, 90, 11),
            gfs_row("2022-04-14 17:00", 1.5, 5, 90, 5.6, 90, 9.0),
            gfs_row("2022-04-14 18:00", 1.5, 5, 90, 6.4, 80, 11),
            gfs_row("2022-04-14 19:00", 1.4, 6, 90, 7.2, 70, 12),
            gfs_row("2022-04-14 20:00", 1.3, 7, 90, 6.4, 70, 11),
        ])],
    ),
    PastSession(
        spot="vilanova", day="2023-11-12", utc_offset_h=1, rating=3, source="past_session",
        note="WhatsApp photos IMG-20231112-WA0031/32 (small clean waves, ~5 surfers). I said '2.5 or 3', "
             "stored as 3. No forecast saved.",
    ),
    PastSession(
        spot="bogatell", day="2026-11-05", utc_offset_h=1, rating=4, source="reported",
        note="Not surfed by me; I know it was really good. Video VID_20261120_124605_010.mp4. "
             "Time window 12-17 assumed.",
        saved=[
            SavedForecast("surf-forecast.com", "2026-11-04 14:55",
                          "surf-forecast.com Bogatell: 'Wave Height' (primary swell), star rating 1-2/10", [
                sf_row("2026-11-05 04:00", 0.8, 8, 10, "N"),
                sf_row("2026-11-05 07:00", 1.0, 9, 0, "NNE"),
                sf_row("2026-11-05 10:00", 1.0, 9, 5, "NW"),
                sf_row("2026-11-05 13:00", 1.0, 9, 5, "WNW"),
                sf_row("2026-11-05 16:00", 1.1, 9, 10, "WSW"),
                sf_row("2026-11-05 19:00", 1.2, 9, 10, "W"),
                sf_row("2026-11-05 22:00", 1.2, 9, 10, "W"),
            ]),
            SavedForecast("surfline", "2026-11-04 15:41",
                          "Surfline LOTUS day summary: surf height 0.3-0.6 m, 'POOR TO FAIR'; "
                          "2nd swell 0.2 m 5 s from ESE 121°", [
                SavedRow("2026-11-05 18:00", swell_h=1.2, swell_p=8, swell_dir=62),
            ]),
        ],
    ),
]


# ---------- time helpers ----------

def local_to_utc(local: str, offset_h: int) -> datetime:
    """'YYYY-MM-DD HH:MM' at a fixed UTC offset -> aware UTC datetime."""
    naive = datetime.strptime(local, "%Y-%m-%d %H:%M")
    return (naive - timedelta(hours=offset_h)).replace(tzinfo=timezone.utc)


def session_window(s: PastSession) -> tuple[datetime, datetime]:
    return local_to_utc(f"{s.day} {s.start}", s.utc_offset_h), local_to_utc(f"{s.day} {s.end}", s.utc_offset_h)


# ---------- 1. ratings ----------

def ensure_ratings_table(conn: sqlite3.Connection) -> None:
    from rate import SCHEMA as RATINGS_SCHEMA  # single definition of the table
    conn.executescript(RATINGS_SCHEMA)


def store_rating(conn: sqlite3.Connection, s: PastSession) -> None:
    start, end = session_window(s)
    with conn:
        conn.execute("DELETE FROM ratings WHERE spot = ? AND source = ? AND observed_at = ?",
                     (s.spot, s.source, to_iso(start)))
        conn.execute(
            "INSERT INTO ratings (spot, observed_at, observed_until, created_at, rating, wave_size_m, crowd, "
            "note, source, snapshot_path) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)",
            (s.spot, to_iso(start), to_iso(end), to_iso(utc_now()), s.rating, s.note, s.source),
        )


# ---------- 2. saved forecasts ----------

def saved_rows(s: PastSession, f: SavedForecast) -> list[dict[str, Any]]:
    seen = local_to_utc(f.seen_local, s.utc_offset_h) if f.seen_local else None
    rows = []
    for r in f.rows:
        t = local_to_utc(r.local, s.utc_offset_h)
        lead = int((t - seen.replace(minute=0, second=0)).total_seconds() // 3600) if seen else None
        rows.append({
            "spot": s.spot, "source": SOURCE_SAVED, "fetched_at": to_iso(seen) if seen else None,
            "forecast_time": to_iso(t), "lead_hours": lead, "marine_model": f.provider,
            "wave_height": r.wave_h, "wave_period": r.wave_p, "wave_direction": r.wave_dir,
            "swell_wave_height": r.swell_h, "swell_wave_period": r.swell_p, "swell_wave_direction": r.swell_dir,
            "wind_speed_10m": r.wind_kmh, "wind_direction_10m": r.wind_dir, "wind_gusts_10m": r.gust_kmh,
            "note": f.note,
        })
    return rows


# ---------- 3. historical Open-Meteo forecast ----------

def get_json(url: str, params: dict[str, Any]) -> dict[str, Any]:
    with urllib.request.urlopen(f"{url}?{urllib.parse.urlencode(params)}", timeout=HTTP_TIMEOUT_S) as resp:
        return json.load(resp)


def fetch_historical(spot: Spot, day: date) -> list[dict[str, Any]]:
    """Hourly UTC rows for one day: waves + tide (Marine API) and wind (Historical Forecast API)."""
    common = {"latitude": spot.lat, "longitude": spot.lon, "timezone": "UTC",
              "start_date": day.isoformat(), "end_date": day.isoformat()}
    marine = get_json(MARINE_URL, {**common, "hourly": ",".join(MARINE_VARS + TIDE_VARS)})["hourly"]
    wind = get_json(HISTORICAL_WEATHER_URL, {**common, "hourly": ",".join(WIND_VARS)})["hourly"]
    wind_by_time = {t: i for i, t in enumerate(wind["time"])}
    rows = []
    for i, t in enumerate(marine["time"]):
        j = wind_by_time.get(t)
        rows.append({
            "spot": spot.slug, "source": SOURCE_HISTORICAL, "fetched_at": None,
            "forecast_time": to_iso(datetime.strptime(t, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)),
            "lead_hours": None, "marine_model": "best_match",
            **{v: marine[v][i] for v in MARINE_VARS + TIDE_VARS},
            **{v: (wind[v][j] if j is not None else None) for v in WIND_VARS},
            "note": "Open-Meteo historical: stitched from the first hours of successive model runs",
        })
    return rows


def session_days_utc(s: PastSession) -> list[date]:
    """UTC dates covering the local day of the session."""
    first = local_to_utc(f"{s.day} 00:00", s.utc_offset_h).date()
    last = local_to_utc(f"{s.day} 23:00", s.utc_offset_h).date()
    return sorted({first, last})


# ---------- storing forecasts ----------

def replace_forecasts(conn: sqlite3.Connection, spot: str, source: str, rows: list[dict[str, Any]]) -> int:
    """Delete this source's rows for the same spot + hours, then insert (keeps re-runs idempotent)."""
    if not rows:
        return 0
    with conn:
        conn.executemany("DELETE FROM forecasts WHERE spot = ? AND source = ? AND forecast_time = ? "
                         "AND marine_model = ?",
                         [(spot, source, r["forecast_time"], r["marine_model"]) for r in rows])
        columns = list(rows[0].keys())
        conn.executemany(f"INSERT INTO forecasts ({', '.join(columns)}) "
                         f"VALUES ({', '.join(':' + c for c in columns)})", rows)
    return len(rows)


# ---------- report ----------

def window_summary(conn: sqlite3.Connection, s: PastSession, source: str) -> str:
    start, end = session_window(s)
    row = conn.execute(
        "SELECT COUNT(*), ROUND(AVG(wave_height), 2), ROUND(AVG(wave_period), 1), ROUND(AVG(swell_wave_height), 2), "
        "ROUND(AVG(wind_speed_10m), 1), ROUND(MAX(wind_gusts_10m), 1), ROUND(AVG(sea_level_height_msl), 2) "
        "FROM forecasts WHERE spot = ? AND source = ? AND forecast_time BETWEEN ? AND ?",
        (s.spot, source, to_iso(start), to_iso(end)),
    ).fetchone()
    n, wh, wp, sh, ws, gust, tide = row
    if not n:
        return "none"
    return f"{n} h | wave {wh} m {wp} s | swell {sh} m | wind {ws} km/h gust {gust} | tide {tide} m"


def import_all() -> None:
    conn = connect()
    ensure_ratings_table(conn)
    try:
        for s in SESSIONS:
            spot = get_spot(s.spot)
            store_rating(conn, s)
            saved = sum(replace_forecasts(conn, s.spot, SOURCE_SAVED, saved_rows(s, f)) for f in s.saved)
            hist = 0
            for day in session_days_utc(s):
                try:
                    hist += replace_forecasts(conn, s.spot, SOURCE_HISTORICAL, fetch_historical(spot, day))
                except Exception as exc:  # noqa: BLE001 - keep importing the other sessions
                    log.warning("[%s %s] historical forecast failed: %s", s.spot, day, exc)
            start, end = session_window(s)
            print(f"\n{s.day} {spot.name}  rating {s.rating}/5 ({s.source})  window {to_iso(start)} - {to_iso(end)}")
            print(f"  saved by me    : {saved} rows -> {window_summary(conn, s, SOURCE_SAVED)}")
            print(f"  open-meteo hist: {hist} rows -> {window_summary(conn, s, SOURCE_HISTORICAL)}")
            print("  buoy (PORTUS)  : not available (older than 48 h; needs a manual PORTUS data request)")
    finally:
        conn.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    import_all()
