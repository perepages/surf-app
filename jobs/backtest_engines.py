"""Backtest, old engine vs new: the simple score vs the physics score (docs/surf_theory.md).

  python -m jobs.backtest_engines                 # all 5 spots, 22 Nov 2025 - 21 Nov 2026
  python -m jobs.backtest_engines --spot vilanova --offline

Nothing is written to Supabase. Output (LOCAL ONLY, contains numbers derived from PORTUS buoy
data, never publish): explore_out/backtest/engines.md + a summary in the terminal.

Same 12 months and the same downloads as `python -m jobs.backtest` (cached in
explore_out/backtest/raw/), plus what the new engine needs: every Open-Meteo wave train
(secondary swell, wind-wave period/direction), sea temperature, the Historical Forecast API's
precipitation / probability / weather code / CAPE / temperature, GFS-Wave 0.16 partitions, and
the weather station's measured rain + temperature (Meteocat, spots.weather_station).

What is compared (daylight hours, forecast = Open-Meteo's archived short-lead forecast):
  1. Wave quality (overall, no comfort): each forecast score vs TWO measured "truths", so neither
     engine is judged only by its own rules:
       T-old = the old simple rules on the measurements (buoy Hm0/Tp/direction + station wind)
       T-new = the physics rules on the same measurements (buoy = one swell train, station wind
               and its 6/12/24 h history, the spot's swell window)
     Variants: OLD simple; NEW physics; NEW without crossed-swell logic (only the main train) =
     what the crossed-swell part changes. The buoy measures the total sea, not separate trains,
     so whether crossed swells really hurt can't be checked here (only ratings can).
  2. Weather: in daylight hours when the station measured rain (>= 0.5 mm in the hour), how
     often each engine still said GO; how often the new engine lowered the score for rain that
     didn't fall; thunderstorm flags.
  3. AI, trained on the first 9 months, tested on the last 3 (production code, jobs/train.py):
     OLD = one model correcting the simple score towards T-old; NEW = two models correcting
     physics Waves and Shape towards the measured Waves / Shape; both scored on both truths.
Weather data by Open-Meteo.com. Wind, rain, temperature: Meteocat. Waves: Puertos del Estado.
"""
from __future__ import annotations

import argparse
import math
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from statistics import mean
from typing import Any

import numpy as np

from jobs import backtest as bt
from jobs import physics, train
from jobs.collect_forecast import MARINE_URL

UTC = timezone.utc
Row = dict[str, Any]
START = datetime(2025, 11, 22, tzinfo=UTC)   # the window of the earlier backtest (cache reuse)
END = datetime(2026, 11, 22, tzinfo=UTC)
SPOTS = ["vilanova", "sitges", "castelldefels", "barceloneta", "bogatell"]
GO = 3
RAIN_MEASURED_MM = 0.5
EXTRA_MARINE = ["wind_wave_height", "secondary_swell_wave_height", "secondary_swell_wave_period",
                "secondary_swell_wave_direction", "wind_wave_period", "wind_wave_direction",
                "sea_surface_temperature"]
WX_VARS = ["precipitation", "precipitation_probability", "weather_code", "cape", "temperature_2m",
           "wind_gusts_10m"]
GFS_VARS = [f"{p}_wave_{q}" for p in ("swell", "secondary_swell", "tertiary_swell", "wind")
            for q in ("height", "period", "direction")]


# ---------- extra downloads ----------

def extra(offline: bool) -> Row:
    d0, d1 = START.date().isoformat(), (END - timedelta(hours=1)).date().isoformat()
    tag, sid = f"{d0}_{d1}", bt.SPOT["id"]
    q = {"start_date": d0, "end_date": d1}
    marine2 = bt.cached(f"marine2_{sid}_{tag}.json", offline, lambda: bt.open_meteo(
        MARINE_URL, {**q, "hourly": ",".join(EXTRA_MARINE)}))
    wx = bt.cached(f"wx_{sid}_{tag}.json", offline, lambda: bt.open_meteo(
        bt.HIST_FORECAST_URL, {**q, "hourly": ",".join(WX_VARS)}))
    gfs = bt.cached(f"gfs016_{sid}_{tag}.json", offline, lambda: bt.open_meteo(
        MARINE_URL, {**q, "hourly": ",".join(GFS_VARS), "models": "ncep_gfswave016"}))
    st = bt.SPOT.get("weather_station") or ""
    station = bt.cached(f"xema_wx_{st}_{tag}.json", offline, lambda: station_weather(st)) if st else []
    return {"marine2": marine2, "wx": wx, "gfs": gfs, "station": station}


