"""Should this scheduled run do anything? Prints SKIP=true when the newest stored forecast is
younger than FRESH_HOURS, else SKIP=false.

Why: Supabase starts the collect workflow every 3 h (migration 22). GitHub's own hourly
schedule stays on as a backup, but a run every hour would only add database rows (the app's
data is fine every 3 h). So GitHub's scheduled runs check first and stop in seconds when the
data is fresh; they only do the work when the Supabase timer has missed a run.
Any error = SKIP=false (better one run too many than none).

  python -m jobs.fresh_check            # used by .github/workflows/collect.yml
Standard library only.
"""
from __future__ import annotations

import sys
import urllib.parse
from datetime import datetime, timezone

from jobs.check_connections import ROOT, env, load_dotenv
from jobs.collect_forecast import Supabase, http

FRESH_HOURS = 2.5


def newest_fetch(db: Supabase) -> datetime | None:
    q = urllib.parse.urlencode({"select": "fetched_at", "order": "fetched_at.desc", "limit": "1"})
    rows = http(f"{db.base}/forecasts?{q}", db.headers) or []
    if not rows:
        return None
    return datetime.fromisoformat(rows[0]["fetched_at"].replace("Z", "+00:00"))


def main() -> int:
    load_dotenv(ROOT / ".env")
    skip = False
    try:
        newest = newest_fetch(Supabase(env("SUPABASE_URL") or "", env("SUPABASE_SERVICE_ROLE_KEY") or ""))
        if newest:
            age_h = (datetime.now(timezone.utc) - newest).total_seconds() / 3600
            skip = age_h < FRESH_HOURS
            print(f"newest forecast run {newest:%Y-%m-%d %H:%M} UTC, {age_h:.1f} h old -> "
                  f"{'fresh, skipping this run' if skip else 'running'}", file=sys.stderr)
    except Exception as exc:  # never block a run because the check failed
        print(f"check failed ({type(exc).__name__}: {exc}); running", file=sys.stderr)
    print(f"SKIP={'true' if skip else 'false'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
