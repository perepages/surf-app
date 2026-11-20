"""Print the forecast rows from the most recent fetch as a table.

Usage:  python -m collector.show_forecasts [limit]
"""

import sqlite3
import sys

from collector.paths import DB_PATH

COLUMNS = [
    "forecast_time", "lead_hours", "marine_model",
    "wave_height", "wave_period", "wave_direction",
    "swell_wave_height", "swell_wave_period", "swell_wave_direction",
    "wind_wave_height", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "sea_level_height_msl",
]
HEADERS = [
    "forecast_time", "lead", "model",
    "wave_h", "wave_p", "wave_dir",
    "swell_h", "swell_p", "swell_dir",
    "windwave_h", "wind_kmh", "wind_dir", "gust_kmh", "tide_m",
]


def latest_rows(conn: sqlite3.Connection, limit: int) -> tuple[str, list[tuple]]:
    """Return the latest fetched_at and its first `limit` rows."""
    fetched_at = conn.execute("SELECT MAX(fetched_at) FROM forecasts WHERE source = 'open_meteo'").fetchone()[0]
    rows = conn.execute(
        f"SELECT {', '.join(COLUMNS)} FROM forecasts WHERE fetched_at = ? "
        "ORDER BY spot, forecast_time LIMIT ?",
        (fetched_at, limit),
    ).fetchall()
    return fetched_at, rows


def fmt(value: object) -> str:
    return "-" if value is None else str(value)


def main() -> None:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 24
    with sqlite3.connect(DB_PATH) as conn:
        total = conn.execute("SELECT COUNT(*) FROM forecasts").fetchone()[0]
        fetched_at, rows = latest_rows(conn, limit)
    print(f"{total} rows in {DB_PATH.name}; showing {len(rows)} from fetched_at={fetched_at}\n")
    widths = [max(len(h), *(len(fmt(r[i])) for r in rows)) for i, h in enumerate(HEADERS)]
    print("  ".join(h.ljust(w) for h, w in zip(HEADERS, widths)))
    for r in rows:
        print("  ".join(fmt(v).ljust(w) for v, w in zip(r, widths)))


if __name__ == "__main__":
    main()