def station_weather(code: str) -> list[list[Any]]:
    """Meteocat readings of precipitation (35, mm per 30 min) and temperature (32) for the year."""
    out, offset = [], 0
    where = (f"codi_estacio='{code}' AND codi_variable in('35','32') AND "
             f"data_lectura >= '{START:%Y-%m-%dT%H:%M:%S}' AND data_lectura < '{END:%Y-%m-%dT%H:%M:%S}'")
    while True:
        qq = {"$select": "codi_variable,data_lectura,valor_lectura", "$where": where,
              "$order": "data_lectura,codi_variable", "$limit": 50000, "$offset": offset}
        page = bt.http(f"{bt.XEMA_URL}?{bt.urllib.parse.urlencode(qq)}") or []
        out += [[r["codi_variable"], r["data_lectura"], r["valor_lectura"]] for r in page]
        print(f"  station {code} rain + temperature: {len(out)} readings")
        if len(page) < 50000:
            return out
        offset += 50000


# ---------- rows ----------

def build(offline: bool) -> list[Row]:
    raw = bt.download(START, END, offline)
    rows = bt.join(raw)
    ex = extra(offline)
    m2, wx, gfs = bt.hourly(ex["marine2"]), bt.hourly(ex["wx"]), bt.hourly(ex["gfs"])
    rain: dict[datetime, float] = defaultdict(float)
    temp: dict[datetime, list[float]] = defaultdict(list)
    for var, when, val in ex["station"]:
        t = datetime.fromisoformat(when[:19]).replace(tzinfo=UTC)
        hour = t.replace(minute=0)
        x = bt.fnum(val, -30 if var == "32" else 0, 60 if var == "32" else 300)
        if x is None:
            continue
        if var == "35":
            rain[hour] += x
        else:
            temp[hour].append(x)
    has_station = bool(ex["station"])

    for r in rows:
        t, fc = r["time"], r["fc"]
        m, w, g = m2.get(t, {}), wx.get(t, {}), gfs.get(t, {})
        if fc.get("marine_model") == "best_match":  # partitions only from the same model as the waves
            for k in EXTRA_MARINE:
                fc[k] = m.get(k)
        else:
            fc["sea_surface_temperature"] = m.get("sea_surface_temperature")
        fc.update({"precipitation": w.get("precipitation"),
                   "precipitation_probability": w.get("precipitation_probability"),
                   "weather_code": w.get("weather_code"), "cape": w.get("cape"),
                   "temperature_2m": w.get("temperature_2m"), "wind_gusts": w.get("wind_gusts_10m")})
        for k in GFS_VARS:
            fc[f"gfs_{k}"] = g.get(k)
        fc["valid_at"] = t
        o = r["obs"]
        r["obs_phys"] = {
            "valid_at": t, "swell_wave_height": o["wave_height"], "swell_wave_period": o["swell_wave_period"],
            "swell_wave_direction": o["wave_direction"], "wind_speed": o["wind_speed"],
            "wind_direction": o["wind_direction"],
            "precipitation": rain.get(t) if has_station else None,
            "temperature_2m": mean(temp[t]) if temp.get(t) else None,
            "sea_surface_temperature": fc.get("sea_surface_temperature"),
        }
        r["rain_measured"] = rain.get(t) if has_station and (t in rain or t in temp) else None
    return rows


