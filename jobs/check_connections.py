"""Check that every key and connection works. Never prints key values.

Run from the repo root:  python -m jobs.check_connections
Locally it reads .env; in GitHub Actions it uses the repository secrets.
Checks whose variables are missing are SKIPPED, so the same script works in both places.
With --require-jobs, missing jobs variables (Supabase service key, Windy) FAIL instead of
skipping; the GitHub workflow uses this so empty secrets can't give a green run.
Exit code: 0 = all good, 1 = at least one check failed.
Uses only the Python standard library (works on 3.10+).
"""
from __future__ import annotations

import argparse
import base64
import http.client
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TIMEOUT = 20
results: list[tuple[str, str, str]] = []  # (status, check, detail)
REQUIRE_JOBS = False


def load_dotenv(path: Path) -> None:
    """Minimal .env reader. Real environment variables (e.g. GitHub secrets) win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        if value:
            os.environ.setdefault(key.strip(), value)


def env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


def record(status: str, check: str, detail: str = "") -> None:
    results.append((status, check, detail))
    print(f"[{status:4}] {check}" + (f"  ({detail})" if detail else ""))


def request(url: str, headers: dict[str, str] | None = None,
            method: str = "GET", body: bytes | None = None) -> tuple[int, str]:
    """Return (status code, body text). Network errors return status 0."""
    try:
        req = urllib.request.Request(url, headers=headers or {}, method=method, data=body)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except (OSError, http.client.HTTPException, ValueError) as exc:
        # OSError covers URLError, timeouts, resets; ValueError = malformed URL.
        return 0, f"{type(exc).__name__}: {exc}"


def supabase_headers(key: str) -> dict[str, str]:
    """New keys (sb_publishable_/sb_secret_) go in 'apikey' only; legacy JWT keys also as Bearer."""
    headers = {"apikey": key}
    if key.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {key}"
    return headers


def missing(check: str, detail: str, required: bool = False) -> None:
    """Missing variables: SKIP normally, FAIL when they are required."""
    record("FAIL" if required else "SKIP", check, detail)


def key_role(key: str) -> str:
    """'public', 'secret' or 'unknown', without contacting Supabase."""
    if key.startswith("sb_publishable_"):
        return "public"
    if key.startswith("sb_secret_"):
        return "secret"
    if key.startswith("eyJ") and key.count(".") == 2:
        try:
            payload = key.split(".")[1]
            payload += "=" * (-len(payload) % 4)
            role = json.loads(base64.urlsafe_b64decode(payload)).get("role")
            return {"anon": "public", "service_role": "secret"}.get(role, "unknown")
        except (ValueError, json.JSONDecodeError):
            pass
    return "unknown"


# --------------------------------------------------------------------------- checks

def check_open_meteo() -> None:
    url = ("https://marine-api.open-meteo.com/v1/marine"
           "?latitude=41.2097&longitude=1.7128&hourly=wave_height&forecast_days=1")
    code, body = request(url)
    if code == 200 and '"wave_height"' in body:
        record("OK", "Open-Meteo Marine API reachable")
    else:
        record("FAIL", "Open-Meteo Marine API reachable", f"HTTP {code}")


def check_web_keys_are_safe() -> None:
    """The browser only sees VITE_* vars. None of them may hold a secret."""
    secrets = {n: env(n) for n in ("SUPABASE_SERVICE_ROLE_KEY", "WINDY_API_KEY")}
    vite_vars = {k: v for k, v in os.environ.items() if k.startswith("VITE_") and v.strip()}
    if not vite_vars:
        record("SKIP", "No secrets in VITE_* variables", "no VITE_* variables set")
        return
    leaks = [k for k, v in vite_vars.items()
             if v in [s for s in secrets.values() if s] or key_role(v) == "secret"]
    if leaks:
        record("FAIL", "No secrets in VITE_* variables",
               f"{', '.join(leaks)} holds a secret key - it would be public in the web app")
    else:
        record("OK", "No secrets in VITE_* variables")


def check_supabase_anon() -> None:
    url, key = env("VITE_SUPABASE_URL"), env("VITE_SUPABASE_ANON_KEY")
    name = "Supabase public key (web app)"
    if not (url and key):
        record("SKIP", name, "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set")
        return
    rest, headers = url.rstrip("/") + "/rest/v1", supabase_headers(key)

    code, body = request(f"{rest}/spots?select=id", headers)
    if code == 200 and '"vilanova"' in body:
        record("OK", f"{name}: can read spots (Vilanova found)")
    elif code == 200:
        record("FAIL", f"{name}: can read spots", "connected, but Vilanova is missing - run the seed migration")
    else:
        record("FAIL", f"{name}: can read spots", f"HTTP {code}: {body[:150]}")
        return

    code, body = request(f"{rest}/forecasts?select=id&limit=1", headers)
    record("OK" if code == 200 else "FAIL", f"{name}: can read forecasts",
           "" if code == 200 else f"HTTP {code}")

    # Buoy data must stay hidden: RLS returns an empty list to the public.
    code, body = request(f"{rest}/observations?select=id&limit=1", headers)
    hidden = (code == 200 and body.strip() == "[]") or code in (401, 403)
    record("OK" if hidden else "FAIL", f"{name}: cannot read buoy observations",
           "" if hidden else f"HTTP {code}, rows visible to the public!")

    # The public may only insert 'community' ratings. This insert must be rejected (writes nothing).
    fake = json.dumps({"spot_id": "vilanova", "surfed_at": "2026-01-01T00:00:00Z",
                       "overall": 3, "source": "me"}).encode()
    code, _ = request(f"{rest}/ratings", {**headers, "Content-Type": "application/json",
                                          "Prefer": "return=minimal"}, "POST", fake)
    record("OK" if code in (401, 403) else "FAIL", f"{name}: cannot insert 'me' ratings",
           "" if code in (401, 403) else f"HTTP {code}, the insert was accepted!")


def check_supabase_service() -> None:
    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")
    name = "Supabase service key (jobs)"
    if not (url and key):
        missing(name, "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set", REQUIRE_JOBS)
        return
    if key_role(key) == "public":
        record("FAIL", name, "SUPABASE_SERVICE_ROLE_KEY holds the public key, not the secret one")
        return
    base, headers = url.rstrip("/"), supabase_headers(key)

    code, body = request(f"{base}/rest/v1/observations?select=id&limit=1", headers)
    record("OK" if code == 200 else "FAIL", f"{name}: can read private tables",
           "" if code == 200 else f"HTTP {code}: {body[:150]}")

    code, body = request(f"{base}/storage/v1/bucket/snapshots", headers)
    record("OK" if code == 200 else "FAIL", f"{name}: 'snapshots' storage bucket exists",
           "" if code == 200 else f"HTTP {code}: {body[:150]}")


def check_windy() -> None:
    key = env("WINDY_API_KEY")
    name = "Windy Webcams API v3 key"
    if not key:
        missing(name, "WINDY_API_KEY not set", REQUIRE_JOBS)
        return
    code, body = request("https://api.windy.com/webcams/api/v3/webcams?limit=1",
                         {"x-windy-api-key": key})
    record("OK" if code == 200 else "FAIL", name,
           "" if code == 200 else f"HTTP {code}: {body[:150]}")


def main() -> int:
    global REQUIRE_JOBS
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--require-jobs", action="store_true",
                        help="fail (not skip) when the jobs' variables are missing")
    REQUIRE_JOBS = parser.parse_args().require_jobs
    load_dotenv(ROOT / ".env")
    print("Checking connections (key values are never printed)\n")
    check_open_meteo()
    check_web_keys_are_safe()
    check_supabase_anon()
    check_supabase_service()
    check_windy()

    counts = {s: sum(1 for r in results if r[0] == s) for s in ("OK", "FAIL", "SKIP")}
    print(f"\n{counts['OK']} OK, {counts['FAIL']} failed, {counts['SKIP']} skipped")
    return 1 if counts["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
