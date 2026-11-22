"""Backtest: would the forecast score have matched what was measured over the last 12 months?

Nothing is written to Supabase and the live app is not touched. Output goes to
explore_out/backtest/ (gitignored, LOCAL ONLY: it contains PORTUS buoy data, never publish it):

  report.html     charts + plain-words conclusions; open it in a browser
  hours.csv       one row per UTC hour: forecast, measured, both scores
  raw/            downloaded data (cached; delete the folder to download again)

Data (all free, no keys):
  forecast  Open-Meteo archived forecasts at the spot: Marine API (best_match, null waves filled
            from ncep_gfswave025 like the app) + Historical Forecast API (wind 10 m). These are
            the first hours of each model run stitched together, i.e. a short-lead forecast.
  waves     PORTUS buoy = the spot's first `spots.buoy_ids` (Vilanova: 1731 Barcelona II): hourly Hm0,
            Tp, mean direction, from the history endpoint behind portus.puertos.es's
            "time series" charts (historicosSerialTime; unofficial, may change).
  wind      Meteocat XEMA station from STATIONS below (or --station; Vilanova: YR, 3.3 km, 32 m
            altitude, inland at the cycling circuit): 10 m wind every 30 min from the Generalitat open-data portal
            (dataset nzvn-apee). Hour value = vector mean of the readings ending at hh:00 and
            hh:30 (times are UTC).

Steps:
  1. observed score = the same 1-5 rules (jobs/explore.simple_score = app's simpleScore.ts)
     fed with the buoy + station numbers instead of the forecast.
  2. compare forecast score vs observed score, daylight hours (sunrise..sunset, UTC from
     Open-Meteo), by wind direction, swell size and season.
  3. train the production model code (jobs/train.fit / predict: a correction on top of the
     simple score) on the first 9 months, test on the last 3.
  4. crowd_water from `snapshots` vs observed score (needs SUPABASE_* in .env; skipped if not).

Run from the repo root:  python -m jobs.backtest            (about 1-2 min the first time)
                         python -m jobs.backtest --offline  (cached data only)
Weather data by Open-Meteo.com. Wind data: Meteocat (Servei Meteorològic de Catalunya).
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import urllib.parse
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean
from typing import Any

import numpy as np

from jobs.check_connections import ROOT, env, load_dotenv
from jobs.collect_forecast import MARINE_URL, Supabase, http
from jobs.explore import (COMPASS, STYLE, Panel, compass, esc, nice_ticks, round_hour, simple_score,
                          svg, ts, wind_relation)
from jobs.train import features, fit, predict

UTC = timezone.utc
Row = dict[str, Any]

# Meteocat XEMA station with 10 m wind (variables 30/31) for each spot, chosen 2026-11-22: the
# nearest one at the coast. Barcelona's city-centre station X4 (rooftop) is closer to
# Barceloneta/Bogatell but measures town wind, so the harbour-mouth station Y7 is used.
STATIONS = {"vilanova": "YR", "sitges": "YR", "castelldefels": "XL", "barceloneta": "Y7",
            "bogatell": "Y7"}  # castelldefels: YY Viladecans is closer but has only 2 m wind
XEMA_META_URL = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json"
PORTUS_STATION_URL = "https://portus.puertos.es/portussvr/api/estaciones/hist?id={id}&locale=es"

# Set by configure() for the spot being tested.
SPOT: Row = {}
BUOY = BUOY_NAME = XEMA = XEMA_NAME = ""
BUOY_LATLON: tuple[float, float] = (0.0, 0.0)
PLACES: Row = {}  # distances etc. for the report text
HIST_FORECAST_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
PORTUS_URL = "https://portus.puertos.es/portussvr/api/historicosSerialTime/estacion/WAVE/{id}?locale=es"
XEMA_URL = "https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json"
BASE = ROOT / "explore_out" / "backtest"
RAW = BASE / "raw"  # shared by all spots (buoy + station files are reused)
OUT = BASE

WAVE_VARS = ["wave_height", "wave_period", "wave_direction", "swell_wave_height",
             "swell_wave_period", "swell_wave_direction"]
TRAIN_MONTHS = 9
GO = 3  # app: 1 SKIP, 2 MAYBE, 3-4 GO, 5 EPIC


# ---------- download (cached in raw/) ----------

def cached(name: str, offline: bool, fetch) -> Any:
    path = RAW / name
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    if offline:
        raise SystemExit(f"{path} missing; run without --offline")
    data = fetch()
    RAW.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    return data


def open_meteo(url: str, params: dict[str, Any], at: tuple[float, float] | None = None) -> Row:
    lat, lon = at or (SPOT["lat"], SPOT["lon"])
    q = {"latitude": lat, "longitude": lon, "timezone": "UTC", **params}
    return http(f"{url}?{urllib.parse.urlencode(q)}")


def month_chunks(start: datetime, end: datetime):
    cur = start
    while cur < end:
        nxt = min((cur.replace(day=1) + timedelta(days=32)).replace(day=1), end)
        yield cur, nxt
        cur = nxt


def portus(param: str, start: datetime, end: datetime) -> list[list[Any]]:
    out = []
    for a, b in month_chunks(start, end):
        body = {"graficos": [{"text": "Datos", "grafico": "DATOS", "parametro": param, "limiteDatos": 10}],
                "desde": a.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                "hasta": b.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "variable": "WAVE"}
        res = http(PORTUS_URL.format(id=BUOY), method="POST", body=body) or {}
        out += [[d["fecha"], d["Datos"]] for d in res.get("datos", [])]
        print(f"  buoy {param} {a:%Y-%m}: {len(res.get('datos', []))} readings")
    return out


def xema(start: datetime, end: datetime) -> list[list[Any]]:
    out, offset = [], 0
    where = (f"codi_estacio='{XEMA}' AND codi_variable in('30','31') AND "
             f"data_lectura >= '{start:%Y-%m-%dT%H:%M:%S}' AND data_lectura <= '{end:%Y-%m-%dT%H:%M:%S}'")
    while True:
        q = {"$select": "codi_variable,data_lectura,valor_lectura", "$where": where,
             "$order": "data_lectura,codi_variable", "$limit": 50000, "$offset": offset}
        page = http(f"{XEMA_URL}?{urllib.parse.urlencode(q)}") or []
        out += [[r["codi_variable"], r["data_lectura"], r["valor_lectura"]] for r in page]
        print(f"  station wind: {len(out)} readings")
        if len(page) < 50000:
            return out
        offset += 50000


def download(start: datetime, end: datetime, offline: bool) -> dict[str, Any]:
    d0, d1 = start.date().isoformat(), (end - timedelta(hours=1)).date().isoformat()
    tag = f"{d0}_{d1}"
    marine = cached(f"marine_{SPOT['id']}_{tag}.json", offline, lambda: open_meteo(
        MARINE_URL, {"start_date": d0, "end_date": d1, "hourly": ",".join(WAVE_VARS + ["sea_level_height_msl"])}))
    gfs = cached(f"marine_gfs_{SPOT['id']}_{tag}.json", offline, lambda: open_meteo(
        MARINE_URL, {"start_date": d0, "end_date": d1, "hourly": ",".join(WAVE_VARS),
                     "models": "ncep_gfswave025"}))
    at_buoy = cached(f"marine_at_buoy_{BUOY}_{tag}.json", offline, lambda: open_meteo(
        MARINE_URL, {"start_date": d0, "end_date": d1, "hourly": "wave_height"}, BUOY_LATLON))
    wind = cached(f"wind_{SPOT['id']}_{tag}.json", offline, lambda: open_meteo(
        HIST_FORECAST_URL, {"start_date": d0, "end_date": d1,
                            "hourly": "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
                            "daily": "sunrise,sunset"}))
    buoy = {p: cached(f"buoy_{BUOY}_{p}_{tag}.json", offline, lambda p=p: portus(p, start, end))
            for p in ("hm0", "tp", "dmd")}
    station = cached(f"xema_{XEMA}_{tag}.json", offline, lambda: xema(start, end))
    return {"marine": marine, "gfs": gfs, "at_buoy": at_buoy, "wind": wind, "buoy": buoy, "station": station}


# ---------- join per hour ----------

def fnum(v: Any, lo: float, hi: float) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if lo <= x <= hi else None


def hourly(block: Row) -> dict[datetime, Row]:
    h = block["hourly"]
    out = {}
    for i, t in enumerate(h["time"]):
        out[datetime.fromisoformat(t).replace(tzinfo=UTC)] = {k: v[i] for k, v in h.items() if k != "time"}
    return out


def vector_mean(pairs: list[tuple[float, float]]) -> tuple[float, float]:
    """[(speed, from-direction)] -> (mean speed, vector-mean direction)."""
    u = sum(s * math.sin(math.radians(d)) for s, d in pairs)
    v = sum(s * math.cos(math.radians(d)) for s, d in pairs)
    return mean(s for s, _ in pairs), math.degrees(math.atan2(u, v)) % 360


def join(raw: dict[str, Any]) -> list[Row]:
    marine, gfs, wind = hourly(raw["marine"]), hourly(raw["gfs"]), hourly(raw["wind"])
    at_buoy = hourly(raw["at_buoy"])

    buoy: dict[datetime, Row] = defaultdict(dict)
    limits = {"hm0": (0, 15), "tp": (1, 25), "dmd": (0, 360)}
    for p, rows in raw["buoy"].items():
        for fecha, val in rows:
            t = datetime.strptime(fecha[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC)
            x = fnum(val, *limits[p])
            if x is not None:
                buoy[t][p] = x

    halves: dict[datetime, dict[str, Row]] = defaultdict(lambda: defaultdict(dict))
    for var, when, val in raw["station"]:
        t = datetime.fromisoformat(when[:19]).replace(tzinfo=UTC)
        x = fnum(val, 0, 60 if var == "30" else 360)
        if x is not None:
            halves[t]["speed" if var == "30" else "dir"] = x
    def station_at(t: datetime) -> tuple[float | None, float | None]:
        pairs = [(halves[s]["speed"] * 3.6, halves[s]["dir"]) for s in (t, t + timedelta(minutes=30))
                 if s in halves and "speed" in halves[s] and "dir" in halves[s]]
        return vector_mean(pairs) if pairs else (None, None)

    sun: dict[str, tuple[datetime, datetime]] = {}
    daily = raw["wind"].get("daily") or {}
    for day, rise, sset in zip(daily.get("time", []), daily.get("sunrise", []), daily.get("sunset", [])):
        if rise and sset:
            sun[day] = (datetime.fromisoformat(rise).replace(tzinfo=UTC),
                        datetime.fromisoformat(sset).replace(tzinfo=UTC))

    faces = SPOT["beach_orientation"]
    rows = []
    for t in sorted(marine):
        m, w = marine[t], wind.get(t, {})
        fc = {k: m.get(k) for k in WAVE_VARS}
        fc["marine_model"] = "best_match"
        g = gfs.get(t, {})
        if fc["wave_height"] is None and g.get("wave_height") is not None:  # app: GFS wave fallback
            fc = {k: g.get(k) for k in WAVE_VARS}
            fc["marine_model"] = "ncep_gfswave025"
        fc["sea_level_height"] = m.get("sea_level_height_msl")
        fc["wind_speed"], fc["wind_direction"] = w.get("wind_speed_10m"), w.get("wind_direction_10m")

        b = buoy.get(t, {})
        st_speed, st_dir = station_at(t)
        obs = {"wave_height": b.get("hm0"), "swell_wave_period": b.get("tp"),
               "wave_direction": b.get("dmd"), "wind_speed": st_speed, "wind_direction": st_dir}

        rise_set = sun.get(t.date().isoformat())
        mid = t + timedelta(minutes=30)
        row: Row = {
            "time": t, "daylight": bool(rise_set and rise_set[0] <= mid <= rise_set[1]),
            "fc": fc, "obs": obs, "fc_at_buoy": at_buoy.get(t, {}).get("wave_height"),
            "fc_score": simple_score(fc, faces) if fc["wave_height"] is not None else None,
            "obs_score": (simple_score(obs, faces) if None not in (b.get("hm0"), st_speed) else None),
        }
        rows.append(row)
    return rows


# ---------- grouping ----------

def season(t: datetime) -> str:
    return {12: "Winter", 1: "Winter", 2: "Winter", 3: "Spring", 4: "Spring", 5: "Spring",
            6: "Summer", 7: "Summer", 8: "Summer"}.get(t.month, "Autumn")


SEASONS = ["Winter", "Spring", "Summer", "Autumn"]
SIZE_BINS = [(0.0, "under 0.25 m"), (0.25, "0.25-0.5 m"), (0.5, "0.5-1 m"), (1.0, "1-1.5 m"), (1.5, "1.5 m+")]


def size_bin(h: float) -> str:
    return [label for lo, label in SIZE_BINS if h >= lo][-1]


def wind_bin(fc: Row) -> str:
    if fc["wind_speed"] is None or fc["wind_direction"] is None:
        return "?"
    if fc["wind_speed"] < 10:
        return "calm"
    return compass(fc["wind_direction"])


def wind_label(b: str) -> str:
    if b == "calm":
        return "calm <10"
    centre = {c: i * 45 for i, c in enumerate(COMPASS)}[b]
    return f"{b} ({ {'offshore': 'off', 'onshore': 'on', 'cross': 'cross'}[wind_relation(centre, SPOT['beach_orientation'])] })"


def stats(pairs: list[tuple[int, int]]) -> Row:
    """pairs = [(forecast, observed)] -> hit rates."""
    n = len(pairs)
    if not n:
        return {"n": 0}
    return {
        "n": n,
        "exact": sum(f == o for f, o in pairs) / n,
        "within1": sum(abs(f - o) <= 1 for f, o in pairs) / n,
        "mae": sum(abs(f - o) for f, o in pairs) / n,
        "bias": sum(f - o for f, o in pairs) / n,
        "go_right": sum((f >= GO) == (o >= GO) for f, o in pairs) / n,
        "false_go": sum(f >= GO and o < GO for f, o in pairs) / n,   # said GO, it wasn't
        "missed_go": sum(f < GO and o >= GO for f, o in pairs) / n,  # said no, it was GO
        "said_go": sum(f >= GO for f, _ in pairs),
        "was_go": sum(o >= GO for _, o in pairs),
        "false_go_of_said": (sum(f >= GO and o < GO for f, o in pairs) / max(1, sum(f >= GO for f, _ in pairs))),
        "missed_of_was": (sum(f < GO and o >= GO for f, o in pairs) / max(1, sum(o >= GO for _, o in pairs))),
    }


def by_group(rows: list[Row], key, score: str = "fc_score") -> dict[str, Row]:
    groups: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for r in rows:
        groups[key(r)].append((r[score], r["obs_score"]))
    return {g: stats(p) for g, p in groups.items()}


# ---------- model (production code from jobs/train.py) ----------

def model_rows(rows: list[Row]) -> list[Row]:
    out = []
    for r in rows:
        x = features(r["fc"], None, SPOT, r["time"])
        x["simple_score"] = float(r["fc_score"])
        out.append({"x": x, "overall": float(r["obs_score"]), "simple": float(r["fc_score"]),
                    "weight": 1.0, "row": r})
    return out


def round_half_up(v: float) -> int:
    return int(min(5, max(1, math.floor(v + 0.5))))


def run_model(rows: list[Row], cut: datetime) -> Row:
    data = model_rows(rows)
    train = [d for d in data if d["row"]["time"] < cut]
    test = [d for d in data if d["row"]["time"] >= cut]
    model = fit(train, "overall")
    preds = predict(model, test)
    for d, p in zip(test, preds):
        d["row"]["ai_score"] = round_half_up(float(p))
        d["row"]["ai_raw"] = float(p)
    test_rows = [d["row"] for d in test]
    day = [r for r in test_rows if r["daylight"]]
    # baseline the model has to beat with no skill at all: "observed = forecast + average train error"
    return {
        "n_train": len(train), "n_test": len(test), "test_rows": test_rows,
        "raw": stats([(r["fc_score"], r["obs_score"]) for r in day]),
        "ai": stats([(r["ai_score"], r["obs_score"]) for r in day]),
        "raw_all": stats([(r["fc_score"], r["obs_score"]) for r in test_rows]),
        "ai_all": stats([(r["ai_score"], r["obs_score"]) for r in test_rows]),
        "raw_cont_mae": mean(abs(r["fc_score"] - r["obs_score"]) for r in day),
        "ai_cont_mae": mean(abs(r["ai_raw"] - r["obs_score"]) for r in day),
        "importance": permutation_importance(model, test),
    }


def permutation_importance(model, test: list[Row]) -> list[tuple[str, float]]:
    """How much worse (MAE, points) the model gets when one feature is shuffled."""
    rng = np.random.default_rng(0)
    truth = np.array([d["overall"] for d in test])
    base = float(np.mean(np.abs(predict(model, test) - truth)))
    out = []
    for f in model.features_:
        vals = [d["x"][f] for d in test]
        perm = rng.permutation(vals)
        shuffled = [{**d, "x": {**d["x"], f: perm[i]}} for i, d in enumerate(test)]
        out.append((f, float(np.mean(np.abs(predict(model, shuffled) - truth))) - base))
    return sorted(out, key=lambda kv: -kv[1])


# ---------- crowd ----------

def crowd(rows: list[Row]) -> Row:
    load_dotenv(ROOT / ".env")
    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        return {"error": "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not in .env"}
    db = Supabase(url, key)
    try:
        snaps = http(f"{db.base}/snapshots?select=taken_at,crowd_water,crowd_beach,quality"
                     f"&spot_id=eq.{SPOT['id']}&order=taken_at&limit=5000", db.headers) or []
    except Exception as exc:  # noqa: BLE001  report, don't fail the backtest
        return {"error": f"couldn't read snapshots: {exc}"}
    by_hour = {r["time"]: r for r in rows}
    counted = [s for s in snaps if s.get("crowd_water") is not None]
    pairs = []
    for s in counted:
        r = by_hour.get(round_hour(ts(s["taken_at"])))
        if r and r["obs_score"] is not None:
            pairs.append((s["crowd_water"], r["obs_score"]))
    first = snaps[0]["taken_at"] if snaps else None
    return {"snapshots": len(snaps), "counted": len(counted), "pairs": pairs, "first": first,
            "quality": Counter(s.get("quality") for s in snaps)}


# ---------- charts (hand-made SVG, same style as jobs/explore.py) ----------

def pct(v: float) -> str:
    return f"{v * 100:.0f}%"


def plot_monthly(rows: list[Row]) -> str:
    months: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for r in rows:
        months[r["time"].strftime("%Y-%m")].append((r["fc_score"], r["obs_score"]))
    names = sorted(months)
    st = [stats(months[m]) for m in names]
    W, H = 980, 330
    p = Panel(70, 64, 880, 200, (0, len(names)), (0, 1))
    parts = p.axes([0, .25, .5, .75, 1], "share of daylight hours",
                   [(i + .5, datetime.strptime(m, "%Y-%m").strftime("%b %y")) for i, m in enumerate(names)],
                   "", yfmt=lambda v: pct(v))
    series = [("exact", "s1", "same score"), ("within1", "s3", "within 1 point"),
              ("false_go", "s2", "said GO, wasn't")]
    for key, cls, _ in series:
        pts = " ".join(f"{p.x(i + .5):.1f},{p.y(s[key]):.1f}" for i, s in enumerate(st))
        parts.append(f'<polyline class="ln {cls}" points="{pts}"/>')
        for i, s in enumerate(st):
            parts.append(f'<circle class="{cls}" cx="{p.x(i + .5):.1f}" cy="{p.y(s[key]):.1f}" r="3.5">'
                         f'<title>{esc(names[i])}: {pct(s[key])} of {s["n"]} hours</title></circle>')
    parts += legend_line(70, 48, [(c, l) for _, c, l in series])
    return svg(W, H, "Forecast score vs measured score, month by month (daylight hours)", parts)


def legend_line(x: float, y: float, entries: list[tuple[str, str]]) -> list[str]:
    out = []
    for cls, label in entries:
        out.append(f'<rect class="{cls}" x="{x}" y="{y - 9}" width="10" height="10" rx="2"/>')
        out.append(f'<text x="{x + 15}" y="{y}">{esc(label)}</text>')
        x += 30 + 7 * len(label)
    return out


def plot_confusion(pairs: list[tuple[int, int]], title: str) -> str:
    n = len(pairs)
    cnt = Counter(pairs)
    W, H, cell, x0, y0 = 460, 420, 56, 120, 70
    parts = []
    biggest = max(cnt.values()) if cnt else 1
    for f in range(1, 6):
        for o in range(1, 6):
            c = cnt.get((f, o), 0)
            x, y = x0 + (o - 1) * cell, y0 + (5 - f) * cell
            kind = "s3" if f == o else ("s2" if f >= GO > o else ("s1" if f < GO <= o else "s0"))
            op = 0.12 + 0.88 * (c / biggest) ** 0.5 if c else 0.04
            parts.append(f'<rect class="{kind}" x="{x}" y="{y}" width="{cell - 3}" height="{cell - 3}" rx="4" '
                         f'fill-opacity="{op:.2f}"><title>forecast {f}, measured {o}: {c} hours ({c / n * 100:.1f}%)</title></rect>')
            parts.append(f'<text x="{x + (cell - 3) / 2}" y="{y + cell / 2 + 3}" text-anchor="middle">{c}</text>')
        parts.append(f'<text x="{x0 - 8}" y="{y0 + (5 - f) * cell + cell / 2 + 3}" text-anchor="end">{f}</text>')
    for o in range(1, 6):
        parts.append(f'<text x="{x0 + (o - 1) * cell + (cell - 3) / 2}" y="{y0 + 5 * cell + 14}" text-anchor="middle">{o}</text>')
    parts.append(f'<text x="{x0 + 2.5 * cell}" y="{y0 + 5 * cell + 34}" text-anchor="middle">measured score (buoy + station)</text>')
    parts.append(f'<text transform="translate({x0 - 34},{y0 + 2.5 * cell}) rotate(-90)" text-anchor="middle">forecast score</text>')
    parts += legend_line(16, 50, [("s3", "right"), ("s2", "said GO, wasn't"), ("s1", "missed GO")])
    return svg(W, H, title, parts)


def plot_rate_bars(title: str, panels: list[tuple[str, dict[str, Row], list[str]]]) -> str:
    """Each panel: heading, {group: stats}, group order. Bars: false GO and missed GO rates."""
    W, PH = 980, 240
    H = 40 + PH * len(panels)
    parts = []
    series = [("false_go", "s2", "said GO, it wasn't"), ("missed_go", "s1", "said no, it was GO"),
              ("exact", "s3", "same score")]
    for k, (heading, groups, order) in enumerate(panels):
        top = 40 + k * PH
        names = [g for g in order if g in groups and groups[g]["n"]]
        hi = max([groups[g][s] for g in names for s, _, _ in series] + [0.1])
        yt = nice_ticks(0, min(1, hi * 1.15), 4)
        p = Panel(70, top + 56, 880, PH - 116, (0, max(len(names), 1)), (0, yt[-1]))
        parts.append(f'<text class="t" x="16" y="{top + 16}">{esc(heading)}</text>')
        parts += legend_line(70, top + 34, [(c, l) for _, c, l in series])
        parts += p.axes(yt, "share of hours", [(i + .5, n) for i, n in enumerate(names)], "",
                        yfmt=lambda v: pct(v))
        bw = min(30, 0.8 / len(series) * p.w / max(len(names), 1))
        for i, n in enumerate(names):
            s = groups[n]
            for j, (key, cls, label) in enumerate(series):
                cx = p.x(i + .5) + (j - 1) * (bw + 2)
                parts.append(f'<rect class="{cls}" x="{cx - bw / 2:.1f}" y="{p.y(s[key]):.1f}" width="{bw:.1f}" '
                             f'height="{max(p.y(0) - p.y(s[key]), 1):.1f}" rx="3"><title>{esc(n)}: {label} '
                             f'{pct(s[key])} of {s["n"]} hours</title></rect>')
            parts.append(f'<text x="{p.x(i + .5):.1f}" y="{p.y0 - 4}" text-anchor="middle" class="sm">n={s["n"]}</text>')
    return svg(W, H, title, parts)


def plot_model(res: Row) -> str:
    W, H = 980, 300
    metrics = [("exact", "same score as measured", True), ("within1", "within 1 point", True),
               ("go_right", "GO / not GO right", True), ("false_go", "said GO, it wasn't", False),
               ("missed_go", "said no, it was GO", False)]
    p = Panel(70, 64, 880, 170, (0, len(metrics)), (0, 1))
    parts = p.axes([0, .25, .5, .75, 1], "share of test hours",
                   [(i + .5, label) for i, (_, label, _) in enumerate(metrics)], "", yfmt=lambda v: pct(v))
    for i, (key, label, up) in enumerate(metrics):
        for j, (name, cls) in enumerate([("raw", "s1"), ("ai", "s3")]):
            v = res[name][key]
            cx = p.x(i + .5) + (j - .5) * 40
            parts.append(f'<rect class="{cls}" x="{cx - 18:.1f}" y="{p.y(v):.1f}" width="36" '
                         f'height="{max(p.y(0) - p.y(v), 1):.1f}" rx="3"><title>{"raw forecast" if name == "raw" else "AI-corrected"}: {pct(v)}</title></rect>')
            parts.append(f'<text x="{cx:.1f}" y="{p.y(v) - 5:.1f}" text-anchor="middle">{pct(v)}</text>')
    parts += legend_line(70, 48, [("s1", "raw forecast score"), ("s3", "AI-corrected score")])
    parts.append(f'<text x="950" y="48" text-anchor="end" class="sm">higher is better for the first three, lower for the last two</text>')
    return svg(W, H, f"Last {12 - TRAIN_MONTHS} months (model never saw them): raw vs AI-corrected", parts)


def plot_components(rows: list[Row]) -> str:
    """Forecast minus measured, per month: wave height (m) and wind speed (km/h)."""
    months: dict[str, list[Row]] = defaultdict(list)
    for r in rows:
        months[r["time"].strftime("%Y-%m")].append(r)
    names = sorted(months)
    W, H = 980, 760
    parts = []
    def diff(r: Row, key: str) -> float | None:
        if key == "at_buoy":
            return None if r["fc_at_buoy"] is None else r["fc_at_buoy"] - r["obs"]["wave_height"]
        return r["fc"][key] - r["obs"][key]
    wave_lim = max(abs(mean(d for r in months[m] if (d := diff(r, key)) is not None))
                   for m in names for key in ("wave_height", "at_buoy"))
    for k, (key, unit, title) in enumerate([
            ("wave_height", "m", "Wave height: forecast at the BEACH minus buoy"),
            ("at_buoy", "m", "Wave height: forecast AT THE BUOY minus buoy (same place: pure model error)"),
            ("wind_speed", "km/h", "Wind speed: forecast minus station")]):
        vals = [mean(d for r in months[m] if (d := diff(r, key)) is not None) for m in names]
        lim = (max(abs(v) for v in vals) if key == "wind_speed" else wave_lim) * 1.25 or 1
        yt = nice_ticks(-lim, lim, 4)
        top = 40 + k * 240
        p = Panel(70, top + 30, 880, 150, (0, len(names)), (yt[0], yt[-1]))
        parts.append(f'<text class="t" x="16" y="{top + 14}">{esc(title)} (monthly mean, + = forecast higher)</text>')
        parts += p.axes(yt, unit, [(i + .5, datetime.strptime(m, "%Y-%m").strftime("%b %y")) for i, m in enumerate(names)],
                        "", yfmt=lambda v: f"{v:+g}" if v else "0")
        parts.append(f'<line class="axis" x1="{p.x0}" x2="{p.x0 + p.w}" y1="{p.y(0):.1f}" y2="{p.y(0):.1f}"/>')
        for i, v in enumerate(vals):
            y1, y2 = sorted((p.y(0), p.y(v)))
            parts.append(f'<rect class="{"s2" if v > 0 else "s1"}" x="{p.x(i + .5) - 18:.1f}" y="{y1:.1f}" width="36" '
                         f'height="{max(y2 - y1, 1):.1f}" rx="3"><title>{names[i]}: {v:+.2f} {unit}</title></rect>')
    return svg(W, H, "Where the score error comes from", parts)


def plot_crowd(pairs: list[tuple[int, int]]) -> str:
    W, H = 600, 300
    p = Panel(70, 50, 500, 190, (0.5, 5.5), (0, max([c for c, _ in pairs] + [5])))
    parts = p.axes(nice_ticks(0, max([c for c, _ in pairs] + [5]), 4), "surfers in the water",
                   [(s, str(s)) for s in range(1, 6)], "measured score")
    for c, s in pairs:
        parts.append(f'<circle class="s1" cx="{p.x(s):.1f}" cy="{p.y(c):.1f}" r="4" fill-opacity=".5"/>')
    return svg(W, H, "Surfers counted on the cam vs measured score", parts)


# ---------- report ----------

EXTRA_STYLE = """<style>
.c .ln{fill:none;stroke-width:2.5}.c .ln.s1{stroke:var(--s1)}.c .ln.s2{stroke:var(--s2)}.c .ln.s3{stroke:var(--s3)}
.c .s0{fill:var(--ink2)}.c .sm{font-size:11px;fill:var(--ink2)}
</style>"""

PAGE_CSS = """
:root{--bg:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--line:#e4e3df;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--line:#33332f;--card:#222220}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:21px;margin:40px 0 8px}
.sub{color:var(--ink2);margin:0 0 20px}
.big{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:16px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.tile b{display:block;font-size:28px}.tile span{color:var(--ink2);font-size:14px}
.box{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:4px 18px;margin:12px 0}
.fig{overflow-x:auto;margin:12px 0}.fig svg{max-width:100%;height:auto}
table{border-collapse:collapse;font-size:14px;margin:8px 0}td,th{border-bottom:1px solid var(--line);padding:4px 10px;text-align:right}
th:first-child,td:first-child{text-align:left}
.note{color:var(--ink2);font-size:14px}
"""


def table(groups: dict[str, Row], order: list[str], label) -> str:
    head = "<tr><th>group</th><th>hours</th><th>same score</th><th>within 1</th><th>said GO, wasn't</th><th>missed GO</th><th>avg error</th></tr>"
    body = "".join(
        f"<tr><td>{esc(label(g))}</td><td>{s['n']}</td><td>{pct(s['exact'])}</td><td>{pct(s['within1'])}</td>"
        f"<td>{pct(s['false_go'])}</td><td>{pct(s['missed_go'])}</td><td>{s['bias']:+.2f}</td></tr>"
        for g in order if (s := groups.get(g)) and s["n"])
    return f"<table>{head}{body}</table>"


def worst(groups: dict[str, Row], key: str, label, min_n: int = 100) -> tuple[str, Row] | None:
    ok = [(g, s) for g, s in groups.items() if s["n"] >= min_n]
    return (lambda g_s: (label(g_s[0]), g_s[1]))(max(ok, key=lambda gs: gs[1][key])) if ok else None


def conclusions(day: list[Row], overall: Row, wind: dict, size: dict, seas: dict, res: Row,
                crowd_info: Row, coverage: Row, waves: Row) -> list[str]:
    o = overall
    out = [
        f"<b>Over {o['n']:,} daylight hours, the forecast score was exactly right {pct(o['exact'])} of the time "
        f"and within one point {pct(o['within1'])} of the time.</b> It got the simple question "
        f"\"GO or not?\" right {pct(o['go_right'])} of the time.",
        f"<b>It said GO when it wasn't</b> in {pct(o['false_go'])} of hours "
        f"({pct(o['false_go_of_said'])} of all its GO calls). <b>It said no when it was GO</b> in "
        f"{pct(o['missed_go'])} of hours ({pct(o['missed_of_was'])} of the real GO hours were missed). "
        + ("So it is more often too optimistic than too pessimistic." if o['false_go'] > o['missed_go']
           else "So it is more often too pessimistic than too optimistic."),
        f"On average the forecast score is {abs(o['bias']):.2f} points {'above' if o['bias'] > 0 else 'below'} "
        f"the measured one.",
        f"<b>Why so pessimistic? Mostly wave height.</b> The forecast at the beach is on average "
        f"{abs(waves['beach_bias']):.2f} m below the buoy (buoy average {waves['buoy_mean']:.2f} m). Open-Meteo's "
        f"forecast <i>at the buoy itself</i> is only {abs(waves['buoy_bias']):.2f} m low. So roughly "
        f"{pct(waves['buoy_bias'] / waves['beach_bias'])} of the gap is the model really under-forecasting, and the rest "
        f"is the beach being more sheltered than the open-sea buoy. That second part isn't a real miss: the "
        f"waves at the beach are probably smaller than at the buoy, so the true number of missed GO hours is lower "
        f"than shown here. Wind is fine: forecast and station differ by {abs(waves['wind_bias']):.1f} km/h on average.",
    ]
    for name, groups, label in [("wind", wind, wind_label), ("swell size", size, str), ("season", seas, str)]:
        w1 = worst(groups, "false_go", label)
        w2 = worst(groups, "missed_go", label)
        if w1 and w2:
            out.append(f"By {name}: false GO calls are most common with <b>{esc(w1[0])}</b> "
                       f"({pct(w1[1]['false_go'])} of those hours); missed GO hours with <b>{esc(w2[0])}</b> "
                       f"({pct(w2[1]['missed_go'])}).")
    better = res["ai"]["mae"] < res["raw"]["mae"]
    out.append(
        f"<b>AI correction: {'yes, it beats' if better else 'no, it does not beat'} the raw forecast</b> on the last "
        f"{12 - TRAIN_MONTHS} months it never saw ({res['ai']['n']:,} daylight hours). Same score as measured: "
        f"{pct(res['raw']['exact'])} → {pct(res['ai']['exact'])}; average miss: {res['raw']['mae']:.2f} → "
        f"{res['ai']['mae']:.2f} points; said GO when it wasn't: {pct(res['raw']['false_go'])} → "
        f"{pct(res['ai']['false_go'])}; missed GO: {pct(res['raw']['missed_go'])} → {pct(res['ai']['missed_go'])}.")
    if crowd_info.get("error"):
        out.append(f"Cam crowd: not checked ({esc(crowd_info['error'])}).")
    elif not crowd_info["counted"]:
        out.append(f"<b>Cam crowd: no data to test.</b> {crowd_info['snapshots']} cam snapshots exist "
                   f"(since {esc((crowd_info['first'] or '')[:10])}), but none has a surfer count: crowd counting "
                   f"isn't built yet, and the free Windy plan's 400×224 image is too small to count people in the water."
                   if crowd_info["snapshots"] or SPOT.get("windy_cam_id") else
                   "<b>Cam crowd: this spot has no cam.</b>")
    out.append(f"<span class='note'>Data coverage: {coverage['both']:,} of {coverage['hours']:,} hours had both a "
               f"forecast and measurements (buoy missing {coverage['no_buoy']:,} h, station missing "
               f"{coverage['no_station']:,} h).</span>")
    return out


def write_report(rows: list[Row], res: Row, crowd_info: Row, coverage: Row, cut: datetime) -> Path:
    both = [r for r in rows if r["fc_score"] is not None and r["obs_score"] is not None]
    day = [r for r in both if r["daylight"]]
    overall = stats([(r["fc_score"], r["obs_score"]) for r in day])
    wind = by_group(day, lambda r: wind_bin(r["fc"]))
    wind_order = ["calm"] + COMPASS
    size = by_group(day, lambda r: size_bin(r["fc"]["wave_height"]))
    size_order = [label for _, label in SIZE_BINS]
    seas = by_group(day, lambda r: season(r["time"]))
    with_buoy_fc = [r for r in both if r["fc_at_buoy"] is not None]
    waves = {"buoy_mean": mean(r["obs"]["wave_height"] for r in both),
             "beach_bias": mean(r["fc"]["wave_height"] - r["obs"]["wave_height"] for r in both),
             "buoy_bias": mean(r["fc_at_buoy"] - r["obs"]["wave_height"] for r in with_buoy_fc),
             "wind_bias": mean(r["fc"]["wind_speed"] - r["obs"]["wind_speed"] for r in both)}
    figs = [
        plot_monthly(day),
        plot_confusion([(r["fc_score"], r["obs_score"]) for r in day],
                       "Every daylight hour: forecast score vs measured score"),
        plot_rate_bars("Where it goes wrong (daylight hours, grouped by the forecast)", [
            ("By forecast wind (compass point it blows from; off/on/cross-shore for this beach)",
             wind, wind_order),
            ("By forecast wave height", size, size_order),
            ("By season", seas, SEASONS)]),
        plot_components(day),
        plot_model(res),
    ]
    figs = [f.replace(STYLE, STYLE + EXTRA_STYLE, 1) for f in figs]
    imp = "".join(f"<tr><td>{esc(f)}</td><td>{v:+.3f}</td></tr>" for f, v in res["importance"][:6])
    crowd_fig = ""
    if crowd_info.get("pairs"):
        crowd_fig = f'<div class="fig">{plot_crowd(crowd_info["pairs"]).replace(STYLE, STYLE + EXTRA_STYLE, 1)}</div>'
    start, end = rows[0]["time"], rows[-1]["time"]
    html_doc = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Surf Backtest</title>
<style>{PAGE_CSS}</style></head><body><main>
<h1>Does the forecast work? A 12-month backtest for {esc(SPOT['name'])}</h1>
<p class="sub">{start:%d %b %Y} – {end:%d %b %Y} (UTC) · forecast = Open-Meteo archived forecasts ·
measured = buoy {esc(BUOY_NAME)} ({PLACES['buoy_km']:.0f} km) for waves + Meteocat station {esc(XEMA_NAME)}
({PLACES['station_km']:.1f} km) for wind · beach faces {SPOT['beach_orientation']:.0f}° ·
same 1–5 rules as the app on both · GO = 3 or more. LOCAL ONLY: contains PORTUS buoy data, don't publish.</p>
<div class="big">
<div class="tile"><b>{pct(overall['exact'])}</b><span>daylight hours with exactly the same score</span></div>
<div class="tile"><b>{pct(overall['go_right'])}</b><span>GO / not GO called right</span></div>
<div class="tile"><b>{pct(overall['false_go'])}</b><span>said GO, it wasn't</span></div>
<div class="tile"><b>{pct(overall['missed_go'])}</b><span>said no, it was GO</span></div>
</div>
<h2>Conclusions in plain words</h2>
<div class="box"><ul>{''.join(f'<li>{c}</li>' for c in conclusions(day, overall, wind, size, seas, res, crowd_info, coverage, waves))}</ul></div>
<h2>1. Month by month</h2><div class="fig">{figs[0]}</div>
<h2>2. How the scores line up</h2>
<p>Each square counts hours. The diagonal is right; orange = the forecast said GO (3+) but the measurements said 1–2;
blue = the forecast said 1–2 but it was 3+.</p><div class="fig">{figs[1]}</div>
<h2>3. In which conditions it fails most</h2><div class="fig">{figs[2]}</div>
<details><summary>Tables</summary>
<h3>Wind</h3>{table(wind, wind_order, wind_label)}<h3>Wave height</h3>{table(size, size_order, str)}
<h3>Season</h3>{table(seas, SEASONS, str)}</details>
<h2>4. Why: the two ingredients</h2>
<p>The score is built from wave height and wind. These bars show how far the forecast numbers were from the measured ones.
The middle panel asks Open-Meteo for the buoy's own position: what's left there is the model's own error; the
difference between the top and middle panels is the beach being more sheltered than the buoy.</p>
<div class="fig">{figs[3]}</div>
<h2>5. Does the AI correction help?</h2>
<p>The app's own model code (<code>jobs/train.py</code>) learned a correction on top of the raw score from the first
{TRAIN_MONTHS} months ({res['n_train']:,} hours, before {cut:%d %b %Y}), here with the measured score as the target
instead of surfer ratings. It was then tested on the last {12 - TRAIN_MONTHS} months ({res['n_test']:,} hours), which it never saw.</p>
<div class="fig">{figs[4]}</div>
<p class="note">Average miss before rounding: raw {res['raw_cont_mae']:.2f} vs AI {res['ai_cont_mae']:.2f} points.
All test hours (day + night): same score {pct(res['raw_all']['exact'])} → {pct(res['ai_all']['exact'])}.</p>
<details><summary>What the model leaned on most (how much worse it gets if that input is scrambled)</summary>
<table><tr><th>input</th><th>extra miss (points)</th></tr>{imp}</table></details>
<h2>6. Surfers on the cam</h2>
<p>{'Not checked: ' + esc(crowd_info['error']) if crowd_info.get('error') else
     f"{crowd_info['snapshots']} snapshots, {crowd_info['counted']} with a surfer count."}</p>{crowd_fig}
<h2>Limits of this test</h2><div class="box"><ul>
<li>"Measured" is not "how it was at the beach": the buoy is {PLACES['buoy_km']:.0f} km away in {PLACES['buoy_depth']}
of water, and the wind station is {PLACES['station_km']:.1f} km away at {PLACES['station_alt']} m. A real surfer's rating can still
disagree with both.</li>
<li>The AI here learns "forecast → buoy + station", not "forecast → surfer". It shows the method works with enough
data, but this model must not go live: it partly learned to make the sheltered beach look like the open-sea buoy,
so it would over-call GO at the real beach. The live model still needs surfer ratings.</li>
<li>Open-Meteo's archive stitches the first hours of each model run, so this is a short-lead forecast; forecasts
2–3 days ahead are worse.</li>
<li>Hours next to each other are similar, so {overall['n']:,} hours are fewer independent cases than they look.</li>
</ul></div>
<p class="note">Weather data by Open-Meteo.com · Wind data: Meteocat (Servei Meteorològic de Catalunya), open data ·
Wave data: Puertos del Estado (training use only).</p>
</main></body></html>"""
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "report.html"
    path.write_text(html_doc, encoding="utf-8")
    return path


def write_csv(rows: list[Row]) -> None:
    with (OUT / "hours.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["time_utc", "daylight", "fc_wave_h", "fc_period", "fc_wave_dir", "fc_wind_kmh", "fc_wind_dir",
                    "buoy_hm0", "buoy_tp", "buoy_dir", "station_wind_kmh", "station_wind_dir",
                    "fc_score", "obs_score", "ai_score"])
        for r in rows:
            fc, ob = r["fc"], r["obs"]
            w.writerow([r["time"].isoformat(), int(r["daylight"]), fc["wave_height"], fc["swell_wave_period"],
                        fc["wave_direction"], fc["wind_speed"], fc["wind_direction"], ob["wave_height"],
                        ob["swell_wave_period"], ob["wave_direction"],
                        None if ob["wind_speed"] is None else round(ob["wind_speed"], 1),
                        None if ob["wind_direction"] is None else round(ob["wind_direction"]),
                        r["fc_score"], r["obs_score"], r.get("ai_score")])


def configure(spot_id: str, station: str | None, offline: bool) -> None:
    """Point the module-level settings at one spot (spot row from Supabase, cached in raw/)."""
    global SPOT, BUOY, BUOY_NAME, BUOY_LATLON, XEMA, XEMA_NAME, PLACES, OUT

    def spot_row() -> Row:
        load_dotenv(ROOT / ".env")
        db = Supabase(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"))
        rows = http(f"{db.base}/spots?select=id,name,lat,lon,beach_orientation,buoy_ids,windy_cam_id"
                    f"&id=eq.{urllib.parse.quote(spot_id)}", db.headers) or []
        if not rows:
            raise SystemExit(f"no spot '{spot_id}' in Supabase")
        return rows[0]

    row = cached(f"spot_{spot_id}.json", offline, spot_row)
    SPOT = {**row, "beach_orientation": float(row["beach_orientation"])}
    if not row.get("buoy_ids"):
        raise SystemExit(f"{spot_id}: no buoy in spots.buoy_ids")
    BUOY = str(row["buoy_ids"][0])
    b = cached(f"portus_station_{BUOY}.json", offline, lambda: http(PORTUS_STATION_URL.format(id=BUOY)))
    BUOY_NAME = f"{b.get('nombre', '?').replace('Boya de ', '')} ({BUOY})"
    BUOY_LATLON = (float(b["latitud"]), float(b["longitud"]))
    XEMA = station or STATIONS.get(spot_id) or ""
    if not XEMA:
        raise SystemExit(f"{spot_id}: no Meteocat station; add it to STATIONS or pass --station")
    meta = cached("xema_stations.json", offline, lambda: http(f"{XEMA_META_URL}?$limit=1000"))
    st = next((m for m in meta if m["codi_estacio"] == XEMA), None)
    if not st:
        raise SystemExit(f"Meteocat station {XEMA} not found")
    XEMA_NAME = f"{st['nom_estacio']} ({XEMA})"
    depth = b.get("altitudProfundidad")
    PLACES = {"buoy_km": km(SPOT, BUOY_LATLON), "buoy_depth": f"{depth:.0f} m" if depth else "deep",
              "station_km": km(SPOT, (float(st["latitud"]), float(st["longitud"]))),
              "station_alt": st.get("altitud", "?")}
    OUT = BASE / spot_id


def km(spot: Row, latlon: tuple[float, float]) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (spot["lat"], spot["lon"], *latlon))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--spot", action="append",
                        help=f"spot id (repeatable); default: {', '.join(STATIONS)}")
    parser.add_argument("--station", help="Meteocat XEMA station code (overrides STATIONS)")
    parser.add_argument("--offline", action="store_true", help="use cached raw/ data only")
    parser.add_argument("--end", help="last day (UTC, YYYY-MM-DD); default yesterday")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    for spot_id in args.spot or list(STATIONS):
        configure(spot_id, args.station, args.offline)
        print(f"[backtest] {spot_id}: buoy {BUOY_NAME} {PLACES['buoy_km']:.1f} km, station "
              f"{XEMA_NAME} {PLACES['station_km']:.1f} km, faces {SPOT['beach_orientation']:.0f}")
        run_spot(args)
    return 0