def score_rows(rows: list[Row]) -> None:
    spot = bt.SPOT
    fc_series = physics.series_of(r["fc"] for r in rows)
    obs_series = physics.series_of(r["obs_phys"] for r in rows)
    for r in rows:
        fc, ob = r["fc"], r["obs_phys"]
        if fc.get("wave_height") is None:
            continue
        new = physics.evaluate(fc, spot, fc_series, r["daylight"])
        main_only = {k: v for k, v in fc.items() if not k.startswith(("secondary_", "wind_wave_"))}
        nomix = physics.evaluate(main_only, spot, fc_series, r["daylight"])
        r["new"], r["new_overall"], r["new_nomix"] = new, new["overall"], nomix["overall"]
        r["new_verdict"] = new["verdict"]
        if ob["swell_wave_height"] is not None and ob["wind_speed"] is not None:
            m = physics.evaluate(ob, spot, obs_series, r["daylight"])
            r["obs_new"], r["obs_new_overall"] = m, m["overall"]


# ---------- stats ----------

def rnd(x: float) -> int:
    return int(min(5, max(1, math.floor(x + 0.5))))


def compare(rows: list[Row], fkey: str, tkey: str) -> Row:
    pairs = [(rnd(r[fkey]), rnd(r[tkey])) for r in rows if r.get(fkey) is not None and r.get(tkey) is not None]
    s = bt.stats(pairs)
    cont = [abs(r[fkey] - r[tkey]) for r in rows if r.get(fkey) is not None and r.get(tkey) is not None]
    s["cont_mae"] = mean(cont) if cont else None
    return s


def weather_block(day: list[Row]) -> Row:
    wet = [r for r in day if (r.get("rain_measured") or 0) >= RAIN_MEASURED_MM and r.get("fc_score") is not None
           and r.get("new") is not None]
    dry = [r for r in day if r.get("rain_measured") == 0 and r.get("new") is not None]
    rain_pen = lambda r: any(c in ("rain", "drizzle") for c in r["new"]["comfort_causes"])  # noqa: E731
    thunder = [r for r in day if r.get("new") and any(w["kind"] == "thunder" for w in r["new"]["warnings"])]
    measured = [r for r in day if r.get("rain_measured") is not None]
    return {
        "hours_measured": len(measured),
        "wet_hours": len(wet),
        "old_go_in_rain": sum(r["fc_score"] >= GO for r in wet) / len(wet) if wet else None,
        "new_go_in_rain": sum(rnd(r["new_verdict"]) >= GO for r in wet) / len(wet) if wet else None,
        "new_flags_rain_when_wet": sum(rain_pen(r) for r in wet) / len(wet) if wet else None,
        "new_rain_penalty_when_dry": sum(rain_pen(r) for r in dry) / len(dry) if dry else None,
        "dry_hours": len(dry),
        "thunder_hours": len(thunder),
        "thunder_wet": sum((r.get("rain_measured") or 0) >= RAIN_MEASURED_MM for r in thunder),
    }


def window_block(day: list[Row]) -> Row:
    """Hours where the forecast swell came from outside the spot's swell window."""
    blocked = [r for r in day if r.get("new") and r["fc"].get("swell_wave_direction") is not None
               and physics.window_factor(r["fc"]["swell_wave_direction"], bt.SPOT) == 0
               and (r["fc"].get("swell_wave_height") or 0) >= 0.3 and r.get("obs_score") is not None]
    if not blocked:
        return {"n": 0}
    return {"n": len(blocked),
            "old_go": sum(r["fc_score"] >= GO for r in blocked) / len(blocked),
            "new_go": sum(rnd(r["new_overall"]) >= GO for r in blocked) / len(blocked),
            "told_go": sum(r["obs_score"] >= GO for r in blocked) / len(blocked),
            "tnew_go": sum(rnd(r["obs_new_overall"]) >= GO for r in blocked if r.get("obs_new_overall") is not None)
            / max(1, sum(r.get("obs_new_overall") is not None for r in blocked))}


# ---------- AI ----------

