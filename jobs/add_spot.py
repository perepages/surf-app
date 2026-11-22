"""Add a surf spot, step by step. Run from the repo root:

  python jobs/add_spot.py            # asks the questions, then inserts the spot
  python jobs/add_spot.py --dry-run  # same questions, shows the row, inserts nothing

It asks for:
  1. the name and coordinates (paste "41.2097, 1.7128" straight from Google Maps),
     then checks Open-Meteo has wave data there (a point on land has none);
  2. an id (short slug, used in URLs and storage paths; suggested from the name);
  3. a Windy cam: lists the cams within --cam-km (default 10 km) with distance,
     direction and a windy.com link to look at each one;
  4. Puertos del Estado buoys: lists the wave buoys within --buoy-km (default 150 km)
     with distance, depth, whether they also measure wind, and how old their newest
     reading is (asked live from PORTUS);
  5. the beach orientation: the direction you face standing on the sand looking at the
     sea, in degrees (0 = N, 90 = E, 180 = S) or as a compass point (SSE);
  6. the time zone (suggested by Open-Meteo for those coordinates).
Then it shows the row and inserts it into `spots` after you say yes.

Nothing else is needed: the hourly job (forecast, buoys, cam, predictions) and the nightly
training read every `spots` row with active = true, so the new spot is collected from the
next run at :17 UTC. Buoy data is training-only and never shown publicly.

Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (always) and WINDY_API_KEY (for the cam list;
without it the cam step is skipped). Standard library only. Never prints key values.
"""
from __future__ import annotations

import argparse
import math
import re
import sys
import unicodedata
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

if __package__ in (None, ""):  # run as `python jobs/add_spot.py`: make `jobs` importable
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jobs.check_connections import ROOT, env, load_dotenv  # noqa: E402
from jobs.collect_buoy import PORTUS_API, WANTED  # noqa: E402
from jobs.collect_cam import WINDY_URL  # noqa: E402
from jobs.collect_forecast import MARINE_URL, WEATHER_URL, Supabase, http  # noqa: E402

COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
MAX_CAMS = 10
MAX_BUOYS = 8
SUGGESTED_BUOYS = 2
LIVE_HOURS = 6        # a buoy whose newest reading is older than this is shown as "quiet"
SAME_PLACE_KM = 1.0   # warn if an existing spot is this close
MAX_CELL_KM = 30.0    # nearest Open-Meteo sea cell further than this = forecast is not local
LAND_M = 5.0          # ground higher than this (90 m terrain model; sea = 0) = point on land
ELEVATION_URL = "https://api.open-meteo.com/v1/elevation"


class Quit(Exception):
    pass


# ---------- small helpers ----------

