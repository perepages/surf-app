"""Draw and store the water area of a spot's cam (spots.cam_water_area, migration 14).

The area tells the crowd-counting step (not built yet) which part of the image is water, so a
person inside it counts as crowd_water and one outside as crowd_beach. Points are fractions of
the image width/height (0..1, origin top-left), so they don't depend on the image size.

  python -m jobs.cam_area --spot sitges
      downloads Windy's latest DAYLIGHT image of the spot's cam (the URL is used at once and never
      stored) and writes explore_out/cam_areas/sitges.html (gitignored): the image with the stored
      area on top. Click on the image to draw a new outline; the page shows the command to save it.
  python -m jobs.cam_area --spot sitges --points "0.1,0.4 1,0.37 1,0.95 ..."
      the same page, showing these points instead of the stored ones (nothing saved)
  python -m jobs.cam_area --spot sitges --save "0.1,0.4 1,0.37 1,0.95 ..."
      checks the points and stores them for the spot's current cam
  python -m jobs.cam_area --all            a page for every active spot with a cam
  add --current to use the current image instead of the daylight one (dark at night)

Standard library only. Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WINDY_API_KEY in .env.
"""
from __future__ import annotations

import argparse
import base64
import html
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

from jobs.check_connections import ROOT, env, load_dotenv
from jobs.collect_forecast import HttpError, Supabase, http

WINDY_URL = "https://api.windy.com/webcams/api/v3/webcams"
OUT = ROOT / "explore_out" / "cam_areas"
MIN_POINTS, MAX_POINTS = 3, 40
Point = tuple[float, float]


# ---------- area helpers (also for the future counting step) ----------

def parse_points(text: str) -> list[Point]:
    """'x,y x,y ...' (or a JSON list of pairs) -> [(x, y)], each 0..1. Raises ValueError."""
    text = text.strip()
    if text.startswith("["):
        raw = json.loads(text)
    else:
        raw = [p.split(",") for p in text.replace(";", " ").split()]
    pts = []
    for p in raw:
        if len(p) != 2:
            raise ValueError(f"point {p!r}: need x,y")
        x, y = float(p[0]), float(p[1])
        if not (0 <= x <= 1 and 0 <= y <= 1):
            raise ValueError(f"point {x},{y}: x and y must be between 0 and 1")
        pts.append((round(x, 4), round(y, 4)))
    if not MIN_POINTS <= len(pts) <= MAX_POINTS:
        raise ValueError(f"need {MIN_POINTS}-{MAX_POINTS} points, got {len(pts)}")
    if share_of_image(pts) < 0.001:
        raise ValueError("the outline has (almost) no area")
    return pts


