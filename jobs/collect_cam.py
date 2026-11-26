"""Hourly: save a webcam snapshot for every spot with a cam, and prune old snapshots.

Per active spot with `spots.windy_cam_id`:
  1. Skip at night: only runs from 20 min before sunrise to 20 min after sunset (sun times
     from Open-Meteo for the spot, no key).
  2. Ask Windy Webcams API v3 for the cam (fresh image URL) and download the image at once.
     Windy image URLs expire after 10 minutes, so the URL is never stored or reused.
  3. Convert it to WebP of at most 100 KB (jobs/images.py; Pillow, installed only in GitHub
     Actions; without it the original JPEG is stored, with a warning) and upload it to the
     private `snapshots` bucket as `<spot>/<UTC time>.webp`, e.g.
     `vilanova/2026-11-22T121705Z.webp` (cache-control 1 year: a path is never reused), and
     insert a `snapshots` row.
     `taken_at` = when Windy says the image was captured (`lastUpdatedOn`), so if the cam
     hasn't updated since the last run, the same image isn't stored twice. An image older
     than 2 h (frozen cam) is skipped.
  4. Delete snapshots older than 7 days (file + row) to stay in the free tier, except the
     one closest in time to each rating of that spot (within 2 h of `surfed_at`; hidden
     spam ratings don't count). Up to 200 per spot per run; later runs catch up.

Crowd counts (`crowd_water`/`crowd_beach`) stay empty until the YOLO step is built.
The free Windy plan only gives the 400x224 "preview" image.

Run from the repo root:
  python -m jobs.collect_cam              # snapshot + cleanup
  python -m jobs.collect_cam --dry-run    # download only, write/delete nothing
  python -m jobs.collect_cam --any-time   # ignore the night check (testing)
Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WINDY_API_KEY. Standard library (+ Pillow if
installed, for WebP).
Exit code 1 if any spot failed (the others still run).
"""
from __future__ import annotations

import argparse
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

from jobs import images, log
from jobs.check_connections import ROOT, env, load_dotenv
from jobs.collect_forecast import HTTP_TIMEOUT_S, WEATHER_URL, Supabase, http

JOB = "collect_cam"
WINDY_URL = "https://api.windy.com/webcams/api/v3/webcams"
BUCKET = "snapshots"

DAYLIGHT_MARGIN = timedelta(minutes=20)   # dawn patrol counts
MAX_IMAGE_AGE = timedelta(hours=2)        # older = cam frozen, skip
KEEP_DAYS = 7
RATING_WINDOW = timedelta(hours=2)        # snapshot "linked" to a rating if this close
CLEANUP_BATCH = 200
MAX_IMAGE_BYTES = 10 * 1024 * 1024


def utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------- Supabase ----------

