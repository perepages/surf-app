"""Nightly: are we near a free-plan limit? Exit 1 (red step -> GitHub emails the repo owner)
when database, file storage or today's Open-Meteo calls pass ALERT_AT of the free limit.

Reads public.usage_summary() (migration 24). Same limits as web/api/admin.ts FREE_LIMITS;
checked 2026-11-26 on supabase.com/pricing and open-meteo.com/en/pricing. Supabase egress and
Vercel can't be read automatically (see /admin).

  python -m jobs.usage_check
Standard library only. A missing migration only warns (exit 0).
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone

from jobs import log
from jobs.check_connections import ROOT, env, load_dotenv
from jobs.collect_forecast import HttpError, Supabase, http

JOB = "usage_check"
ALERT_AT = 0.8
LIMITS = {
    "db": ("Supabase database", 500e6),
    "storage": ("Supabase file storage", 1e9),
    "open_meteo": ("Open-Meteo calls (busiest day, last 2 days)", 10_000),
}


def main() -> int:
    load_dotenv(ROOT / ".env")
    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        log.fail(JOB, "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set")
        return 1
    db = Supabase(url, key)
    try:
        u = http(f"{db.base}/rpc/usage_summary", db.headers, method="POST", body={})
    except HttpError as exc:
        if "PGRST202" in str(exc):
            log.warn(JOB, "usage_summary missing: apply migration 24 (usage_stats)")
            return 0
        raise
    today = datetime.now(timezone.utc).date()
    recent = [a["calls"] for a in u["api_calls"] if a["service"] == "open-meteo"
              and (today - datetime.fromisoformat(a["day"]).date()).days <= 1]
    used = {
        "db": u["db_bytes"] or 0,
        "storage": sum(b["bytes"] for b in u["storage"]),
        "open_meteo": max(recent, default=0),
    }
    over = False
    for k, (label, limit) in LIMITS.items():
        share = used[k] / limit
        text = f"{label}: {share:.0%} of the free limit ({used[k]:,.0f} of {limit:,.0f})"
        if share >= ALERT_AT:
            over = True
            log.fail(JOB, text + " -> see /admin")
        else:
            log.ok(JOB, text)
    return 1 if over else 0


if __name__ == "__main__":
    sys.exit(main())
