"""Explore the collected data: where is the forecast wrong? Nothing is trained or written to Supabase.

For every active spot (or --spot ID) this reads `forecasts`, `observations` (buoys),
`snapshots` (crowd counts) and `ratings` (hidden ones skipped), joins them per UTC hour, and
writes to explore_out/<spot>/ (gitignored, LOCAL ONLY):

  report.html            all plots + tables + the plain-words summary; open it in a browser
  forecast_vs_buoy.svg   forecast wave height vs buoy Hm0, over time and as a scatter
  score_vs_rating.svg    simple 1-5 score (same rules as the app) vs what surfers rated
  error_by_wind.svg      errors grouped by forecast wind direction (calm < 10 km/h apart)
  error_by_tide.svg      errors grouped by forecast sea level (low / mid / high third)
  hours.csv              one row per (hour, buoy): forecast + buoy + crowd
  ratings.csv            one row per rating: forecast at that hour, simple score, crowd

The outputs contain raw PORTUS buoy data: TRAINING ONLY, never publish them.

Errors are always "forecast minus reality":
  wave error  = forecast wave_height - buoy Hm0      (+ = forecast says bigger than measured)
  score error = simple score - surfer's overall       (+ = forecast says better than it was)

Joining:
  forecast for an hour = the live row with the shortest lead (fetched_at <= valid_at); else a
      'historical:best_match' row (past sessions, lead 0); else, with --past-days N (default 3),
      Open-Meteo's recent past at the spot, fetched now and NOT stored (Open-Meteo stitches
      its latest model runs, so it's close to a short-lead forecast). `fc_source` says which.
  buoy  = the reading at that exact hour (PORTUS is hourly), per buoy.
  crowd = the snapshot nearest the hour, within 60 min.
  rating hour = surfed_at rounded to the nearest hour; duplicates (same device + surfed_at)
      count once.

Caveats it can't fix: the buoys are 40-60 km away in deeper water than the beach, so the wave
error mixes "model wrong" with "beach is different from the buoy". Mediterranean tide is only
~10-20 cm; most of sea_level_height is storm surge (pressure + wind), so "tide" here is mostly
surge.

Run from the repo root (needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env):
  python -m jobs.explore                  # all active spots, + 3 days of Open-Meteo past
  python -m jobs.explore --spot vilanova --past-days 0   # database rows only
Standard library only. Weather data by Open-Meteo.com.
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import math
import random
import sys
import urllib.parse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean
from typing import Any, Callable

from jobs.check_connections import ROOT, env, load_dotenv
from jobs.collect_forecast import MARINE_URL, WEATHER_URL, Supabase, http

OUT_DIR = ROOT / "explore_out"
PAGE = 1000  # PostgREST returns at most 1000 rows per request
HISTORICAL = "historical:best_match"
MIN_N = 10   # below this many points a group's mean is shown but called "too few to trust"

UTC = timezone.utc
Row = dict[str, Any]


# ---------- reading ----------

def fetch_all(db: Supabase, table: str, query: str) -> list[Row]:
    rows: list[Row] = []
    while True:
        batch = http(f"{db.base}/{table}?{query}&limit={PAGE}&offset={len(rows)}", db.headers) or []
        rows += batch
        if len(batch) < PAGE:
            return rows


def ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def round_hour(dt: datetime) -> datetime:
    return (dt + timedelta(minutes=30)).replace(minute=0, second=0, microsecond=0)


def open_meteo_past(spot: Row, days: int) -> list[Row]:
    """Recent past hours at the spot from Open-Meteo, shaped like `forecasts` rows. Not stored."""
    if days <= 0:
        return []
    base = {"latitude": spot["lat"], "longitude": spot["lon"], "timezone": "UTC",
            "past_days": days, "forecast_days": 1}
    marine = http(MARINE_URL + "?" + urllib.parse.urlencode({**base, "hourly":
                  "wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,"
                  "swell_wave_direction,sea_level_height_msl"}))["hourly"]
    wind = http(WEATHER_URL + "?" + urllib.parse.urlencode({**base, "hourly":
                "wind_speed_10m,wind_direction_10m"}))["hourly"]
    wind_by_time = {t: i for i, t in enumerate(wind["time"])}
    now = datetime.now(UTC)
    rows = []
    for i, t in enumerate(marine["time"]):
        valid = datetime.strptime(t, "%Y-%m-%dT%H:%M").replace(tzinfo=UTC)
        if valid > now:
            continue
        j = wind_by_time.get(t)
        rows.append({
            "valid_at": valid, "lead_hours": None, "fc_source": "open-meteo past (not stored)",
            "wave_height": marine["wave_height"][i], "wave_period": marine["wave_period"][i],
            "wave_direction": marine["wave_direction"][i],
            "swell_wave_height": marine["swell_wave_height"][i],
            "swell_wave_period": marine["swell_wave_period"][i],
            "swell_wave_direction": marine["swell_wave_direction"][i],
            "sea_level_height": marine["sea_level_height_msl"][i],
            "wind_speed": None if j is None else wind["wind_speed_10m"][j],
            "wind_direction": None if j is None else wind["wind_direction_10m"][j],
        })
    return rows


def best_forecast_per_hour(db_rows: list[Row], past_rows: list[Row]) -> dict[datetime, Row]:
    """Shortest-lead live row, else historical row, else Open-Meteo past (see module doc)."""
    best: dict[datetime, Row] = {}

    def rank(r: Row) -> tuple[int, int]:
        if r["fc_source"] == "live":
            return (0, r["lead_hours"])
        return (1, 0) if r["fc_source"] == HISTORICAL else (2, 0)

    for r in db_rows + past_rows:
        if r["fc_source"] == "live" and (r["lead_hours"] is None or r["lead_hours"] < 0):
            continue
        cur = best.get(r["valid_at"])
        if cur is None or rank(r) < rank(cur):
            best[r["valid_at"]] = r
    return best


# ---------- simple score (Python copy of web/src/scoring/simpleScore.ts; keep in sync) ----------

FLAT_BELOW = 0.25
SIZE_STEPS = [(1.3, 5), (0.8, 4), (0.45, 3), (0.0, 2)]
COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def angle_diff(a: float, b: float) -> float:
    return abs((((a - b) % 360) + 540) % 360 - 180)


def compass(deg: float) -> str:
    return COMPASS[round((deg % 360) / 45) % 8]


def wind_relation(wind_from: float, beach_faces: float) -> str:
    d = angle_diff(wind_from, (beach_faces + 180) % 360)
    return "offshore" if d <= 45 else "onshore" if d >= 135 else "cross"


def exposure(wave_from: float | None, beach_faces: float) -> float:
    if wave_from is None:
        return 1.0
    d = angle_diff(wave_from, beach_faces)
    if d <= 45:
        return 1.0
    if d <= 90:
        return 1 - ((d - 45) / 45) * 0.6
    return 0.15


def first(*values: Any) -> Any:
    return next((v for v in values if v is not None), None)


def simple_score(f: Row, beach_faces: float) -> int:
    height = first(f.get("wave_height"), f.get("swell_wave_height"), 0.0)
    period = first(f.get("swell_wave_period"), f.get("wave_period"), 0.0)
    wave_from = first(f.get("wave_direction"), f.get("swell_wave_direction"))
    wind = first(f.get("wind_speed"), 0.0)
    rel = "cross" if f.get("wind_direction") is None else wind_relation(f["wind_direction"], beach_faces)

    effective = height * exposure(wave_from, beach_faces)
    if height < FLAT_BELOW or effective < FLAT_BELOW:
        return 1
    base = next(score for minimum, score in SIZE_STEPS if effective >= minimum)
    period_adj = -1 if 0 < period < 5 else 1 if period >= 8 else 0
    wind_adj = 0
    if wind >= 10:
        if rel == "offshore":
            wind_adj = -1 if wind > 35 else 1 if wind <= 25 else 0
        elif rel == "cross":
            wind_adj = -2 if wind >= 30 else -1 if wind >= 15 else 0
        else:
            wind_adj = -2 if wind >= 22 else -1 if wind >= 12 else 0
    bonus = min(1, max(0, period_adj) + max(0, wind_adj))
    penalty = min(0, period_adj) + min(0, wind_adj)
    # JS Math.round rounds .5 up; total is an int here anyway.
    return min(5, max(1, base + bonus + penalty))


# ---------- grouping ----------

def wind_group(f: Row | None, beach_faces: float) -> str | None:
    if not f or f.get("wind_direction") is None or f.get("wind_speed") is None:
        return None
    if f["wind_speed"] < 10:
        return "calm (<10 km/h)"
    return f"{compass(f['wind_direction'])} ({wind_relation(f['wind_direction'], beach_faces)})"


WIND_ORDER = ["calm (<10 km/h)"] + [c for c in COMPASS]


def wind_sort_key(label: str) -> int:
    head = label.split(" ")[0]
    return 0 if label.startswith("calm") else 1 + COMPASS.index(head)


def tide_cuts(values: list[float]) -> tuple[float, float] | None:
    vals = sorted(v for v in values if v is not None)
    if len(vals) < 3:
        return None
    return vals[len(vals) // 3], vals[(2 * len(vals)) // 3]


def tide_group(level: float | None, cuts: tuple[float, float] | None) -> str | None:
    if level is None or cuts is None:
        return None
    lo, hi = cuts
    if level < lo:
        return f"low (< {lo * 100:.0f} cm)"
    if level < hi:
        return f"mid ({lo * 100:.0f} to {hi * 100:.0f} cm)"
    return f"high (>= {hi * 100:.0f} cm)"


def tide_sort_key(label: str) -> int:
    return {"low": 0, "mid": 1, "high": 2}[label.split(" ")[0]]


def group_errors(items: list[tuple[str | None, str, float]]) -> dict[str, dict[str, list[float]]]:
    """[(group, series, error)] -> {group: {series: [errors]}}, skipping None groups."""
    out: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for group, series, err in items:
        if group is not None and err is not None:
            out[group][series].append(err)
    return out


# ---------- SVG (hand-made, so no plotting library is needed) ----------

# Categorical slots 1-3 of the dataviz reference palette (validated all-pairs, light + dark).
STYLE = """<style>
.c{--bg:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--grid:#e4e3df;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a}
@media (prefers-color-scheme:dark){.c{--bg:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#33332f;--s1:#3987e5;--s2:#d95926;--s3:#199e70}}
.c text{font:12px system-ui,sans-serif;fill:var(--ink2)} .c .t{font-size:14px;font-weight:600;fill:var(--ink)}
.c .grid{stroke:var(--grid);stroke-width:1} .c .axis{stroke:var(--ink2);stroke-width:1}
.c .ref{stroke:var(--ink2);stroke-width:1;stroke-dasharray:4 4;fill:none}
.c .s1{stroke:var(--s1);fill:var(--s1)} .c .s2{stroke:var(--s2);fill:var(--s2)} .c .s3{stroke:var(--s3);fill:var(--s3)}
.c .line{fill:none;stroke-width:2} .c .dot{stroke:var(--bg);stroke-width:2}
.c .empty{font-size:13px;fill:var(--ink2)}
</style>"""


def esc(s: Any) -> str:
    return html.escape(str(s), quote=True)


def nice_ticks(lo: float, hi: float, n: int = 5) -> list[float]:
    if hi <= lo:
        hi = lo + 1
    raw = (hi - lo) / n
    mag = 10 ** math.floor(math.log10(raw))
    step = next(m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw)
    start = math.floor(lo / step) * step
    ticks, v = [], start
    while v <= hi + step * 0.001:
        ticks.append(round(v, 10))
        v += step
    return ticks


class Panel:
    """One plot area inside an SVG: maps data to pixels and draws axes."""

    def __init__(self, x0: float, y0: float, w: float, h: float,
                 xr: tuple[float, float], yr: tuple[float, float]) -> None:
        self.x0, self.y0, self.w, self.h = x0, y0, w, h
        self.xr, self.yr = xr, yr

    def x(self, v: float) -> float:
        return self.x0 + (v - self.xr[0]) / (self.xr[1] - self.xr[0]) * self.w

    def y(self, v: float) -> float:
        return self.y0 + self.h - (v - self.yr[0]) / (self.yr[1] - self.yr[0]) * self.h

    def axes(self, yticks: list[float], ylabel: str, xticks: list[tuple[float, str]],
             xlabel: str, yfmt: Callable[[float], str] = lambda v: f"{v:g}") -> list[str]:
        p = []
        for t in yticks:
            p.append(f'<line class="grid" x1="{self.x0}" x2="{self.x0 + self.w}" y1="{self.y(t):.1f}" y2="{self.y(t):.1f}"/>')
            p.append(f'<text x="{self.x0 - 6}" y="{self.y(t) + 4:.1f}" text-anchor="end">{esc(yfmt(t))}</text>')
        p.append(f'<line class="axis" x1="{self.x0}" x2="{self.x0 + self.w}" y1="{self.y0 + self.h}" y2="{self.y0 + self.h}"/>')
        for v, label in xticks:
            p.append(f'<text x="{self.x(v):.1f}" y="{self.y0 + self.h + 16}" text-anchor="middle">{esc(label)}</text>')
        p.append(f'<text x="{self.x0 + self.w / 2}" y="{self.y0 + self.h + 34}" text-anchor="middle">{esc(xlabel)}</text>')
        p.append(f'<text transform="translate({self.x0 - 44},{self.y0 + self.h / 2}) rotate(-90)" text-anchor="middle">{esc(ylabel)}</text>')
        return p


def svg(width: int, height: int, title: str, parts: list[str]) -> str:
    return (f'<svg class="c" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
            f'width="{width}" height="{height}" role="img" aria-label="{esc(title)}">{STYLE}'
            f'<rect width="100%" height="100%" fill="var(--bg)"/>'
            f'<text class="t" x="16" y="24">{esc(title)}</text>{"".join(parts)}</svg>')


def legend(x: float, y: float, entries: list[tuple[str, str]]) -> list[str]:
    p = []
    for cls, label in entries:
        p.append(f'<rect class="{cls}" x="{x}" y="{y - 9}" width="10" height="10" rx="2"/>')
        p.append(f'<text x="{x + 15}" y="{y}">{esc(label)}</text>')
        x += 24 + 7 * len(label)
    return p


def empty_note(panel: Panel, text: str) -> str:
    return (f'<text class="empty" x="{panel.x0 + panel.w / 2}" y="{panel.y0 + panel.h / 2}" '
            f'text-anchor="middle">{esc(text)}</text>')


BUOY_CLASS = ["s2", "s3"]  # forecast is s1


def plot_forecast_vs_buoy(hours: list[Row], buoys: list[str]) -> str:
    W, H = 980, 420
    pts = [r for r in hours if r["buoy_hm0"] is not None and r["fc_wave_height"] is not None]
    times = sorted({r["hour"] for r in hours if r["fc_wave_height"] is not None or r["buoy_hm0"] is not None})
    vals = [v for r in hours for v in (r["fc_wave_height"], r["buoy_hm0"]) if v is not None]
    top = max(vals + [0.5]) * 1.1
    yt = nice_ticks(0, top)
    parts: list[str] = []

    # Left: over time.
    t0, t1 = (times[0], times[-1]) if times else (datetime.now(UTC), datetime.now(UTC) + timedelta(hours=1))
    span = max((t1 - t0).total_seconds(), 3600)
    a = Panel(60, 60, 520, 290, (0, span), (0, yt[-1]))
    xt = []
    day = t0.replace(hour=0, minute=0, second=0, microsecond=0)
    while day <= t1:
        if day >= t0:
            xt.append(((day - t0).total_seconds(), day.strftime("%d %b")))
        day += timedelta(days=1)
    parts += a.axes(yt, "wave height (m)", xt, "time (UTC)")
    sx = lambda t: (t - t0).total_seconds()
    series = [("s1", "forecast at the spot", {r["hour"]: r["fc_wave_height"] for r in hours})]
    for i, b in enumerate(buoys[:2]):
        series.append((BUOY_CLASS[i], f"buoy {b}", {r["hour"]: r["buoy_hm0"] for r in hours if r["buoy_id"] == b}))
    for cls, name, data in series:
        segs, cur = [], []
        for t in times:  # break the line where an hour is missing
            v = data.get(t)
            if v is None:
                if cur:
                    segs.append(cur)
                cur = []
            else:
                cur.append(f"{a.x(sx(t)):.1f},{a.y(v):.1f}")
        if cur:
            segs.append(cur)
        for s in segs:
            if len(s) == 1:
                x_, y_ = s[0].split(",")
                parts.append(f'<circle class="{cls} dot" cx="{x_}" cy="{y_}" r="4"><title>{esc(name)}</title></circle>')
            else:
                parts.append(f'<polyline class="{cls} line" points="{" ".join(s)}"><title>{esc(name)}</title></polyline>')
    if not times:
        parts.append(empty_note(a, "no forecast or buoy hours yet"))
    parts += legend(60, 46, [(c, n) for c, n, _ in series])

    # Right: scatter, forecast (x) vs buoy (y), y = x reference.
    b = Panel(680, 60, 270, 290, (0, yt[-1]), (0, yt[-1]))
    parts += b.axes(yt, "buoy Hm0 (m)", [(t, f"{t:g}") for t in yt], "forecast at the spot (m)")
    parts.append(f'<line class="ref" x1="{b.x(0)}" y1="{b.y(0)}" x2="{b.x(yt[-1])}" y2="{b.y(yt[-1])}"/>')
    parts.append(f'<text x="{b.x(yt[-1]) - 4}" y="{b.y(yt[-1]) + 14}" text-anchor="end">perfect</text>')
    for r in pts:
        cls = BUOY_CLASS[buoys.index(r["buoy_id"])] if r["buoy_id"] in buoys[:2] else "s2"
        tip = f"{r['hour']:%d %b %H:%M} UTC, buoy {r['buoy_id']}: forecast {r['fc_wave_height']:.2f} m, buoy {r['buoy_hm0']:.2f} m"
        parts.append(f'<circle class="{cls} dot" cx="{b.x(r["fc_wave_height"]):.1f}" '
                     f'cy="{b.y(r["buoy_hm0"]):.1f}" r="4"><title>{esc(tip)}</title></circle>')
    if not pts:
        parts.append(empty_note(b, "no matching hours"))
    return svg(W, H, "Forecast wave height vs buoy measurement", parts)


def plot_score_vs_rating(ratings: list[Row]) -> str:
    W, H = 520, 420
    p = Panel(70, 60, 400, 290, (0.5, 5.5), (0.5, 5.5))
    ticks = [1, 2, 3, 4, 5]
    parts = p.axes(ticks, "surfers' rating (1-5)", [(t, str(t)) for t in ticks], "simple forecast score (1-5)")
    parts.append(f'<line class="ref" x1="{p.x(0.5)}" y1="{p.y(0.5)}" x2="{p.x(5.5)}" y2="{p.y(5.5)}"/>')
    parts.append(f'<text x="{p.x(5.4)}" y="{p.y(5.4) + 14}" text-anchor="end">perfect</text>')
    sources = ["community", "me", "past_session"]
    rng = random.Random(1)  # fixed jitter so reruns draw the same picture
    usable = [r for r in ratings if r["simple_score"] is not None]
    for r in usable:
        cls = f"s{sources.index(r['source']) + 1}" if r["source"] in sources else "s1"
        jx, jy = rng.uniform(-0.18, 0.18), rng.uniform(-0.18, 0.18)
        tip = f"{r['surfed_at']:%Y-%m-%d %H:%M} UTC ({r['source']}): score {r['simple_score']}, rated {r['overall']}"
        parts.append(f'<circle class="{cls} dot" cx="{p.x(r["simple_score"] + jx):.1f}" '
                     f'cy="{p.y(r["overall"] + jy):.1f}" r="5"><title>{esc(tip)}</title></circle>')
    if not usable:
        parts.append(empty_note(p, "no ratings with a forecast yet"))
    parts += legend(70, 46, [("s1", "community"), ("s2", "me"), ("s3", "past session")])
    return svg(W, H, "Simple score vs surfers' rating (dots jittered)", parts)


def plot_grouped_bars(title: str, panels: list[tuple[str, str, dict[str, dict[str, list[float]]], list[tuple[str, str]], Callable[[str], int]]]) -> str:
    """Each panel: (heading, unit, {group: {series: errors}}, [(series, css class)], sort key)."""
    W, PH = 980, 250
    H = 50 + PH * len(panels)
    parts: list[str] = []
    for k, (heading, unit, groups, series, key) in enumerate(panels):
        top = 50 + k * PH
        names = sorted(groups, key=key)
        means = [mean(v) for g in groups.values() for v in g.values() if v]
        lim = max([abs(m) for m in means] + [0.1]) * 1.25
        yt = nice_ticks(-lim, lim, 4)
        p = Panel(70, top + 34, 880, PH - 100, (0, max(len(names), 1)), (yt[0], yt[-1]))
        parts.append(f'<text class="t" x="16" y="{top + 18}">{esc(heading)}</text>')
        parts += legend(500, top + 18, [(c, s) for s, c in series])
        xt = [(i + 0.5, n) for i, n in enumerate(names)]
        parts += p.axes(yt, unit, xt, "", yfmt=lambda v: f"{v:+g}" if v else "0")
        parts.append(f'<line class="axis" x1="{p.x0}" x2="{p.x0 + p.w}" y1="{p.y(0):.1f}" y2="{p.y(0):.1f}"/>')
        bw = min(36, 0.8 / max(len(series), 1) * p.w / max(len(names), 1))
        for i, n in enumerate(names):
            for j, (s, cls) in enumerate(series):
                errs = groups[n].get(s) or []
                if not errs:
                    continue
                m = mean(errs)
                cx = p.x(i + 0.5) + (j - (len(series) - 1) / 2) * (bw + 2)
                y1, y2 = sorted((p.y(0), p.y(m)))
                tip = f"{n}, {s}: mean error {m:+.2f} {unit.split(' ')[-1]} from {len(errs)} points"
                parts.append(f'<rect class="{cls}" x="{cx - bw / 2:.1f}" y="{y1:.1f}" width="{bw:.1f}" '
                             f'height="{max(y2 - y1, 1):.1f}" rx="3"><title>{esc(tip)}</title></rect>')
                label_y = p.y(m) - 5 if m >= 0 else p.y(m) + 14
                weak = "" if len(errs) >= MIN_N else "?"
                parts.append(f'<text x="{cx:.1f}" y="{label_y:.1f}" text-anchor="middle">n={len(errs)}{weak}</text>')
        if not names:
            parts.append(empty_note(p, "no data yet"))
        parts.append(f'<text x="{p.x0 + p.w}" y="{p.y0 - 4}" text-anchor="end">+ = forecast too high · ? = fewer than {MIN_N} points</text>')
    return svg(W, H, title, parts)


# ---------- summary in plain words ----------

def describe_groups(groups: dict[str, dict[str, list[float]]], series: str, unit: str,
                    what: str) -> list[str]:
    rows = [(g, s[series]) for g, s in groups.items() if s.get(series)]
    if not rows:
        return [f"- {what}: no data yet."]
    rows.sort(key=lambda r: abs(mean(r[1])), reverse=True)
    out = []
    for g, errs in rows[:3]:
        m = mean(errs)
        n = len(errs)
        trust = "" if n >= MIN_N else f" (only {n} point{'s' if n > 1 else ''}, don't trust it yet)"
        if abs(m) < (0.02 if unit == "m" else 0.1):
            out.append(f"- {what}, {g}: forecast about right on average{trust}.")
        else:
            direction = "too high" if m > 0 else "too low"
            out.append(f"- {what}, {g}: forecast {direction} by {abs(m):.2f} {unit} on average{trust}.")
    return out


def summarise(spot: Row, hours: list[Row], ratings: list[Row], buoys: list[str],
              wind_wave: dict, tide_wave: dict, wind_score: dict, tide_score: dict) -> list[str]:
    lines = [f"Where the forecast is wrong at {spot['name']}"]
    for b in buoys:
        errs = [r["fc_wave_height"] - r["buoy_hm0"] for r in hours
                if r["buoy_id"] == b and r["buoy_hm0"] is not None and r["fc_wave_height"] is not None]
        if not errs:
            lines.append(f"- Buoy {b}: no hours where both forecast and buoy exist.")
            continue
        bias, mae = mean(errs), mean(abs(e) for e in errs)
        word = "bigger" if bias > 0 else "smaller"
        lines.append(f"- Buoy {b}: over {len(errs)} hours the spot forecast was {abs(bias):.2f} m "
                     f"{word} than the buoy on average (typical miss {mae:.2f} m).")
    for b in buoys:
        lines += describe_groups(wind_wave, f"buoy {b}", "m", f"Waves vs buoy {b} by wind")
        lines += describe_groups(tide_wave, f"buoy {b}", "m", f"Waves vs buoy {b} by sea level")
    scored = [r for r in ratings if r["simple_score"] is not None]
    if scored:
        errs = [r["simple_score"] - r["overall"] for r in scored]
        lines.append(f"- Score vs surfers: {len(scored)} ratings, simple score off by "
                     f"{mean(abs(e) for e in errs):.1f} points on average "
                     f"({'too optimistic' if mean(errs) > 0 else 'too pessimistic' if mean(errs) < 0 else 'no bias'})"
                     + ("" if len(scored) >= MIN_N else f"; only {len(scored)} ratings, far too few to trust") + ".")
    else:
        lines.append("- Score vs surfers: no ratings with a forecast for that hour yet.")
    lines += describe_groups(wind_score, "simple score", "points", "Score by wind")
    lines += describe_groups(tide_score, "simple score", "points", "Score by sea level")
    return lines


# ---------- per spot ----------

def fmt(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%dT%H:%M:%SZ")
    if isinstance(v, float):
        return round(v, 3)
    return "" if v is None else v


def write_csv(path: Path, rows: list[Row]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        for r in rows:
            w.writerow({k: fmt(v) for k, v in r.items()})


def html_table(rows: list[Row], cols: list[str]) -> str:
    head = "".join(f"<th>{esc(c)}</th>" for c in cols)
    body = "".join("<tr>" + "".join(f"<td>{esc(fmt(r.get(c)))}</td>" for c in cols) + "</tr>" for r in rows)
    return f'<div class="tw"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def explore_spot(db: Supabase, spot: Row, past_days: int) -> list[str]:
    sid = spot["id"]
    faces = spot["beach_orientation"]
    buoys = list(spot.get("buoy_ids") or [])

    fc_cols = ("valid_at,lead_hours,marine_model,wave_height,wave_period,wave_direction,"
               "swell_wave_height,swell_wave_period,swell_wave_direction,sea_level_height,"
               "wind_speed,wind_direction")
    db_fc = fetch_all(db, "forecasts", f"select={fc_cols}&spot_id=eq.{sid}&order=valid_at,fetched_at")
    for r in db_fc:
        r["valid_at"] = ts(r["valid_at"])
        r["fc_source"] = HISTORICAL if r.get("marine_model") == HISTORICAL else "live"
    try:
        past = open_meteo_past(spot, past_days)
    except Exception as exc:
        print(f"  WARN  Open-Meteo past failed ({type(exc).__name__}: {exc}); using database rows only")
        past = []
    forecast = best_forecast_per_hour(db_fc, past)

    obs = fetch_all(db, "observations", f"select=buoy_id,observed_at,wave_height,wave_period,"
                    f"wave_direction,wind_speed,wind_direction&spot_id=eq.{sid}&order=observed_at")
    snaps = fetch_all(db, "snapshots", f"select=taken_at,crowd_water,crowd_beach,quality&spot_id=eq.{sid}&order=taken_at")
    for s in snaps:
        s["taken_at"] = ts(s["taken_at"])
    ratings_raw = fetch_all(db, "ratings", "select=id,surfed_at,overall,wave_size,surface,crowd,source,"
                            f"device_id,forecast_shown&spot_id=eq.{sid}&hidden=eq.false&order=surfed_at")

    def crowd_near(t: datetime) -> Row:
        best = min(snaps, key=lambda s: abs((s["taken_at"] - t).total_seconds()), default=None)
        if best is None or abs((best["taken_at"] - t).total_seconds()) > 3600:
            return {}
        return best

    # hours.csv: one row per (hour, buoy); hours without any buoy reading get one row with buoy empty.
    obs_by = {(ts(o["observed_at"]), o["buoy_id"]): o for o in obs}
    all_hours = sorted(set(forecast) | {t for t, _ in obs_by})
    if obs_by:  # keep the window where buoys exist (+ a margin), not 4 days of future forecast
        first_obs = min(t for t, _ in obs_by)
        last_obs = max(t for t, _ in obs_by)
        all_hours = [t for t in all_hours if first_obs - timedelta(hours=6) <= t <= last_obs]
    else:
        now = datetime.now(UTC)
        all_hours = [t for t in all_hours if t <= now]

    hours: list[Row] = []
    for t in all_hours:
        f = forecast.get(t) or {}
        crowd = crowd_near(t)
        base = {
            "hour": t, "fc_source": f.get("fc_source"), "fc_lead_hours": f.get("lead_hours"),
            "fc_wave_height": f.get("wave_height"), "fc_wave_period": f.get("wave_period"),
            "fc_wave_direction": f.get("wave_direction"), "fc_wind_speed": f.get("wind_speed"),
            "fc_wind_direction": f.get("wind_direction"), "fc_sea_level": f.get("sea_level_height"),
            "wind_group": wind_group(f, faces),
            "simple_score": simple_score(f, faces) if f.get("wave_height") is not None else None,
            "crowd_water": crowd.get("crowd_water"), "crowd_beach": crowd.get("crowd_beach"),
        }
        here = [b for b in buoys if (t, b) in obs_by] or [None]
        for b in here:
            o = obs_by.get((t, b), {})
            hours.append({**base, "buoy_id": b, "buoy_hm0": o.get("wave_height"),
                          "buoy_tp": o.get("wave_period"), "buoy_dir": o.get("wave_direction"),
                          "buoy_wind_speed": o.get("wind_speed"),
                          "buoy_wind_direction": o.get("wind_direction")})

    # ratings.csv (same device + surfed_at counted once)
    seen, ratings = set(), []
    for r in ratings_raw:
        when = ts(r["surfed_at"])
        dedup = (r.get("device_id"), when) if r.get("device_id") else ("id", r["id"])
        if dedup in seen:
            continue
        seen.add(dedup)
        h = round_hour(when)
        f = forecast.get(h) or {}
        shown = r.get("forecast_shown") or {}
        crowd = crowd_near(h)
        ratings.append({
            "id": r["id"], "surfed_at": when, "source": r["source"], "overall": r["overall"],
            "wave_size": r.get("wave_size"), "surface": r.get("surface"), "crowd": r.get("crowd"),
            "fc_source": f.get("fc_source"), "fc_wave_height": f.get("wave_height"),
            "fc_wave_period": f.get("wave_period"), "fc_wind_speed": f.get("wind_speed"),
            "fc_wind_direction": f.get("wind_direction"), "fc_sea_level": f.get("sea_level_height"),
            "wind_group": wind_group(f, faces),
            "simple_score": simple_score(f, faces) if f.get("wave_height") is not None else None,
            "score_shown": (shown.get("score") or {}).get("value") if isinstance(shown, dict) else None,
            "crowd_water": crowd.get("crowd_water"), "crowd_beach": crowd.get("crowd_beach"),
        })

    # Tide thirds of the rows being compared (buoy hours and ratings each get their own cuts:
    # ratings span years, buoy hours span 2 days).
    for rows in (hours, ratings):
        cuts = tide_cuts([r["fc_sea_level"] for r in rows])
        for r in rows:
            r["tide_group"] = tide_group(r["fc_sea_level"], cuts)

    wave_items = [(r, f"buoy {r['buoy_id']}", r["fc_wave_height"] - r["buoy_hm0"]) for r in hours
                  if r["buoy_hm0"] is not None and r["fc_wave_height"] is not None]
    score_items = [(r, "simple score", r["simple_score"] - r["overall"]) for r in ratings
                   if r["simple_score"] is not None]
    wind_wave = group_errors([(r["wind_group"], s, e) for r, s, e in wave_items])
    tide_wave = group_errors([(r["tide_group"], s, e) for r, s, e in wave_items])
    wind_score = group_errors([(r["wind_group"], s, e) for r, s, e in score_items])
    tide_score = group_errors([(r["tide_group"], s, e) for r, s, e in score_items])

    buoy_series = [(f"buoy {b}", BUOY_CLASS[i]) for i, b in enumerate(buoys[:2])]
    score_series = [("simple score", "s1")]
    charts = {
        "forecast_vs_buoy.svg": plot_forecast_vs_buoy(hours, buoys),
        "score_vs_rating.svg": plot_score_vs_rating(ratings),
        "error_by_wind.svg": plot_grouped_bars("Error by forecast wind direction", [
            ("Wave height: forecast - buoy", "error (m)", wind_wave, buoy_series, wind_sort_key),
            ("Score: simple score - surfers' rating", "error (points)", wind_score, score_series, wind_sort_key)]),
        "error_by_tide.svg": plot_grouped_bars("Error by forecast sea level (tide + surge, thirds of the data)", [
            ("Wave height: forecast - buoy", "error (m)", tide_wave, buoy_series, tide_sort_key),
            ("Score: simple score - surfers' rating", "error (points)", tide_score, score_series, tide_sort_key)]),
    }

    out = OUT_DIR / sid
    out.mkdir(parents=True, exist_ok=True)
    for name, body in charts.items():
        (out / name).write_text(body, encoding="utf-8")
    write_csv(out / "hours.csv", hours)
    write_csv(out / "ratings.csv", ratings)

    summary = summarise(spot, hours, ratings, buoys, wind_wave, tide_wave, wind_score, tide_score)
    counts = (f"{len(db_fc)} forecast rows in the database ({sum(r['fc_source'] == 'live' for r in db_fc)} live), "
              f"{len(past)} Open-Meteo past hours (not stored), {len(obs)} buoy readings, "
              f"{len(snaps)} snapshots ({sum(s['crowd_water'] is not None for s in snaps)} with a crowd count), "
              f"{len(ratings)} ratings")
    sources = sorted({r["fc_source"] for r in hours if r["fc_source"]})
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Forecast check</title>
<style>
:root{{--bg:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--line:#e4e3df}}
@media (prefers-color-scheme:dark){{:root{{--bg:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--line:#33332f}}}}
body{{background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1000px;padding:16px}}
h1{{font-size:22px}} h2{{font-size:17px;margin-top:32px}} p,li{{color:var(--ink2)}}
svg{{max-width:100%;height:auto}} .tw{{overflow-x:auto;max-height:320px}}
table{{border-collapse:collapse;font-size:12px}} td,th{{border-bottom:1px solid var(--line);padding:3px 8px;text-align:right;white-space:nowrap}}
.warn{{border-left:3px solid var(--ink2);padding-left:10px}}
</style></head><body>
<h1>{esc(summary[0])}</h1>
<p class="warn">Local only: contains raw PORTUS buoy data (training only, never publish). Generated {datetime.now(UTC):%Y-%m-%d %H:%M} UTC.</p>
<p>{esc(counts)}. Forecast sources used: {esc(', '.join(sources) or 'none')}.</p>
<ul>{''.join(f'<li>{esc(l[2:])}</li>' for l in summary[1:])}</ul>
<p>Buoys are 40-60 km away in deeper water, so part of the wave error is "the beach isn't the buoy", not the model being wrong. Sea level here is mostly storm surge; the real tide is ~10-20 cm. Hover any mark for its numbers.</p>
<h2>Forecast vs buoy</h2>{charts['forecast_vs_buoy.svg']}
<h2>Simple score vs surfers</h2>{charts['score_vs_rating.svg']}
<h2>Error by wind</h2>{charts['error_by_wind.svg']}
<h2>Error by sea level</h2>{charts['error_by_tide.svg']}
<h2>Ratings (table view)</h2>{html_table(ratings, ['surfed_at', 'source', 'overall', 'simple_score', 'score_shown', 'fc_source', 'fc_wave_height', 'fc_wind_speed', 'wind_group', 'tide_group', 'crowd_water'])}
<h2>Hours (table view)</h2>{html_table(hours, ['hour', 'buoy_id', 'fc_wave_height', 'buoy_hm0', 'fc_source', 'wind_group', 'tide_group', 'fc_sea_level'])}
<p>Weather data by Open-Meteo.com</p>
</body></html>"""
    (out / "report.html").write_text(page, encoding="utf-8")
    return [counts] + summary + [f"Written to {out}"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--spot", help="only this spot id (default: every active spot)")
    parser.add_argument("--past-days", type=int, default=3, metavar="N",
                        help="add N days of Open-Meteo past at the spot (not stored); 0 = database only")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # Windows console: spot names with accents

    load_dotenv(ROOT / ".env")
    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        print("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in .env")
        return 1
    db = Supabase(url, key)
    query = "select=id,name,lat,lon,beach_orientation,buoy_ids&order=id"
    query += f"&id=eq.{urllib.parse.quote(args.spot)}" if args.spot else "&active=eq.true"
    spots = http(f"{db.base}/spots?{query}", db.headers)
    if not spots:
        print("No matching spots.")
        return 1
    for spot in spots:
        print(f"[explore] {spot['id']}")
        for line in explore_spot(db, spot, args.past_days):
            print(f"  {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
