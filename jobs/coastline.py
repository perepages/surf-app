"""Beach normal + swell window for a point, from the OpenStreetMap coastline.

  python -m jobs.coastline 41.2097 1.7128            # prints normal, window, what blocks it
  python -m jobs.coastline 41.2097 1.7128 --normal 165

Method (docs/surf_theory.md section 2):
  - downloads `natural=coastline` + harbour walls (`man_made=breakwater|pier`) within
    ~RADIUS_KM from Overpass (public OSM servers, no key; tried one after another);
  - beach normal = length-weighted direction of the coastline within NORMAL_KM, sea side
    (OSM coastlines keep land on the left);
  - from the point, a ray every 1 degree; a direction is OPEN if no coastline / wall is hit
    within OPEN_KM (hits closer than IGNORE_KM are the spot's own beach curving away, skipped);
  - the window is the run of open directions around the normal, clipped to normal +- 90.
Standard library only. The result is a suggestion: look at a map and confirm it.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from typing import Any

OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
RADIUS_KM = 35.0
NORMAL_KM = 0.8
IGNORE_KM = 0.4
OPEN_KM = 30.0
TILES = 3  # the area is fetched as TILES x TILES small queries (big ones time out)


def _query(bbox: tuple[float, float, float, float]) -> list[dict[str, Any]]:
    s, w, n, e = bbox
    area = f"({s:.4f},{w:.4f},{n:.4f},{e:.4f})"
    q = (f'[out:json][timeout:60];(way["natural"="coastline"]{area};'
         f'way["man_made"~"^(breakwater|pier)$"]{area};);out geom;')
    data = urllib.parse.urlencode({"data": q}).encode()
    last: Exception | None = None
    for attempt in range(3):
        for url in list(OVERPASS):
            req = urllib.request.Request(url, data=data,
                                         headers={"User-Agent": "surf-forecast-coastline/1.0"})
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    elements = json.load(resp).get("elements", [])
            except Exception as exc:  # 429/502/504 are common on public Overpass servers
                last = exc
                continue
            OVERPASS.remove(url)  # the server that answered is tried first next time
            OVERPASS.insert(0, url)
            return elements
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"Overpass unavailable ({type(last).__name__}: {last})")


def fetch_ways(lat: float, lon: float, radius_km: float = RADIUS_KM) -> list[dict[str, Any]]:
    dlat = radius_km / 110.57
    dlon = radius_km / (111.32 * math.cos(math.radians(lat)))
    ways: dict[int, dict[str, Any]] = {}
    for i in range(TILES):
        for j in range(TILES):
            s = lat - dlat + 2 * dlat * i / TILES
            w = lon - dlon + 2 * dlon * j / TILES
            for el in _query((s, w, s + 2 * dlat / TILES, w + 2 * dlon / TILES)):
                if el.get("type") == "way" and el.get("geometry"):
                    ways[el["id"]] = el
    return list(ways.values())


def _xy(la: float, lo: float, la0: float, lo0: float) -> tuple[float, float]:
    return ((lo - lo0) * 111.32 * math.cos(math.radians(la0)), (la - la0) * 110.57)


def _ray_hit(dx: float, dy: float, a, b) -> float | None:
    ex, ey = b[0] - a[0], b[1] - a[1]
    den = dx * ey - dy * ex
    if abs(den) < 1e-12:
        return None
    t = (a[0] * ey - a[1] * ex) / den
    u = (a[0] * dy - a[1] * dx) / den
    return t if t > 0 and 0 <= u <= 1 else None


def _diff(a: float, b: float) -> float:
    """Signed a - b in -180..180."""
    return (a - b + 180) % 360 - 180


def analyse(lat: float, lon: float, ways: list[dict[str, Any]],
            normal: int | None = None) -> dict[str, Any]:
    segs = []
    for w in ways:
        kind = w.get("tags", {}).get("natural") or w.get("tags", {}).get("man_made")
        pts = [_xy(p["lat"], p["lon"], lat, lon) for p in w["geometry"]]
        segs += [(kind, a, b) for a, b in zip(pts, pts[1:])]

    sx = sy = 0.0
    for kind, a, b in segs:
        if kind != "coastline" or math.hypot((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) > NORMAL_KM:
            continue
        dx, dy = b[0] - a[0], b[1] - a[1]
        sea = math.atan2(dx, dy) + math.pi / 2  # land on the left -> sea on the right
        length = math.hypot(dx, dy)
        sx += length * math.sin(sea)
        sy += length * math.cos(sea)
    coast_normal = None if sx == sy == 0 else round(math.degrees(math.atan2(sx, sy))) % 360
    n = normal if normal is not None else coast_normal
    if n is None:
        raise ValueError("no coastline within %.1f km: is the point at the beach?" % NORMAL_KM)

    hits: dict[int, tuple[float, str] | None] = {}
    for deg in range(360):
        dx, dy = math.sin(math.radians(deg)), math.cos(math.radians(deg))
        best = None
        for kind, a, b in segs:
            t = _ray_hit(dx, dy, a, b)
            if t is not None and t >= IGNORE_KM and (best is None or t < best[0]):
                best = (t, kind)
        hits[deg] = best

    def is_open(deg: int) -> bool:
        h = hits[deg % 360]
        return h is None or h[0] > OPEN_KM

    lo = hi = n
    while is_open(lo - 1) and _diff(lo - 1, n) >= -90:
        lo -= 1
    while is_open(hi + 1) and _diff(hi + 1, n) <= 90:
        hi += 1
    if not is_open(n):
        lo = hi = None  # something sits right in front of the beach
    return {
        "coast_normal": coast_normal, "normal": n,
        "window_min": None if lo is None else lo % 360,
        "window_max": None if hi is None else hi % 360,
        "blocked_by": {
            "min": hits[(lo - 1) % 360] if lo is not None else None,
            "max": hits[(hi + 1) % 360] if hi is not None else None,
        },
    }


def suggest(lat: float, lon: float, normal: int | None = None) -> dict[str, Any]:
    return analyse(lat, lon, fetch_ways(lat, lon), normal)


def describe(res: dict[str, Any]) -> str:
    def edge(key: str) -> str:
        h = res["blocked_by"][key]
        return "open (beach turns away)" if h is None else f"{h[1]} {h[0]:.1f} km away"
    if res["window_min"] is None:
        return f"normal {res['normal']}°: land or a wall right in front, no open window"
    return (f"beach normal {res['normal']}° (coastline says {res['coast_normal']}°); "
            f"swell window {res['window_min']}°-{res['window_max']}° "
            f"(start: {edge('min')}; end: {edge('max')})")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("lat", type=float)
    ap.add_argument("lon", type=float)
    ap.add_argument("--normal", type=int, help="use this beach normal instead of the coastline's")
    args = ap.parse_args()
    print(describe(suggest(args.lat, args.lon, args.normal)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