def ai_block(rows: list[Row]) -> Row:
    cut = START + (END - START) * bt.TRAIN_MONTHS / 12
    cut = datetime(cut.year, cut.month, cut.day, tzinfo=UTC)
    usable = [r for r in rows if r.get("fc_score") is not None and r.get("obs_score") is not None
              and r.get("obs_new") is not None and r.get("new") is not None]
    fc_series = physics.series_of(r["fc"] for r in rows)
    old_rows, new_rows = [], []
    for r in usable:
        x_old = bt.features(r["fc"], None, bt.SPOT, r["time"])
        x_old["simple_score"] = float(r["fc_score"])
        old_rows.append({"x": x_old, "overall": float(r["obs_score"]), "simple": float(r["fc_score"]),
                         "weight": 1.0, "row": r})
        x, res = train.model_input(r["fc"], bt.SPOT, fc_series, r["time"], None)
        new_rows.append({"x": x, "weight": 1.0, "row": r,
                         "physics_waves": res["waves"], "physics_shape": res["shape"],
                         "physics_overall": res["overall"],
                         "waves_t": r["obs_new"]["waves"], "shape_t": r["obs_new"]["shape"]})
    split = lambda rs: ([d for d in rs if d["row"]["time"] < cut], [d for d in rs if d["row"]["time"] >= cut])  # noqa: E731
    otr, ote = split(old_rows)
    ntr, nte = split(new_rows)
    old_model = train.fit(otr, "overall", train.OLD_FEATURES)
    bundle = {"engine": train.ENGINE, "waves": train.fit(ntr, "waves_t"), "shape": train.fit(ntr, "shape_t")}
    for d, p in zip(ote, train.predict(old_model, ote)):
        d["row"]["old_ai"] = float(p)
    for d, p in zip(nte, train.bundle_overall(bundle, nte)):
        d["row"]["new_ai"] = float(p)
    test = [d["row"] for d in nte if d["row"]["daylight"]]
    out: Row = {"n_train": len(ntr), "n_test_day": len(test)}
    for fkey in ("fc_score", "old_ai", "new_overall", "new_ai"):
        out[fkey] = {"T-old": compare(test, fkey, "obs_score"), "T-new": compare(test, fkey, "obs_new_overall")}
    wpred = train.corrected(bundle["waves"], nte, "physics_waves")
    spred = train.corrected(bundle["shape"], nte, "physics_shape")
    day_idx = [i for i, d in enumerate(nte) if d["row"]["daylight"]]
    out["waves_mae"] = {"physics": mean(abs(nte[i]["physics_waves"] - nte[i]["waves_t"]) for i in day_idx),
                        "ai": mean(abs(wpred[i] - nte[i]["waves_t"]) for i in day_idx)}
    out["shape_mae"] = {"physics": mean(abs(nte[i]["physics_shape"] - nte[i]["shape_t"]) for i in day_idx),
                        "ai": mean(abs(spred[i] - nte[i]["shape_t"]) for i in day_idx)}
    return out


# ---------- run ----------

def run(spot_id: str, offline: bool) -> Row:
    bt.configure(spot_id, None, offline)
    print(f"[engines] {spot_id}: window {bt.SPOT.get('swell_window_min')}-{bt.SPOT.get('swell_window_max')}, "
          f"normal {bt.SPOT['beach_orientation']:.0f}, wind {bt.XEMA}, weather {bt.SPOT.get('weather_station')}")
    rows = build(offline)
    score_rows(rows)
    day = [r for r in rows if r["daylight"]]
    res: Row = {"spot": spot_id, "hours_day": len(day)}
    for fkey, name in (("fc_score", "OLD simple"), ("new_overall", "NEW physics"), ("new_nomix", "NEW, no crossed-swell logic")):
        res[name] = {"T-old": compare(day, fkey, "obs_score"), "T-new": compare(day, fkey, "obs_new_overall")}
    res["waves_only"] = compare([{**r, "a": r["new"]["waves"], "b": r["obs_new"]["waves"]} for r in day
                                 if r.get("new") and r.get("obs_new")], "a", "b")
    res["weather"] = weather_block(day)
    res["window"] = window_block(day)
    res["ai"] = ai_block(rows)
    return res


def pct(x: float | None) -> str:
    return "–" if x is None else f"{x * 100:.0f}%"