def ask(prompt: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default not in (None, "") else ""
    try:
        answer = input(f"{prompt}{suffix}: ").strip()
    except EOFError:
        raise Quit("no more input") from None
    if answer.lower() in ("q", "quit", "exit"):
        raise Quit("stopped")
    return answer or (default or "")


def ask_until(prompt: str, parse: Callable[[str], Any], default: str | None = None) -> Any:
    while True:
        try:
            return parse(ask(prompt, default))
        except ValueError as exc:
            print(f"  ! {exc}")


def yes(prompt: str, default: bool = True) -> bool:
    return ask_until(prompt + " (y/n)", _yes_no, "y" if default else "n")


def _yes_no(text: str) -> bool:
    if text.lower() in ("y", "yes", "s", "si", "sí"):
        return True
    if text.lower() in ("n", "no"):
        return False
    raise ValueError("answer y or n")


def km_between(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def compass(deg: float) -> str:
    return COMPASS[int((deg % 360) / 22.5 + 0.5) % 16]


def age_text(hours: float | None) -> str:
    if hours is None:
        return "no recent data"
    if hours < 1:
        return "reading < 1 h ago"
    if hours < 48:
        return f"reading {hours:.0f} h ago"
    return f"reading {hours / 24:.0f} days ago"


# ---------- parsing answers ----------

def parse_name(text: str) -> str:
    text = " ".join(text.split())
    if not 2 <= len(text) <= 120:
        raise ValueError("give a name of 2-120 characters")
    return text


def parse_coords(text: str) -> tuple[float, float]:
    numbers = re.findall(r"-?\d+(?:[.,]\d+)?", text.replace(", ", " ").replace(";", " "))
    if len(numbers) != 2:
        raise ValueError('paste "lat, lon", e.g. 41.2097, 1.7128 (decimal degrees)')
    lat, lon = (float(n.replace(",", ".")) for n in numbers)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("latitude must be -90..90 and longitude -180..180")
    return round(lat, 5), round(lon, 5)


def slugify(name: str) -> str:
    name = name.split("(")[0]  # "Sitges (Platja de la Ribera)" -> "sitges"
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    words = re.findall(r"[a-z0-9]+", ascii_name.lower())
    return "-".join(words)[:32].strip("-") or "spot"


def parse_slug(text: str, taken: set[str]) -> str:
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", text) or len(text) > 32:
        raise ValueError("use lowercase letters, digits and single dashes (max 32), e.g. sitges")
    if text in taken or text == "general":  # 'general' is the shared model's folder
        raise ValueError(f"'{text}' is already used; pick another id")
    return text


def parse_orientation(text: str) -> int:
    word = text.strip().upper()
    if word in COMPASS:
        return int(round(COMPASS.index(word) * 22.5)) % 360
    try:
        value = float(text.replace("°", "").replace(",", "."))
    except ValueError:
        raise ValueError("give degrees 0-359 (0 = N, 90 = E, 180 = S) or a compass point "
                         "like SSE") from None
    if not 0 <= value < 360:
        raise ValueError("degrees must be 0-359")
    return int(round(value)) % 360


def parse_timezone(text: str) -> str:
    try:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    except ImportError:  # pragma: no cover (Python < 3.9)
        return text
    try:
        ZoneInfo(text)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError("not a known time zone; use a name like Europe/Madrid "
                         "(a wrong one makes every rating fail)") from None
    return text


# ---------- checks against the APIs ----------

def check_open_meteo(lat: float, lon: float) -> dict[str, Any]:
    """waves/hours (hours with wave data today), cell_km (distance to the sea grid cell
    Open-Meteo Marine uses), elevation (m, sea = 0), tz (suggested time zone).

    Open-Meteo Marine snaps to the nearest sea cell, so a point on land still gets waves;
    the elevation is what tells land from sea."""
    marine = http(f"{MARINE_URL}?" + urllib.parse.urlencode({
        "latitude": lat, "longitude": lon, "hourly": "wave_height", "forecast_days": 1}))
    values = (marine.get("hourly") or {}).get("wave_height") or []
    cell_km = None
    if marine.get("latitude") is not None and marine.get("longitude") is not None:
        cell_km = km_between(lat, lon, marine["latitude"], marine["longitude"])
    tz = None
    try:
        weather = http(f"{WEATHER_URL}?" + urllib.parse.urlencode({
            "latitude": lat, "longitude": lon, "timezone": "auto", "forecast_days": 1,
            "daily": "sunrise"}))
        tz = weather.get("timezone")
    except Exception:
        pass  # only a suggestion
    elevation = None
    try:
        elevation = (http(f"{ELEVATION_URL}?latitude={lat}&longitude={lon}")
                     or {}).get("elevation", [None])[0]
    except Exception:
        pass  # only a hint
    return {"waves": sum(v is not None for v in values), "hours": len(values),
            "cell_km": cell_km, "elevation": elevation, "tz": tz}


def nearby_cams(lat: float, lon: float, radius_km: float, windy_key: str) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode({
        "nearby": f"{lat},{lon},{radius_km:g}", "include": "location",
        "limit": 50,
    })
    data = http(f"{WINDY_URL}?{params}", {"x-windy-api-key": windy_key}) or {}
    cams = []
    for cam in data.get("webcams") or []:
        loc = cam.get("location") or {}
        if loc.get("latitude") is None or loc.get("longitude") is None:
            continue
        updated = cam.get("lastUpdatedOn")
        age = None
        if updated:
            when = datetime.fromisoformat(updated.replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - when).total_seconds() / 3600
        cams.append({
            "id": str(cam.get("webcamId")),
            "title": cam.get("title") or "(no title)",
            "status": cam.get("status") or "?",
            "km": km_between(lat, lon, loc["latitude"], loc["longitude"]),
            "dir": compass(bearing(lat, lon, loc["latitude"], loc["longitude"])),
            "age_h": age,
        })
    cams.sort(key=lambda c: c["km"])
    return cams[:MAX_CAMS]


def portus_get(path: str) -> Any:
    return http(f"{PORTUS_API}/{path}?locale=es")


def buoy_latest(buoy_id: str) -> tuple[float | None, set[str]]:
    """(hours since the newest reading, which wanted parameters it reports)."""
    latest = http(f"{PORTUS_API}/lastData/station/{buoy_id}?locale=es",
                  method="POST", body=["WAVE", "WIND"]) or {}
    params = {d.get("paramEseoo") for d in latest.get("datos") or []} & set(WANTED)
    age = None
    if latest.get("fecha"):
        when = datetime.strptime(latest["fecha"][:19], "%Y-%m-%d %H:%M:%S")
        age = (datetime.now(timezone.utc).replace(tzinfo=None) - when).total_seconds() / 3600
    return age, params


def nearby_buoys(lat: float, lon: float, radius_km: float) -> list[dict[str, Any]]:
    """Wave buoys within radius_km, nearest first, with a live check of each."""
    wave = portus_get("estaciones/rt/WAVE") or []
    try:
        wind_ids = {str(s.get("id")) for s in portus_get("estaciones/rt/WIND") or []}
    except Exception:
        wind_ids = set()
    found = []
    for s in wave:
        if s.get("latitud") is None or s.get("longitud") is None or not s.get("disponible", True):
            continue
        km = km_between(lat, lon, s["latitud"], s["longitud"])
        if km <= radius_km:
            found.append({
                "id": str(s["id"]), "name": s.get("nombre") or "?", "km": km,
                "dir": compass(bearing(lat, lon, s["latitud"], s["longitud"])),
                "depth": s.get("altitudProfundidad"), "wind_listed": str(s["id"]) in wind_ids,
            })
    found.sort(key=lambda b: b["km"])
    found = found[:MAX_BUOYS]
    for b in found:
        try:
            b["age_h"], params = buoy_latest(b["id"])
            b["waves"] = "Hm0" in params
            b["wind"] = "WindSpeed" in params or b["wind_listed"]
        except Exception as exc:
            b["age_h"], b["waves"], b["wind"] = None, False, b["wind_listed"]
            b["error"] = f"{type(exc).__name__}"
        b["live"] = b["waves"] and b["age_h"] is not None and b["age_h"] <= LIVE_HOURS
    return found


# ---------- the questions ----------

def choose_cam(cams: list[dict[str, Any]]) -> str | None:
    if not cams:
        print("  No Windy cams found. The spot works without one (no snapshots).")
        return None
    for i, c in enumerate(cams, 1):
        live = "" if c["status"] == "active" else f", status {c['status']}"
        updated = "" if c["age_h"] is None else f", image {age_text(c['age_h'])[8:]}"
        print(f"  {i}) {c['title']}  ({c['km']:.1f} km {c['dir']}{live}{updated})")
        print(f"     https://www.windy.com/webcams/{c['id']}")
    print("  Pick one that shows the waves (open the links to look). The free Windy plan "
          "gives only a 400x224 image.")

    def parse(text: str) -> str | None:
        if text in ("0", "none", "-"):
            return None
        if text.isdigit() and 1 <= int(text) <= len(cams):
            return cams[int(text) - 1]["id"]
        if any(c["id"] == text for c in cams):
            return text
        raise ValueError(f"type 1-{len(cams)}, a cam id from the list, or 0 for no cam")

    return ask_until("Cam number (0 = none)", parse, "0")


def choose_buoys(buoys: list[dict[str, Any]]) -> list[str]:
    if not buoys:
        print("  No PORTUS wave buoys in range. The spot works without (training uses the "
              "ratings + forecast only).")
        return []
    for i, b in enumerate(buoys, 1):
        what = "waves + wind" if b["wind"] else "waves only"
        depth = f", {b['depth']:.0f} m deep" if b.get("depth") else ""
        state = age_text(b["age_h"]) if b["waves"] else "no wave data now"
        if b.get("error"):
            state = f"couldn't check ({b['error']})"
        print(f"  {i}) {b['id']} {b['name']}  ({b['km']:.1f} km {b['dir']}{depth}; {what}; "
              f"{state})")
    # Suggest the nearest live buoy, plus the nearest live one with wind if that's another.
    live = [i for i, b in enumerate(buoys, 1) if b["live"]]
    suggested = live[:1] + [i for i in live if buoys[i - 1]["wind"]][:1]
    if len(suggested) < SUGGESTED_BUOYS:
        suggested += live[1:SUGGESTED_BUOYS]
    suggested = [str(i) for i in dict.fromkeys(suggested)][:SUGGESTED_BUOYS]
    print("  Several are fine (e.g. 1,3): a near coastal one plus one that measures wind is "
          "a good mix. A buoy in maintenance can still be picked; the job warns while it's "
          "quiet.")

    def parse(text: str) -> list[str]:
        if text in ("0", "none", "-"):
            return []
        picked: list[str] = []
        for part in re.split(r"[,\s]+", text.strip()):
            if part.isdigit() and 1 <= int(part) <= len(buoys):
                buoy_id = buoys[int(part) - 1]["id"]
            elif any(b["id"] == part for b in buoys):
                buoy_id = part
            else:
                raise ValueError(f"'{part}': type numbers 1-{len(buoys)} separated by commas, "
                                 "or 0 for none")
            if buoy_id not in picked:
                picked.append(buoy_id)
        return picked

    return ask_until("Buoy numbers, nearest/most useful first (0 = none)", parse,
                     ",".join(suggested) or "0")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):  # Windows console: never crash on 'ñ' or '–'
        try:
            stream.reconfigure(errors="replace")
        except AttributeError:
            pass
    parser = argparse.ArgumentParser(description="Add a surf spot, step by step.")
    parser.add_argument("--dry-run", action="store_true", help="ask everything, insert nothing")
    parser.add_argument("--cam-km", type=float, default=10.0, help="cam search radius (km)")
    parser.add_argument("--buoy-km", type=float, default=150.0, help="buoy search radius (km)")
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")
    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        print("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (put them in .env).")
        return 1
    db = Supabase(url, key)
    windy_key = env("WINDY_API_KEY")

    try:
        existing = http(f"{db.base}/spots?select=id,name,lat,lon&order=id", db.headers) or []
    except Exception as exc:
        print(f"Couldn't read the spots table: {type(exc).__name__}: {exc}")
        return 1

    print("Add a surf spot" + (" (dry run: nothing is inserted)" if args.dry_run else ""))
    print("Type q to stop at any question. Existing spots: "
          + (", ".join(s["id"] for s in existing) or "none"))
    try:
        # 1. name + coordinates
        print("\n1. Name and place")
        name = ask_until("Name (as shown in the app)", parse_name)
        while True:
            lat, lon = ask_until('Coordinates, a point just off the beach ("lat, lon")',
                                 parse_coords)
            close = [s for s in existing
                     if km_between(lat, lon, s["lat"], s["lon"]) < SAME_PLACE_KM]
            if close and not yes(f"  '{close[0]['id']}' is less than {SAME_PLACE_KM:g} km away. "
                                 "Add another spot anyway?", False):
                continue
            try:
                om = check_open_meteo(lat, lon)
            except Exception as exc:
                print(f"  ! Couldn't reach Open-Meteo ({type(exc).__name__}); wave data not "
                      "checked.")
                om = {"waves": -1, "hours": 0, "cell_km": None, "elevation": None, "tz": None}
            tz_guess = om["tz"]
            problem = None
            if om["waves"] == 0:
                problem = "Open-Meteo has no wave data near this point."
            elif om["elevation"] is not None and om["elevation"] > LAND_M:
                problem = (f"This point is on land ({om['elevation']:.0f} m above sea level). "
                           "Put it on the water just off the beach.")
            elif om["cell_km"] is not None and om["cell_km"] > MAX_CELL_KM:
                problem = (f"Open-Meteo's nearest sea data point is {om['cell_km']:.0f} km "
                           "away, so the forecast won't be local.")
            if problem:
                print(f"  ! {problem}")
                if not yes("  Use it anyway?", False):
                    continue
            elif om["waves"] > 0:
                where = "" if om["cell_km"] is None else                     f", from a sea data point {om['cell_km']:.1f} km away"
                print(f"  Open-Meteo has wave data here ({om['waves']}/{om['hours']} hours "
                      f"today{where}).")
            break

        # 2. id
        print("\n2. Id (short, used in links and file names; can't be changed later)")
        taken = {s["id"] for s in existing}
        spot_id = ask_until("Id", lambda t: parse_slug(t, taken), slugify(name))

        # 3. cam
        print(f"\n3. Windy cam (within {args.cam_km:g} km)")
        cam_id = None
        if not windy_key:
            print("  WINDY_API_KEY not set: skipping (add a cam later with the SQL editor).")
        else:
            try:
                cam_id = choose_cam(nearby_cams(lat, lon, args.cam_km, windy_key))
            except Quit:
                raise
            except Exception as exc:
                print(f"  ! Windy search failed ({type(exc).__name__}: {exc}).")
                cam_id = ask("Type a Windy cam id, or leave empty for none", "") or None

        # 4. buoys
        print(f"\n4. Puertos del Estado buoys (within {args.buoy_km:g} km; checking each one "
              "live, a few seconds)")
        try:
            buoy_ids = choose_buoys(nearby_buoys(lat, lon, args.buoy_km))
        except Quit:
            raise
        except Exception as exc:
            print(f"  ! PORTUS search failed ({type(exc).__name__}: {exc}).")
            raw = ask("Type buoy ids separated by commas, or leave empty for none", "")
            buoy_ids = [b for b in re.split(r"[,\s]+", raw) if b.isdigit()]

        # 5. orientation
        print("\n5. Beach orientation: stand on the sand looking at the sea; which way do "
              "you face?")
        print("   Degrees (0 = N, 90 = E, 180 = S, 270 = W) or a compass point (S, SSE, SE...).")
        print("   Wind from that side is onshore, from the opposite side offshore.")
        orientation = ask_until("Orientation", parse_orientation)
        print(f"  = {orientation}° ({compass(orientation)})")

        # 6. time zone
        print("\n6. Time zone (used for 'today' and the rating time limits)")
        timezone_name = ask_until("Time zone", parse_timezone, tz_guess or "Europe/Madrid")

        row = {
            "id": spot_id, "name": name, "lat": lat, "lon": lon,
            "beach_orientation": orientation, "windy_cam_id": cam_id,
            "buoy_ids": buoy_ids, "timezone": timezone_name, "active": True,
        }
        print("\nNew spot:")
        for k, v in row.items():
            print(f"  {k:18} {v}")
        if args.dry_run:
            print("\nDry run: nothing inserted.")
            return 0
        if not yes("\nInsert it? The hourly job starts collecting it at the next :17 UTC"):
            print("Nothing inserted.")
            return 0
    except Quit as why:
        print(f"\n{why}: nothing inserted.")
        return 1

    try:
        http(f"{db.base}/spots", {**db.headers, "Prefer": "return=minimal"},
             method="POST", body=[row])
    except Exception as exc:
        print(f"Insert failed: {type(exc).__name__}: {exc}")
        return 1
    print(f"\nInserted '{spot_id}'. Next:")
    print("  - check it now:  python -m jobs.collect_forecast --dry-run   (and collect_buoy /"
          " collect_cam --any-time)")
    print("  - from the next hourly run (:17 UTC) forecast, buoys, cam and simple-score "
          "predictions are stored; the nightly training uses the shared model until the spot "
          "has 30 + 10 ratings of its own.")
    print("  - pause it later: set active = false in the Supabase table editor.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
