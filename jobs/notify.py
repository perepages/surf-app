"""Hourly: send surf alerts by web push.

For every alert in `push_subscriptions` (a phone + a spot + a minimum score, migration 13):
  1. Take the spot's `predictions` for the next 24 h (written just before by jobs/predict.py):
     the AI score when the spot has an active model, else the simple score (same rounding as
     the app: 3.5 -> 4).
  2. Keep daylight hours only (Open-Meteo sunrise/sunset; an hour counts if its middle is
     between them): nobody wants "epic at 3 am".
  3. The first run of good hours (score >= min, consecutive) is "the window". Send one push:
     "Sitges: 4/5 Good tomorrow at 11h" / "4/5 or better tomorrow 10-13h. AI-corrected
     forecast." Tapping it opens /spot/<id>.
  4. Don't repeat: a window that ends on or before `notified_until` was already announced, and
     each alert sends at most once per 12 h (a forecast flickering around the threshold would
     otherwise alert every hour).
The push service's answer: 404/410 = the phone unsubscribed or the app was removed -> the row is
deleted. 400-type rejections (or unusable keys) count up `failures`; 10 in a row -> deleted.
Network errors, 429 and 5xx are outages (ours or theirs): retried next hour, never counted, so
a long outage can't wipe everyone's alerts. 401/403 = our VAPID key is wrong: step fails.
One spot or one alert failing never stops the others.

Run from the repo root:
  python -m jobs.notify               # send
  python -m jobs.notify --dry-run     # print who would get what; sends nothing, writes nothing
  python -m jobs.notify --test        # send a test push to every alert (setup check), ignores
                                      # the forecast and the 12 h limit, changes nothing
Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY; to send also VAPID_PRIVATE_KEY + VAPID_SUBJECT
and the `pywebpush` package (jobs/requirements-push.txt, installed only in GitHub Actions;
--dry-run works without it). Never prints push endpoints (they work like passwords): only
the push service's host and the row id.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from jobs import log
from jobs.check_connections import ROOT, env, load_dotenv
from jobs.collect_forecast import WEATHER_URL, Supabase, http

JOB = "notify"
HORIZON = timedelta(hours=24)
MIN_GAP = timedelta(hours=12)       # at most one alert per subscription in this time
DROP_AFTER_FAILURES = 10
NETWORK_ERROR = 0       # push service unreachable (our side or theirs)
BAD_SUBSCRIPTION = -1   # the stored keys are unusable
LABELS = {1: "Flat", 2: "Small", 3: "Fun", 4: "Good", 5: "Epic"}
UTC = timezone.utc


def utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def shown_score(row: dict[str, Any]) -> tuple[int, bool]:
    """(1-5 score the app shows, is it the AI's). Round half up like JS Math.round."""
    if row.get("ai_score") is not None:
        return max(1, min(5, int(float(row["ai_score"]) + 0.5))), True
    return int(row["simple_score"]), False


# ---------- Supabase ----------

class NotifySupabase(Supabase):
    def get(self, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
        return http(f"{self.base}/{table}?{urllib.parse.urlencode(params)}", self.headers) or []

    def patch_sub(self, sub_id: int, values: dict[str, Any]) -> None:
        http(f"{self.base}/push_subscriptions?id=eq.{sub_id}",
             {**self.headers, "Prefer": "return=minimal"}, method="PATCH", body=values)

    def delete_sub(self, sub_id: int) -> None:
        http(f"{self.base}/push_subscriptions?id=eq.{sub_id}",
             {**self.headers, "Prefer": "return=minimal"}, method="DELETE")


# ---------- daylight + windows ----------

def daylight_windows(lat: float, lon: float) -> list[tuple[datetime, datetime]]:
    params = urllib.parse.urlencode({
        "latitude": lat, "longitude": lon, "daily": "sunrise,sunset", "timezone": "UTC",
        "timeformat": "unixtime", "past_days": 1, "forecast_days": 3,
    })
    daily = http(f"{WEATHER_URL}?{params}")["daily"]
    return [(datetime.fromtimestamp(r, UTC), datetime.fromtimestamp(s, UTC))
            for r, s in zip(daily["sunrise"], daily["sunset"]) if r is not None and s is not None]


def is_daylight(hour: datetime, windows: list[tuple[datetime, datetime]] | None) -> bool:
    if windows is None:  # sun times unknown: 06-18 UTC (daylight in Spain all year)
        return 6 <= hour.hour <= 18
    mid = hour + timedelta(minutes=30)
    return any(start <= mid <= end for start, end in windows)


def good_window(hours: list[dict[str, Any]], min_score: int) -> dict[str, Any] | None:
    """First run of consecutive good daylight hours: start, end (end of last hour), best."""
    window: list[dict[str, Any]] = []
    for h in hours:  # sorted, daylight only
        if h["score"] >= min_score and (not window or h["at"] - window[-1]["at"] <= timedelta(hours=1)):
            window.append(h)
        elif window:
            break
    if not window:
        return None
    best = max(window, key=lambda h: (h["score"], -h["at"].timestamp()))
    return {"start": window[0]["at"], "end": window[-1]["at"] + timedelta(hours=1),
            "best": best, "ai": any(h["ai"] for h in window)}


def day_word(dt: datetime, now: datetime) -> str:
    days = (dt.date() - now.date()).days
    return "today" if days == 0 else "tomorrow" if days == 1 else dt.strftime("%A")


def window_words(start: datetime, end: datetime, now: datetime, tz: ZoneInfo) -> str:
    """'today 10-13h', 'now until 16h', 'today 20h to tomorrow 01h' (spot local time)."""
    s, e, n = start.astimezone(tz), end.astimezone(tz), now.astimezone(tz)
    if s <= n:
        return f"now until {'' if e.date() == n.date() else day_word(e, n) + ' '}{e:%H}h"
    if e.date() == s.date() or (e - timedelta(seconds=1)).date() == s.date():
        return f"{day_word(s, n)} {s:%H}-{e:%H}h"
    return f"{day_word(s, n)} {s:%H}h to {day_word(e, n)} {e:%H}h"


def message(spot: dict[str, Any], window: dict[str, Any], now: datetime, min_score: int) -> dict[str, Any]:
    """Title = the best hour (what makes it worth it); body = the whole good window."""
    tz = ZoneInfo(spot.get("timezone") or "Europe/Madrid")
    town = spot["name"].split("(")[0].strip()
    best = window["best"]
    score = best["score"]
    at = best["at"].astimezone(tz)
    source = "AI-corrected forecast" if window["ai"] else "Forecast"
    return {
        "title": f"{town}: {score}/5 {LABELS[score]} {day_word(at, now.astimezone(tz))} at {at:%H}h",
        "body": f"{min_score}/5 or better {window_words(window['start'], window['end'], now, tz)}. "
                f"{source}. Tap for the details.",
        "url": f"/spot/{spot['id']}",
        "tag": f"alert-{spot['id']}",
    }


# ---------- sending ----------

class Sender:
    """Thin wrapper so the logic can be tested without pywebpush (dry runs, tests)."""

    def __init__(self, private_key: str, subject: str) -> None:
        from pywebpush import WebPushException, webpush  # only installed in GitHub Actions
        self._webpush, self._error = webpush, WebPushException
        self.key = private_key
        self.claims = {"sub": subject if subject.startswith(("mailto:", "https://")) else f"mailto:{subject}"}

    def send(self, sub: dict[str, Any], payload: dict[str, Any], ttl: int) -> int:
        """HTTP status from the push service (201 = accepted); NETWORK_ERROR if it couldn't be
        reached; BAD_SUBSCRIPTION if this row's keys can't be used to encrypt. Never raises."""
        try:
            resp = self._webpush(
                subscription_info={"endpoint": sub["endpoint"],
                                   "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                data=json.dumps(payload),
                vapid_private_key=self.key,
                vapid_claims=dict(self.claims),  # pywebpush adds aud/exp to this dict
                ttl=ttl,
                headers={"Urgency": "normal"},
                timeout=20,
            )
            return getattr(resp, "status_code", 201)
        except self._error as exc:
            return exc.response.status_code if exc.response is not None else NETWORK_ERROR
        except (ValueError, TypeError, KeyError):
            return BAD_SUBSCRIPTION  # malformed p256dh/auth: encryption fails for this row only
        except Exception:  # requests timeouts, connection resets, DNS: not the phone's fault
            return NETWORK_ERROR


def host(endpoint: str) -> str:
    return urllib.parse.urlsplit(endpoint).hostname or "?"


def notify_one(db: NotifySupabase, sender: Sender | None, spot: dict[str, Any], sub: dict[str, Any],
               hours: list[dict[str, Any]], now: datetime, test: bool, label: str) -> int:
    """One alert: decide, send, record. Returns 1 if the step should turn red."""
    spot_id = spot["id"]
    if test:
        payload = {"title": f"Test alert: {spot['name'].split('(')[0].strip()}",
                   "body": f"Alerts work. You'll hear when it's {sub['min_score']}/5 or better.",
                   "url": f"/spot/{spot_id}", "tag": f"alert-{spot_id}"}
        window = None
    else:
        window = good_window(hours, sub["min_score"])
        if window is None:
            log.ok(JOB, f"{label} nothing that good in the next 24 h of daylight")
            return 0
        told = sub.get("notified_until")
        if told and window["end"] <= utc(told):
            log.ok(JOB, f"{label} already told about this window")
            return 0
        last = sub.get("last_sent_at")
        if last and now - utc(last) < MIN_GAP:
            log.ok(JOB, f"{label} new window, but last alert was < 12 h ago")
            return 0
        payload = message(spot, window, now, sub["min_score"])

    if sender is None:
        log.ok(JOB, f"{label} would send: {payload['title']}")
        return 0
    ttl = 3600 if window is None else max(600, int((window["end"] - now).total_seconds()))
    status = sender.send(sub, payload, ttl)

    if 200 <= status < 300:
        if window is not None:
            db.patch_sub(sub["id"], {"last_sent_at": iso(now), "notified_until": iso(window["end"]),
                                     "failures": 0})
        log.ok(JOB, f"{label} sent: {payload['title']}")
        return 0
    if status in (404, 410):
        db.delete_sub(sub["id"])
        log.ok(JOB, f"{label} push service says gone ({status}); alert removed")
        return 0
    if status in (401, 403):
        # Our signature is wrong (keys don't match): not this phone's fault, never counted.
        log.fail(JOB, f"{label} push service refused our VAPID signature (HTTP {status}): check "
                      "VAPID_PRIVATE_KEY matches VITE_VAPID_PUBLIC_KEY in Vercel")
        return 1
    if status == NETWORK_ERROR or status == 429 or status >= 500:
        # Outage on our side or the push service's: retried next hour, never counted, so a long
        # outage can't delete everyone's alerts.
        log.warn(JOB, f"{label} push service unreachable/busy ({status or 'network'}); next hour")
        return 1
    # 400/413/... or unusable keys: something is wrong with this subscription itself.
    failures = int(sub.get("failures") or 0) + 1
    if failures >= DROP_AFTER_FAILURES:
        db.delete_sub(sub["id"])
        log.warn(JOB, f"{label} rejected {failures} times in a row (last {status}); removed")
        return 0
    db.patch_sub(sub["id"], {"failures": failures})
    log.warn(JOB, f"{label} rejected (HTTP {status}), try {failures} of {DROP_AFTER_FAILURES}")
    return 1


def notify_spot(db: NotifySupabase, sender: Sender | None, spot: dict[str, Any] | None, spot_id: str,
                spot_subs: list[dict[str, Any]], now: datetime, test: bool) -> int:
    """Alerts for one spot. Returns how many sends failed in a way that should turn the step red."""
    failed = 0
    if spot is None:
        log.warn(JOB, f"[{spot_id}] spot not found; {len(spot_subs)} alert(s) skipped")
        return 0
    if not spot.get("active", True):
        log.ok(JOB, f"[{spot_id}] spot is paused (active = false); {len(spot_subs)} alert(s) wait")
        return 0
    hours: list[dict[str, Any]] = []
    if not test:
        try:
            windows = daylight_windows(spot["lat"], spot["lon"])
        except Exception as exc:
            log.warn(JOB, f"[{spot_id}] sun times unavailable ({type(exc).__name__}); "
                          "using 06-18 UTC as daylight")
            windows = None
        rows = db.get("predictions", {
            "select": "valid_at,simple_score,ai_score", "spot_id": f"eq.{spot_id}",
            "and": f"(valid_at.gte.{iso(now - timedelta(hours=1))},valid_at.lt.{iso(now + HORIZON)})",
            "order": "valid_at",
        })
        for r in rows:
            at = utc(r["valid_at"])
            if at + timedelta(hours=1) <= now or not is_daylight(at, windows):
                continue  # hour already over, or dark
            score, ai = shown_score(r)
            hours.append({"at": at, "score": score, "ai": ai})
        if not rows:
            log.warn(JOB, f"[{spot_id}] no predictions for the next 24 h (predict step failed?)")

    for sub in spot_subs:
        label = f"[{spot_id} #{sub['id']} {host(sub['endpoint'])} min {sub['min_score']}]"
        try:
            failed += notify_one(db, sender, spot, sub, hours, now, test, label)
        except Exception as exc:  # e.g. the database write after a send failed
            failed += 1
            log.fail(JOB, f"{label} {type(exc).__name__}: {exc}")
    return failed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="print, don't send or write")
    parser.add_argument("--test", action="store_true",
                        help="send a test push to every alert (ignores forecast and limits)")
    args, _ = parser.parse_known_args()

    load_dotenv(ROOT / ".env")
    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        log.fail(JOB, "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set")
        return 1
    db = NotifySupabase(url, key)
    now = datetime.now(UTC).replace(microsecond=0)
    print(f"[{JOB}] {iso(now)}{' (dry run)' if args.dry_run else ''}{' (TEST push)' if args.test else ''}")

    try:
        subs = db.get("push_subscriptions", {"select": "*", "order": "spot_id,id"})
    except Exception as exc:
        if "push_subscriptions" in str(exc) and ("404" in str(exc) or "PGRST205" in str(exc)):
            log.warn(JOB, "table push_subscriptions missing (apply migration 13); no alerts sent")
            return 0
        raise
    if not subs:
        log.ok(JOB, "no alerts turned on")
        return 0

    sender = None
    if not args.dry_run:
        private, subject = env("VAPID_PRIVATE_KEY"), env("VAPID_SUBJECT")
        if not (private and subject):
            log.fail(JOB, f"{len(subs)} alert(s) waiting but VAPID_PRIVATE_KEY / VAPID_SUBJECT not set")
            return 1
        try:
            sender = Sender(private, subject)
        except ImportError:
            log.fail(JOB, "pywebpush not installed (pip install -r jobs/requirements-push.txt; "
                          "GitHub Actions only)")
            return 1

    spot_ids = sorted({s["spot_id"] for s in subs})
    spots = {s["id"]: s for s in db.get("spots", {
        "select": "id,name,lat,lon,timezone,active", "id": f"in.({','.join(spot_ids)})"})}
    failed = 0
    for spot_id in spot_ids:
        spot_subs = [s for s in subs if s["spot_id"] == spot_id]
        try:
            failed += notify_spot(db, sender, spots.get(spot_id), spot_id, spot_subs, now, args.test)
        except Exception as exc:  # one spot's problem must not stop the others
            failed += 1
            log.fail(JOB, f"[{spot_id}] {type(exc).__name__}: {exc}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