def f2(x: float | None) -> str:
    return "–" if x is None else f"{x:.2f}"


def report(results: list[Row]) -> str:
    L = ["# Old engine vs new engine — backtest 22 Nov 2025 – 21 Nov 2026", "",
         "Daylight hours. Forecast = Open-Meteo archived short-lead forecast at the spot. "
         "T-old / T-new = old / physics rules applied to the MEASURED buoy + station numbers. "
         "LOCAL ONLY (derived from PORTUS data).", ""]
    L += ["## 1. Wave quality (no comfort)", "",
          "| Spot | Engine | truth | same score | within 1 | GO right | said GO, wasn't | missed GO | error (pts) |",
          "|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        for name in ("OLD simple", "NEW physics", "NEW, no crossed-swell logic"):
            for t in ("T-old", "T-new"):
                s = r[name][t]
                L.append(f"| {r['spot']} | {name} | {t} | {pct(s['exact'])} | {pct(s['within1'])} | "
                         f"{pct(s['go_right'])} | {pct(s['false_go'])} | {pct(s['missed_go'])} | {f2(s['cont_mae'])} |")
    L += ["", "## 2. Weather", "",
          "| Spot | measured hours | rainy hours | OLD said GO in rain | NEW said GO in rain | NEW flagged rain when wet | NEW rain penalty when dry | thunder flags (of them wet) |",
          "|---|---|---|---|---|---|---|---|"]
    for r in results:
        w = r["weather"]
        L.append(f"| {r['spot']} | {w['hours_measured']} | {w['wet_hours']} | {pct(w['old_go_in_rain'])} | "
                 f"{pct(w['new_go_in_rain'])} | {pct(w['new_flags_rain_when_wet'])} | {pct(w['new_rain_penalty_when_dry'])} | "
                 f"{w['thunder_hours']} ({w['thunder_wet']}) |")
    L += ["", "## 3. Swell from outside the window (forecast swell >= 0.3 m from a blocked direction)", "",
          "| Spot | hours | OLD said GO | NEW said GO | GO by T-old | GO by T-new |", "|---|---|---|---|---|---|"]
    for r in results:
        w = r["window"]
        if w["n"]:
            L.append(f"| {r['spot']} | {w['n']} | {pct(w['old_go'])} | {pct(w['new_go'])} | {pct(w['told_go'])} | {pct(w['tnew_go'])} |")
        else:
            L.append(f"| {r['spot']} | 0 | | | | |")
    L += ["", "## 4. AI (train 9 months, test last 3 months)", "",
          "| Spot | model | truth | same score | GO right | said GO, wasn't | missed GO | error (pts) |",
          "|---|---|---|---|---|---|---|---|"]
    names = {"fc_score": "OLD simple", "old_ai": "OLD AI", "new_overall": "NEW physics", "new_ai": "NEW AI"}
    for r in results:
        a = r["ai"]
        for k, nm in names.items():
            for t in ("T-old", "T-new"):
                s = a[k][t]
                L.append(f"| {r['spot']} | {nm} | {t} | {pct(s['exact'])} | {pct(s['go_right'])} | {pct(s['false_go'])} | "
                         f"{pct(s['missed_go'])} | {f2(s['cont_mae'])} |")
        L.append(f"| {r['spot']} | NEW AI parts | T-new | Waves error physics {f2(a['waves_mae']['physics'])} → AI "
                 f"{f2(a['waves_mae']['ai'])}; Shape {f2(a['shape_mae']['physics'])} → {f2(a['shape_mae']['ai'])} | | | | |")
    return "\n".join(L) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--spot", action="append", help="spot id (repeatable); default all 5")
    ap.add_argument("--offline", action="store_true", help="cached data only")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    results = [run(s, args.offline) for s in (args.spot or SPOTS)]
    text = report(results)
    out = bt.BASE / "engines.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    import json
    (bt.BASE / "engines.json").write_text(json.dumps(results, default=str, indent=1), encoding="utf-8")
    print(text)
    print(f"[engines] report: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
