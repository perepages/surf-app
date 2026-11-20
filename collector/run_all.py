"""Run every collector once: forecast (waves + wind + tide), buoys, webcam.

- Each step runs on its own: if one fails, the error and traceback go to
  <data dir>/logs/collector.log and the next step still runs. The script never crashes.
- Every step's outcome is recorded in the `collector_runs` table, so
  `python status.py` can show the last successful run.
- No duplicates: each collector skips data it already has
  (forecast: one fetch per spot per UTC hour; buoy: one row per buoy per hour).

Run once (from the project root):     python -m collector.run_all
Run from anywhere (for schedulers):   <project>/.venv/Scripts/python <project>/collector/run_all.py

Hourly, Windows (Task Scheduler, at minute 10, only while logged on, no console window):
  schtasks /Create /TN "SurfApp Collector" /SC HOURLY /ST 00:10 /F
    /TR "\"<project>\\.venv\\Scripts\\pythonw.exe\" \"<project>\\collector\\run_all.py\""
  Test now: schtasks /Run /TN "SurfApp Collector"     Remove: schtasks /Delete /TN "SurfApp Collector" /F

Hourly, Linux/Mac (crontab -e):
  10 * * * * cd /path/to/surf-app && .venv/bin/python -m collector.run_all >/dev/null 2>&1
"""

import importlib
import logging
import sqlite3
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Callable

# Allow running as a plain script (python path/to/run_all.py) from any folder.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from collector.forecast import to_iso, utc_now  # noqa: E402
from collector.paths import DB_PATH, LOG_PATH  # noqa: E402

log = logging.getLogger("collector.run_all")

# (step name, module). Tides come from the forecast module (same Open-Meteo run).
STEPS: list[tuple[str, str]] = [
    ("forecast", "collector.forecast"),
    ("buoy", "collector.buoy"),
    ("cam", "collector.webcam"),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS collector_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_started TEXT    NOT NULL,  -- UTC, same value for all steps of one run
    step        TEXT    NOT NULL,
    status      TEXT    NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
    rows_added  INTEGER,
    finished_at TEXT    NOT NULL,  -- UTC
    message     TEXT
);
"""


def setup_logging() -> None:
    """Log to <data dir>/logs/collector.log (rotated, max ~5 MB total) and to the console."""
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    file_handler = RotatingFileHandler(LOG_PATH, maxBytes=1_000_000, backupCount=5, encoding="utf-8")
    console = logging.StreamHandler()
    for handler in (file_handler, console):
        handler.setFormatter(fmt)
    logging.basicConfig(level=logging.INFO, handlers=[file_handler, console], force=True)


def load_step(module_name: str) -> Callable[[], int] | None:
    """Return the module's collect_all, or None if the collector isn't written yet."""
    try:
        module = importlib.import_module(module_name)
    except ModuleNotFoundError as exc:
        if exc.name == module_name:
            return None
        raise
    return module.collect_all


def run_step(name: str, module_name: str) -> tuple[str, int | None, str | None]:
    """Run one collector; never raises. Returns (status, rows_added, message)."""
    try:
        collect = load_step(module_name)
        if collect is None:
            log.info("[%s] skipped: %s not implemented yet", name, module_name)
            return "skipped", None, "not implemented yet"
        rows = collect()
        log.info("[%s] ok, %s new rows", name, rows)
        return "ok", rows, None
    except Exception as exc:  # noqa: BLE001 - one step must never stop the others
        log.exception("[%s] failed", name)
        return "error", None, f"{type(exc).__name__}: {exc}"


def record(run_started: str, step: str, status: str, rows: int | None, message: str | None) -> None:
    """Store one step's outcome in collector_runs (logged, not raised, if the DB fails)."""
    try:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(DB_PATH) as conn:
            conn.executescript(SCHEMA)
            conn.execute(
                "INSERT INTO collector_runs (run_started, step, status, rows_added, finished_at, message) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (run_started, step, status, rows, to_iso(utc_now()), message),
            )
    except Exception:  # noqa: BLE001
        log.exception("could not record run of step %s", step)


def main() -> int:
    setup_logging()
    run_started = to_iso(utc_now())
    log.info("run started %s", run_started)
    errors = 0
    for name, module_name in STEPS:
        status, rows, message = run_step(name, module_name)
        record(run_started, name, status, rows, message)
        errors += status == "error"
    log.info("run finished: %d step(s) failed", errors)
    return 1 if errors else 0  # non-zero exit lets schedulers flag failed runs


if __name__ == "__main__":
    sys.exit(main())