def run_spot(args: argparse.Namespace) -> None:
    end_day = (datetime.fromisoformat(args.end).date() if args.end
               else datetime.now(UTC).date() - timedelta(days=1))
    end = datetime(end_day.year, end_day.month, end_day.day, tzinfo=UTC) + timedelta(days=1)
    start = end - timedelta(days=365)
    print(f"[backtest] {start:%Y-%m-%d} .. {end_day} UTC, downloading (cached in {RAW})")
    raw = download(start, end, args.offline)

    rows = join(raw)
    both = [r for r in rows if r["fc_score"] is not None and r["obs_score"] is not None]
    coverage = {"hours": len(rows), "both": len(both),
                "no_buoy": sum(r["obs"]["wave_height"] is None for r in rows),
                "no_station": sum(r["obs"]["wind_speed"] is None for r in rows)}
    print(f"[backtest] {coverage}")

    cut = start + (end - start) * TRAIN_MONTHS / 12
    cut = datetime(cut.year, cut.month, cut.day, tzinfo=UTC)
    res = run_model(both, cut)
    print(f"[backtest] model: train {res['n_train']} h, test {res['n_test']} h; daylight MAE raw "
          f"{res['raw']['mae']:.3f} vs AI {res['ai']['mae']:.3f}")
    crowd_info = crowd(rows)
    print(f"[backtest] crowd: {crowd_info if crowd_info.get('error') else {k: crowd_info[k] for k in ('snapshots', 'counted')}}")
    path = write_report(rows, res, crowd_info, coverage, cut)
    write_csv(rows)
    print(f"[backtest] report: {path}")


if __name__ == "__main__":
    sys.exit(main())
