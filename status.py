"""Print how much data has been collected and when the collectors last ran OK.

Usage:  python status.py
All times are shown in UTC.
"""

import sqlite3
from pathlib import Path

from collector.forecast import connect
from collector.paths import DB_PATH, SNAPSHOT_DIR

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}

# (label, table, extra WHERE, time column for "latest")
COUNTS: list[tuple[str, str, str, str]] = [
    ("Forecast rows, live", "forecasts", "source = 'open_meteo'", "fetched_at"),
    ("Tide rows, live", "forecasts", "source = 'open_meteo' AND sea_level_height_msl IS NOT NULL", "fetched_at"),
    ("Forecast rows, past (Open-Meteo)", "forecasts", "source = 'open_meteo_historical'", "forecast_time"),
    ("Forecast rows, saved by me", "forecasts", "source = 'saved_by_me'", "forecast_time"),
    ("Buoy observations", "buoy_obs", "", "observed_at"),
    ("Ratings", "ratings", "", "observed_at"),
]


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()
    return row is not None


def count_and_latest(conn: sqlite3.Connection, table: str, where: str, time_col: str) -> tuple[int, str | None]:
    """Row count and latest timestamp; (0, None) if the table doesn't exist yet."""
    if not table_exists(conn, table):
        return 0, None
    clause = f"WHERE {where}" if where else ""
    return conn.execute(f"SELECT COUNT(*), MAX({time_col}) FROM {table} {clause}").fetchone()


def print_details(conn: sqlite3.Connection, table: str) -> None:
    """Indented sub-lines under a table's total (fetch count, per-buoy counts)."""
    if table == "forecasts":
        fetches = conn.execute(
            "SELECT COUNT(DISTINCT fetched_at) FROM forecasts WHERE source = 'open_meteo'").fetchone()[0]
        print(f"  {'  live forecast fetches':30} {fetches:>7}")
    if table == "ratings" and table_exists(conn, table):
        for source, count in conn.execute("SELECT source, COUNT(*) FROM ratings GROUP BY source ORDER BY source"):
            print(f"  {'  ' + source:30} {count:>7}")
    if table == "buoy_obs" and table_exists(conn, table):
        for buoy_id, count, latest in conn.execute(
            "SELECT buoy_id, COUNT(*), MAX(observed_at) FROM buoy_obs GROUP BY buoy_id ORDER BY buoy_id"
        ):
            print(f"  {'  buoy ' + str(buoy_id):30} {count:>7}   latest {latest}")


def print_counts(conn: sqlite3.Connection) -> None:
    print("Data")
    for label, table, where, time_col in COUNTS:
        count, latest = count_and_latest(conn, table, where, time_col)
        print(f"  {label:30} {count:>7}   latest {latest or '-'}")
        if label in ("Forecast rows, live", "Buoy observations", "Ratings"):
            print_details(conn, table)
    snapshots = [p for p in SNAPSHOT_DIR.rglob("*") if p.suffix.lower() in IMAGE_SUFFIXES]
    print(f"  {'Cam snapshots (files)':30} {len(snapshots):>7}")


def print_runs(conn: sqlite3.Connection) -> None:
    print("\nCollector runs (python -m collector.run_all)")
    if not table_exists(conn, "collector_runs"):
        print("  no runs recorded yet")
        return
    last_ok = conn.execute(
        "SELECT MAX(run_started) FROM collector_runs WHERE run_started NOT IN "
        "(SELECT run_started FROM collector_runs WHERE status = 'error')"
    ).fetchone()[0]
    total = conn.execute("SELECT COUNT(DISTINCT run_started) FROM collector_runs").fetchone()[0]
    print(f"  Last successful run (no step failed): {last_ok or 'never'}   ({total} runs total)")
    for step, ok, err, status in conn.execute(
        """
        SELECT step,
               MAX(CASE WHEN status = 'ok' THEN finished_at END),
               MAX(CASE WHEN status = 'error' THEN finished_at END),
               (SELECT status FROM collector_runs r2 WHERE r2.step = r.step ORDER BY id DESC LIMIT 1)
        FROM collector_runs r GROUP BY step ORDER BY MIN(id)
        """
    ):
        print(f"  {step:10} last status {status:8} last ok {ok or '-':22} last error {err or '-'}")


def main() -> None:
    if not DB_PATH.exists():
        print(f"No database yet at {DB_PATH}. Run: python -m collector.run_all")
        return
    with connect() as conn:  # also upgrades an older forecasts table
        print(f"Database: {DB_PATH}  (times in UTC)\n")
        print_counts(conn)
        print_runs(conn)


if __name__ == "__main__":
    main()