class CamSupabase(Supabase):
    def __init__(self, url: str, key: str) -> None:
        super().__init__(url, key)
        self.storage = self.base.replace("/rest/v1", "/storage/v1")

    def spots_with_cams(self) -> list[dict[str, Any]]:
        query = "select=id,lat,lon,windy_cam_id&active=eq.true&windy_cam_id=not.is.null&order=id"
        return http(f"{self.base}/spots?{query}", self.headers)

    def snapshot_exists(self, spot_id: str, taken_at: datetime) -> bool:
        query = urllib.parse.urlencode({"select": "id", "spot_id": f"eq.{spot_id}",
                                        "taken_at": f"eq.{iso(taken_at)}"})
        return bool(http(f"{self.base}/snapshots?{query}", self.headers))

    def upload(self, path: str, data: bytes, content_type: str) -> None:
        # x-upsert: a file left by a run that failed before inserting its row is replaced.
        # A path (spot + capture time) never gets other content, so caches may keep it a year.
        headers = {**self.headers, "Content-Type": content_type, "x-upsert": "true",
                   "cache-control": "max-age=31536000, immutable"}
        http(f"{self.storage}/object/{BUCKET}/{urllib.parse.quote(path)}", headers,
             method="POST", body=data)

    def insert_snapshot(self, row: dict[str, Any]) -> None:
        url = f"{self.base}/snapshots?on_conflict=spot_id,taken_at"
        headers = {**self.headers, "Prefer": "resolution=ignore-duplicates,return=minimal"}
        http(url, headers, method="POST", body=[row])

    def select(self, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
        return http(f"{self.base}/{table}?{urllib.parse.urlencode(params)}", self.headers) or []

    def delete_files(self, paths: list[str]) -> None:
        http(f"{self.storage}/object/{BUCKET}", self.headers, method="DELETE",
             body={"prefixes": paths})

    def delete_snapshot_rows(self, ids: list[int]) -> None:
        id_list = ",".join(str(i) for i in ids)
        http(f"{self.base}/snapshots?id=in.({id_list})",
             {**self.headers, "Prefer": "return=minimal"}, method="DELETE")


# ---------- daylight ----------

def is_daylight(spot: dict[str, Any], now: datetime) -> tuple[bool, str]:
    """True between sunrise - 20 min and sunset + 20 min at the spot (any day around now)."""
    params = urllib.parse.urlencode({
        "latitude": spot["lat"], "longitude": spot["lon"], "daily": "sunrise,sunset",
        "timezone": "UTC", "timeformat": "unixtime", "past_days": 1, "forecast_days": 2,
    })
    daily = http(f"{WEATHER_URL}?{params}")["daily"]
    windows = [
        (datetime.fromtimestamp(rise, timezone.utc) - DAYLIGHT_MARGIN,
         datetime.fromtimestamp(sets, timezone.utc) + DAYLIGHT_MARGIN)
        for rise, sets in zip(daily["sunrise"], daily["sunset"])
        if rise is not None and sets is not None
    ]
    for start, end in windows:
        if start <= now <= end:
            return True, f"daylight {start:%H:%M}-{end:%H:%M} UTC"
    today = next((w for w in windows if w[0].date() == now.date()), None)
    return False, (f"night (daylight today {today[0]:%H:%M}-{today[1]:%H:%M} UTC)"
                   if today else "night")


# ---------- Windy ----------

def fetch_cam_image(cam_id: str, windy_key: str) -> tuple[bytes, str, datetime | None]:
    """Get a fresh image URL and download it straight away. Returns (bytes, type, captured)."""
    cam = http(f"{WINDY_URL}/{urllib.parse.quote(cam_id)}?include=images",
               {"x-windy-api-key": windy_key})
    if cam.get("status") not in (None, "active"):
        raise RuntimeError(f"cam status is {cam.get('status')!r}")
    image_url = ((cam.get("images") or {}).get("current") or {}).get("preview")
    if not image_url:
        raise RuntimeError("Windy returned no image URL")
    # Download now: the URL expires in 10 minutes and is never kept.
    req = urllib.request.Request(image_url, headers={"User-Agent": "surf-app-collector"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
        content_type = resp.headers.get_content_type()
        data = resp.read(MAX_IMAGE_BYTES + 1)
    if not content_type.startswith("image/") or not data or len(data) > MAX_IMAGE_BYTES:
        raise RuntimeError(f"not a usable image ({content_type}, {len(data)} bytes)")
    captured = utc(cam["lastUpdatedOn"]) if cam.get("lastUpdatedOn") else None
    return data, content_type, captured


# ---------- one spot ----------

def snapshot_spot(db: CamSupabase | None, spot: dict[str, Any], windy_key: str,
                  now: datetime, any_time: bool) -> None:
    label = f"[{spot['id']}/cam {spot['windy_cam_id']}]"
    try:
        daylight, why = is_daylight(spot, now)
    except Exception as exc:
        # Without sun times, take the snapshot anyway: a dark image costs ~12 KB and is
        # pruned after 7 days; a missing daylight image is gone for good.
        log.warn(JOB, f"{label} sun times unavailable ({type(exc).__name__}: {exc}); "
                      "taking the snapshot anyway")
        daylight, why = True, "sun times unknown"
    if not daylight and not any_time:
        log.ok(JOB, f"{label} skipped: {why}")
        return

    data, content_type, captured = fetch_cam_image(spot["windy_cam_id"], windy_key)
    taken_at = (captured or now).replace(microsecond=0)
    age = now - taken_at
    if age > MAX_IMAGE_AGE:
        log.warn(JOB, f"{label} skipped: image is {age.total_seconds() / 3600:.1f} h old (cam frozen?)")
        return

    webp = images.to_webp(data)
    if webp is not None:
        original_kb = len(data) // 1024
        data, content_type = webp, "image/webp"
        note = f"webp from {original_kb} KB"
    else:
        note = ("original kept: Pillow not installed" if not images.pillow_available()
                else "original kept: WebP conversion failed")
        if images.pillow_available() or db is not None:
            log.warn(JOB, f"{label} {note}")
    ext = {"image/png": "png", "image/webp": "webp"}.get(content_type, "jpg")
    path = f"{spot['id']}/{taken_at:%Y-%m-%dT%H%M%SZ}.{ext}"
    if db is None:
        log.ok(JOB, f"{label} would store {path} ({len(data) // 1024} KB, {note}, {why}, "
              f"image {age.total_seconds() / 60:.0f} min old)")
        return
    if db.snapshot_exists(spot["id"], taken_at):
        log.ok(JOB, f"{label} skipped: image from {iso(taken_at)} already stored (cam not updated)")
        return
    db.upload(path, data, content_type)
    db.insert_snapshot({"spot_id": spot["id"], "taken_at": iso(taken_at), "image_path": path})
    log.ok(JOB, f"{label} stored {path} ({len(data) // 1024} KB, {note}, "
          f"image {age.total_seconds() / 60:.0f} min old)")


def cleanup_spot(db: CamSupabase, spot_id: str, now: datetime, dry_run: bool) -> None:
    cutoff = now - timedelta(days=KEEP_DAYS)
    old = db.select("snapshots", {
        "select": "id,taken_at,image_path", "spot_id": f"eq.{spot_id}",
        "taken_at": f"lt.{iso(cutoff)}", "order": "taken_at.asc", "limit": str(CLEANUP_BATCH),
    })
    if not old:
        return
    lo = utc(old[0]["taken_at"]) - RATING_WINDOW
    hi = utc(old[-1]["taken_at"]) + RATING_WINDOW
    ratings = db.select("ratings", {
        "select": "surfed_at", "spot_id": f"eq.{spot_id}", "hidden": "is.false",
        "and": f"(surfed_at.gte.{iso(lo)},surfed_at.lte.{iso(hi)})",
    })
    # Every snapshot that could be a rating's nearest, including newer ones outside `old`.
    nearby = db.select("snapshots", {
        "select": "id,taken_at", "spot_id": f"eq.{spot_id}",
        "and": f"(taken_at.gte.{iso(lo - RATING_WINDOW)},taken_at.lte.{iso(hi + RATING_WINDOW)})",
        "order": "taken_at.asc", "limit": "1000",
    }) if ratings else []

    keep: set[int] = set()
    for rating in ratings:
        surfed = utc(rating["surfed_at"])
        best = min(nearby, key=lambda s: abs(utc(s["taken_at"]) - surfed), default=None)
        if best and abs(utc(best["taken_at"]) - surfed) <= RATING_WINDOW:
            keep.add(best["id"])

    doomed = [s for s in old if s["id"] not in keep]
    kept = len(old) - len(doomed)
    if dry_run:
        log.ok(JOB, f"[{spot_id}] cleanup: would delete {len(doomed)}, keep {kept} linked to ratings")
        return
    if doomed:
        # Files first: if deleting the rows then fails, the next run retries both.
        db.delete_files([s["image_path"] for s in doomed])
        db.delete_snapshot_rows([s["id"] for s in doomed])
    log.ok(JOB, f"[{spot_id}] cleanup: deleted {len(doomed)} older than {KEEP_DAYS} days, "
          f"kept {kept} linked to ratings")


# ---------- entry point ----------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true",
                        help="download only; write and delete nothing")
    parser.add_argument("--any-time", action="store_true",
                        help="take a snapshot even at night (testing)")
    args, _ = parser.parse_known_args()  # also run from jobs.collect with its flags

    load_dotenv(ROOT / ".env")
    url, key, windy_key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), env("WINDY_API_KEY")
    if not (url and key and windy_key):
        log.fail(JOB, "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / WINDY_API_KEY not set")
        return 1
    db = CamSupabase(url, key)
    now = datetime.now(timezone.utc)
    print(f"[{JOB}] {iso(now)}{' (dry run)' if args.dry_run else ''}")

    spots = db.spots_with_cams()
    if not spots:
        log.ok(JOB, "No active spot has a windy_cam_id.")
    failed = []
    for spot in spots:
        for step in ("snapshot", "cleanup"):
            try:
                if step == "snapshot":
                    snapshot_spot(None if args.dry_run else db, spot, windy_key, now, args.any_time)
                else:
                    cleanup_spot(db, spot["id"], now, args.dry_run)
            except Exception as exc:  # one bad spot/step must not stop the rest
                failed.append(f"{spot['id']} {step}")
                log.fail(JOB, f"[{spot['id']}] {step}: {type(exc).__name__}: {exc}")
    if failed:
        print(f"[{JOB}] failed: {', '.join(failed)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
