"""Rate the real surf conditions (ground truth for the forecast-correction model).

Usage:
  python rate.py                   ask for time, rating, wave size, crowd, note
  python rate.py --from-snapshot   open the latest cam snapshot first, default time = snapshot time
  python rate.py --spot vilanova   choose the spot (default: first spot)

Times are typed in this PC's local time and stored in UTC.
"""

import argparse
import os
import sqlite3
import sys
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

from collector.forecast import to_iso, utc_now
from collector.paths import DATA_DIR, DB_PATH, SNAPSHOT_DIR
from collector.spots import SPOTS

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
CROWD_LEVELS = ["empty", "few", "busy", "packed"]
TIME_FORMAT = "%Y-%m-%d %H:%M"

SCHEMA = """
CREATE TABLE IF NOT EXISTS ratings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    spot          TEXT    NOT NULL,
    observed_at   TEXT    NOT NULL,  -- UTC, when the rated conditions happened (session start)
    observed_until TEXT,             -- UTC, session end (NULL = a single moment)
    created_at    TEXT    NOT NULL,  -- UTC, when the rating was entered
    rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    wave_size_m   REAL,              -- my estimate of real wave face height (NULL = not noted)
    crowd         TEXT    CHECK (crowd IS NULL OR crowd IN ('empty', 'few', 'busy', 'packed')),
    note          TEXT,
    source        TEXT    NOT NULL,  -- 'beach' (seen in person), 'snapshot' (seen on the cam),
                                     -- 'past_session' (imported old session of mine),
                                     -- 'reported' (not surfed by me, someone else's report)
    snapshot_path TEXT               -- image rated, relative to the data folder (e.g. snapshots/x.jpg)
);
"""


# ---------- prompts ----------

def ask(prompt: str, default: str | None = None) -> str:
    """Ask once; empty input returns the default (if any)."""
    suffix = f" [{default}]" if default else ""
    answer = input(f"{prompt}{suffix}: ").strip()
    return answer if answer or default is None else default


def ask_until_valid(prompt: str, parse, default: str | None = None):
    """Repeat the question until `parse` accepts the answer (it raises ValueError otherwise)."""
    while True:
        try:
            return parse(ask(prompt, default))
        except ValueError as exc:
            print(f"  -> {exc}")


def parse_local_time(text: str) -> datetime:
    """'YYYY-MM-DD HH:MM' in this PC's local time -> aware UTC datetime."""
    try:
        local = datetime.strptime(text, TIME_FORMAT)
    except ValueError:
        raise ValueError("use the format YYYY-MM-DD HH:MM, e.g. 2026-11-20 09:30") from None
    return local.astimezone().astimezone(timezone.utc)  # naive -> PC local tz -> UTC


def parse_rating(text: str) -> int:
    if text not in {"1", "2", "3", "4", "5"}:
        raise ValueError("enter a whole number from 1 to 5")
    return int(text)


def parse_wave_size(text: str) -> float:
    try:
        value = float(text.replace(",", "."))
    except ValueError:
        raise ValueError("enter a number in metres, e.g. 0.8") from None
    if not 0 <= value <= 15:
        raise ValueError("enter a size between 0 and 15 m")
    return value


def parse_crowd(text: str) -> str:
    """Accept the word or its number (1=empty ... 4=packed)."""
    text = text.lower()
    if text.isdigit() and 1 <= int(text) <= len(CROWD_LEVELS):
        return CROWD_LEVELS[int(text) - 1]
    if text not in CROWD_LEVELS:
        raise ValueError("enter " + ", ".join(f"{i}={c}" for i, c in enumerate(CROWD_LEVELS, 1)))
    return text


# ---------- snapshots ----------

def latest_snapshot(folder: Path = SNAPSHOT_DIR) -> Path | None:
    """Newest image file under the snapshots folder (by modification time)."""
    images = [p for p in folder.rglob("*") if p.suffix.lower() in IMAGE_SUFFIXES]
    return max(images, key=lambda p: p.stat().st_mtime, default=None)


def open_image(path: Path) -> None:
    """Open an image in the system's default viewer."""
    if sys.platform == "win32":
        os.startfile(path)  # type: ignore[attr-defined]
    else:
        webbrowser.open(path.resolve().as_uri())


def snapshot_time(path: Path) -> datetime:
    """When the snapshot was saved (file modification time), in UTC."""
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)


# ---------- database ----------

def save_rating(row: dict, db_path: Path = DB_PATH) -> int:
    """Insert one rating and return its id."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.executescript(SCHEMA)
        columns = list(row.keys())
        cursor = conn.execute(
            f"INSERT INTO ratings ({', '.join(columns)}) VALUES ({', '.join(':' + c for c in columns)})",
            row,
        )
        return cursor.lastrowid


# ---------- main flow ----------

def to_local_text(dt: datetime) -> str:
    return dt.astimezone().strftime(TIME_FORMAT)


def collect_rating(spot: str, default_time: datetime, snapshot: Path | None) -> dict:
    """Ask all questions and return a row ready to save."""
    observed = ask_until_valid("When (local time)", parse_local_time, to_local_text(default_time))
    return {
        "spot": spot,
        "observed_at": to_iso(observed),
        "created_at": to_iso(utc_now()),
        "rating": ask_until_valid("Rating 1-5", parse_rating),
        "wave_size_m": ask_until_valid("Real wave size (m)", parse_wave_size),
        "crowd": ask_until_valid("Crowd (1=empty 2=few 3=busy 4=packed)", parse_crowd),
        "note": ask("Note (optional)", "") or None,
        "source": "snapshot" if snapshot else "beach",
        "snapshot_path": snapshot.relative_to(DATA_DIR).as_posix() if snapshot else None,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rate real surf conditions (1-5).")
    parser.add_argument("--from-snapshot", action="store_true", help="open the latest cam snapshot and rate it")
    parser.add_argument("--spot", default=SPOTS[0].slug, choices=[s.slug for s in SPOTS])
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    snapshot = None
    default_time = utc_now()

    if args.from_snapshot:
        snapshot = latest_snapshot()
        if snapshot is None:
            sys.exit(f"No snapshots found in {SNAPSHOT_DIR}. Run the webcam collector first.")
        default_time = snapshot_time(snapshot)
        print(f"Opening {snapshot.name} (saved {to_local_text(default_time)} local)")
        open_image(snapshot)

    print(f"Rating spot: {args.spot}. Press Enter to accept [defaults].")
    try:
        row = collect_rating(args.spot, default_time, snapshot)
    except (KeyboardInterrupt, EOFError):
        sys.exit("\nCancelled, nothing saved.")
    rating_id = save_rating(row)
    print(f"Saved rating #{rating_id}: {row['rating']}/5, {row['wave_size_m']} m, {row['crowd']} "
          f"at {row['observed_at']} (UTC)")


if __name__ == "__main__":
    main()