def share_of_image(points: list[Point]) -> float:
    """Polygon area as a share of the whole image (shoelace formula)."""
    s = 0.0
    for (x1, y1), (x2, y2) in zip(points, points[1:] + points[:1]):
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def inside(x: float, y: float, points: list[Point]) -> bool:
    """Is (x, y) (same 0..1 units) inside the polygon? Ray casting."""
    hit = False
    for (x1, y1), (x2, y2) in zip(points, points[1:] + points[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def area_for(spot: dict[str, Any]) -> list[Point] | None:
    """The spot's water area, only if it was drawn on the cam the spot uses now."""
    a = spot.get("cam_water_area")
    if not isinstance(a, dict) or not spot.get("windy_cam_id") or a.get("cam_id") != spot["windy_cam_id"]:
        return None
    try:
        return [(float(x), float(y)) for x, y in a["points"]]
    except (KeyError, TypeError, ValueError):
        return None


# ---------- page ----------

def fetch_image(cam_id: str, key: str, current: bool) -> tuple[bytes, str, str]:
    """(jpeg bytes, which image, when Windy last updated). URL used at once, never stored."""
    d = http(f"{WINDY_URL}/{urllib.parse.quote(cam_id)}?include=images", {"x-windy-api-key": key}) or {}
    images = d.get("images") or {}
    kind = "current" if current or not images.get("daylight") else "daylight"
    url = (images.get(kind) or {}).get("preview")
    if not url:
        raise RuntimeError(f"Windy gave no image for cam {cam_id}")
    with urllib.request.urlopen(url, timeout=30) as resp:
        return resp.read(), kind, d.get("lastUpdatedOn") or "?"


PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Cam Water Area</title>
<style>
:root{--bg:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--line:#e4e3df}
@media (prefers-color-scheme:dark){:root{--bg:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--line:#33332f}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:20px 16px}
.wrap{position:relative;width:100%;max-width:920px;cursor:crosshair;user-select:none}
.wrap img{display:block;width:100%;image-rendering:pixelated}
svg{position:absolute;inset:0;width:100%;height:100%}
.old{fill:rgba(255,212,0,.22);stroke:#ffd400;stroke-width:.005}
.new{fill:rgba(235,104,52,.30);stroke:#eb6834;stroke-width:.004}
circle{fill:#eb6834}
code,textarea{font:13px ui-monospace,monospace}textarea{width:100%;height:4.5em;background:var(--bg);color:var(--ink);border:1px solid var(--line)}
button{font:inherit;padding:4px 12px;margin-right:6px}.note{color:var(--ink2)}
</style></head><body><main>
<h1>__TITLE__</h1>
<p class="note">__INFO__</p>
<p>Yellow = stored area (__OLDSHARE__ of the image). Click on the image to draw a new outline
(orange), point by point around the water; it closes on its own. Then copy the command.</p>
<div class="wrap" id="wrap"><img src="data:image/jpeg;base64,__IMG__" alt="cam image">
<svg viewBox="0 0 1 1" preserveAspectRatio="none">
<polygon class="old" points="__OLD__"/><polygon class="new" id="poly" points=""/><g id="dots"></g></svg></div>
<p><button id="undo">Undo point</button><button id="clear">Clear</button>
<span id="share" class="note"></span></p>
<textarea id="cmd" readonly placeholder="the save command appears here"></textarea>
</main><script>
const spot="__SPOT__", pts=[], wrap=document.getElementById('wrap');
function draw(){
  const s=pts.map(p=>p.join(',')).join(' ');
  document.getElementById('poly').setAttribute('points',s);
  document.getElementById('dots').innerHTML=pts.map(p=>`<circle cx="${p[0]}" cy="${p[1]}" r=".006"/>`).join('');
  let a=0;pts.forEach((p,i)=>{const q=pts[(i+1)%pts.length];a+=p[0]*q[1]-q[0]*p[1]});
  document.getElementById('share').textContent=pts.length>2?`${(Math.abs(a)/2*100).toFixed(1)}% of the image`:'';
  document.getElementById('cmd').value=pts.length>2?`python -m jobs.cam_area --spot ${spot} --save "${s}"`:'';
}
wrap.addEventListener('click',e=>{const r=wrap.getBoundingClientRect();
  pts.push([+((e.clientX-r.left)/r.width).toFixed(3),+((e.clientY-r.top)/r.height).toFixed(3)]);draw()});
document.getElementById('undo').onclick=()=>{pts.pop();draw()};
document.getElementById('clear').onclick=()=>{pts.length=0;draw()};
</script></body></html>"""


def write_page(spot: dict[str, Any], points: list[Point] | None, img: bytes, kind: str, updated: str) -> str:
    OUT.mkdir(parents=True, exist_ok=True)
    share = share_of_image(points) if points else 0.0
    info = (f"Cam {spot['windy_cam_id']} · Windy {kind} image, last updated {updated} · "
            f"local only, don't publish (Windy image).")
    page = (PAGE.replace("__TITLE__", html.escape(f"{spot['name']}: water area"))
            .replace("__INFO__", html.escape(info))
            .replace("__OLDSHARE__", f"{share * 100:.1f}%" if points else "none drawn")
            .replace("__OLD__", " ".join(f"{x},{y}" for x, y in points or []))
            .replace("__IMG__", base64.b64encode(img).decode())
            .replace("__SPOT__", html.escape(spot["id"])))
    path = OUT / f"{spot['id']}.html"
    path.write_text(page, encoding="utf-8")
    return str(path)


# ---------- main ----------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    which = parser.add_mutually_exclusive_group(required=True)
    which.add_argument("--spot", help="spot id")
    which.add_argument("--all", action="store_true", help="every active spot with a cam")
    parser.add_argument("--points", help="show these points instead of the stored ones")
    parser.add_argument("--save", metavar="POINTS", help="store these points for the spot")
    parser.add_argument("--current", action="store_true", help="current image, not daylight")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    load_dotenv(ROOT / ".env")
    url, key, windy = env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), env("WINDY_API_KEY")
    if not (url and key):
        print("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in .env")
        return 1
    db = Supabase(url, key)
    query = ("select=id,name,windy_cam_id,cam_water_area&order=id"
             + (f"&id=eq.{urllib.parse.quote(args.spot)}" if args.spot
                else "&active=eq.true&windy_cam_id=not.is.null"))
    try:
        spots = http(f"{db.base}/spots?{query}", db.headers) or []
    except HttpError as exc:
        if "cam_water_area" not in str(exc):
            raise
        print("Note: the column spots.cam_water_area is missing; apply migration "
              "20261122000014_cam_water_area.sql in the Supabase SQL editor.")
        if args.save:
            return 1
        spots = http(f"{db.base}/spots?{query.replace(',cam_water_area', '')}", db.headers) or []
    if not spots:
        print("No matching spot.")
        return 1

    try:
        given = parse_points(args.points or args.save) if (args.points or args.save) else None
    except (ValueError, json.JSONDecodeError) as exc:
        print(f"Bad points: {exc}")
        return 1

    if args.save:
        spot = spots[0]
        if args.all or not spot.get("windy_cam_id"):
            print("--save needs --spot with a cam (spots.windy_cam_id).")
            return 1
        area = {"cam_id": spot["windy_cam_id"], "image": [400, 224],
                "drawn_at": datetime.now(timezone.utc).date().isoformat(),
                "points": [list(p) for p in given]}
        http(f"{db.base}/spots?id=eq.{urllib.parse.quote(spot['id'])}",
             {**db.headers, "Prefer": "return=minimal"}, method="PATCH", body={"cam_water_area": area})
        print(f"Saved: {len(given)} points, {share_of_image(given) * 100:.1f}% of the image, "
              f"for cam {spot['windy_cam_id']}.")
        return 0

    if not windy:
        print("WINDY_API_KEY not set in .env")
        return 1
    for spot in spots:
        if not spot.get("windy_cam_id"):
            print(f"{spot['id']}: no cam.")
            continue
        points = given if given else area_for(spot)
        stale = spot.get("cam_water_area") and not area_for(spot)
        img, kind, updated = fetch_image(spot["windy_cam_id"], windy, args.current)
        path = write_page(spot, points, img, kind, updated)
        note = " (stored area was drawn on another cam: ignored)" if stale and not given else ""
        share = f"{share_of_image(points) * 100:.1f}% of the image" if points else "no area"
        print(f"{spot['id']}: {share}{note} -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
