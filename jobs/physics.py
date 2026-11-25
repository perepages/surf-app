"""Physics score (docs/surf_theory.md): Waves, Shape, Comfort + Safety flags, with reasons.

Rule-based and deterministic. Used as
  - the baseline the AI corrects (it predicts Waves and Shape separately),
  - the source of every derived feature the AI sees (`features`),
  - the fallback score when no model is active.
The app has a TypeScript copy (keep the two in sync; constants are named the same).

Scores are floats 1..5 (round half up for display):
  waves   = is there enough surfable energy reaching this beach? (breaking height, period,
            swell window)
  shape   = clean or messy? (wind vs beach, crossed swells, wind sea, gusts, leftover chop)
  overall = f(waves, shape): shape can only pull waves DOWN, and a small day can't fall far
  comfort = rain, cold, daylight (never mixed into waves/shape: rain doesn't make waves worse)
  verdict = overall adjusted by comfort for the user's preferences, forced to 1 by a
            thunderstorm or darkness, capped at 2 (or 1) when too big for the user's level
  warnings = safety flags (thunderstorm, polluted water after heavy rain, rip currents,
             too big for the user's level)

Inputs are `forecasts` rows (column names as stored). Standard library only.

  python -m jobs.physics --spot vilanova            # latest stored forecast, next 48 h
  python -m jobs.physics --spot vilanova --hours 96 --all-hours
"""
from __future__ import annotations

import argparse
import math
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

Row = dict[str, Any]

G = 9.81
COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]

# ---- swell window ----
WINDOW_TAPER_DEG = 15      # energy fades over the last 15 deg inside each window edge ...
WINDOW_LEAK = 0.25         # ... down to this share, also outside the window (unverified edges:
                           # some swell bends round a port; behind the coast, > 90 deg, stays 0)
# Open-Meteo's wave height is ~0.10 m below the buoy at the buoy's own position, at every size
# (12-month backtest 2025-26, buoy 1731: +0.07..+0.11 m). Added to FORECAST heights only.
FORECAST_HEIGHT_BIAS_M = 0.10
BIAS_FULL_FROM_M = 0.3
BLOCKED_BELOW = 0.3           # reason says "mostly blocked here" below this window factor       # ramps in from 0 at 0 m (the data covers forecasts >= 0.2 m)
MIN_TRAIN_HEIGHT = 0.05    # m; below this a train is "absent" (GFS writes 0.0 for none)

# ---- waves ----
# Breaking height (m) -> waves score, linear in between.
WAVES_STEPS = [(0.30, 1.0), (0.45, 2.0), (0.70, 3.0), (1.05, 4.0), (1.60, 5.0)]
SHORT_PERIOD_S = (4.0, 6.0)   # Komar over-estimates wind chop: x0.8 at <= 4 s .. x1 at >= 6 s
SHORT_PERIOD_FACTOR = 0.8
PERIOD_BONUS = [(5.0, -0.5), (8.0, 0.5)]  # T < 5 s: -0.5; T >= 8 s: +0.5 (Med: 8 s is good)
SAME_FAMILY_DEG = 30          # trains closer than this to the main one add size
CROSSED_DEG = 120             # 30-120 = crossed sea, > 120 = opposing

# ---- shape ----
WIND_BANDS = [5, 12, 20, 30]  # km/h upper limits of the table rows in surf_theory.md
WIND_TABLE = {                # one value per band: <5, 5-12, 12-20, 20-30, >30
    "offshore": [5.0, 5.0, 4.0, 2.0, 1.0],
    "cross":    [5.0, 4.0, 2.5, 2.0, 1.0],
    "onshore":  [4.5, 3.0, 2.0, 1.0, 1.0],
}
OFFSHORE_DEG = 135            # |wind - normal| >= 135 offshore, <= 45 onshore, else cross
ONSHORE_DEG = 45
CONFLICT_WEIGHT = 1.5         # shape -= 1.5 x conflict penalty ...
CONFLICT_MAX = 2.0            # ... at most 2 points
CLEAN_RATIO = (0.5, 0.75)     # < 0.5 messy (-1), 0.5-0.75 some mess (-0.5), > 0.75 clean
GUSTY_RATIO = 1.6
GUSTY_MIN_KMH = 8
LEFTOVER_ONSHORE_KMH = 20     # mean onshore component over the last 6 h -> leftover chop
MESS_SHOWN_FROM = 0.5         # explain crossed swells when they cost >= 0.5 shape points

# ---- comfort / safety ----
RAIN_HEAVY = (60, 1.0)        # probability % and mm/h
RAIN_LIGHT = (40, 0.1)
COLD_AIR_C = 10
COLD_WATER_C = 14
THUNDER_CODES = {95, 96, 99}
THUNDER_CAPE = 1000           # J/kg, with rain likely
POLLUTION_RAIN_MM = 20        # in any 24 h of the last 72 h
RIP_BREAKING_M = 1.5
RIP_FRONTAL_DEG = 20
LEVEL_MAX_M = {"beginner": 0.8, "intermediate": 1.5, "advanced": None}
TOO_BIG_CAP = 2.0             # above your limit: verdict at most 2 (MAYBE) ...
TOO_BIG_SKIP_RATIO = 1.5      # ... and 1 (SKIP) above 1.5 x your limit
COMFORT_WEIGHT = 0.5          # verdict = overall - 0.5 x (5 - comfort)


# ---------- small helpers ----------

def num(x: Any) -> float | None:
    return None if x is None else float(x)


def diff(a: float, b: float) -> float:
    """Signed a - b in -180..180."""
    return (a - b + 180.0) % 360.0 - 180.0


def compass(deg: float) -> str:
    return COMPASS[int(((deg % 360) + 11.25) // 22.5) % 16]


def clamp(x: float, lo: float = 1.0, hi: float = 5.0) -> float:
    return max(lo, min(hi, x))


def interp(x: float, steps: list[tuple[float, float]]) -> float:
    if x <= steps[0][0]:
        return steps[0][1]
    for (x0, y0), (x1, y1) in zip(steps, steps[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return steps[-1][1]


def round_half_up(x: float) -> int:
    return int(math.floor(x + 0.5))


def fmt(x: float, digits: int = 0) -> str:
    """Number for text, halves rounded up (as the app does), e.g. fmt(10.5) = '11'."""
    k = 10 ** digits
    return f"{math.floor(x * k + 0.5) / k:.{digits}f}"


def spot_geometry(spot: Row) -> tuple[float, float, float]:
    """(normal, window_min, window_max); no window stored = normal +- 90."""
    n = float(spot["beach_orientation"])
    lo, hi = spot.get("swell_window_min"), spot.get("swell_window_max")
    if lo is None or hi is None:
        return n, (n - 90) % 360, (n + 90) % 360
    return n, float(lo), float(hi)


def window_factor(direction: float | None, spot: Row) -> float:
    """Share of a train's energy reaching the beach: cos(angle to normal) x soft window edge."""
    if direction is None:
        return 1.0
    n, lo, hi = spot_geometry(spot)
    cos_part = max(0.0, math.cos(math.radians(diff(direction, n))))
    width = (hi - lo) % 360
    into = (direction - lo) % 360
    if into > width:
        return cos_part * WINDOW_LEAK  # outside the window: mostly blocked by a cape or port
    edge = min(into, width - into)
    return cos_part * max(WINDOW_LEAK, min(1.0, edge / WINDOW_TAPER_DEG))


def komar_breaking_height(h0: float, period: float) -> float:
    """Komar & Gaughan (1972) breaker height, shrunk for short-period wind chop."""
    if h0 <= 0 or period <= 0:
        return 0.0
    hb = 0.39 * G ** 0.2 * (period * h0 ** 2) ** 0.4
    lo, hi = SHORT_PERIOD_S
    short = SHORT_PERIOD_FACTOR + (1 - SHORT_PERIOD_FACTOR) * min(1.0, max(0.0, (period - lo) / (hi - lo)))
    return hb * short


def conflict_weight(angle: float) -> float:
    if angle < SAME_FAMILY_DEG:
        return 0.0
    return 0.5 if angle <= CROSSED_DEG else 1.0


def wind_relation(wind_from: float, normal: float) -> str:
    a = abs(diff(wind_from, normal))
    if a >= OFFSHORE_DEG:
        return "offshore"
    if a <= ONSHORE_DEG:
        return "onshore"
    return "cross"


def wind_table_score(speed: float, relation: str) -> float:
    band = sum(speed >= b for b in WIND_BANDS)
    return WIND_TABLE[relation][band]


# ---------- wave trains ----------

# How a train that is NOT the main one is named ("swell" = Open-Meteo's primary partition, which
# isn't the main one when another swell brings more energy into this beach's window).
TRAIN_NAMES = {"swell": "Another swell", "secondary_swell": "Secondary swell",
               "tertiary_swell": "Third swell", "wind": "Wind waves"}


def trains(row: Row, spot: Row, prefix: str = "") -> list[Row]:
    """The wave trains of one model set ('' = best_match columns, 'gfs_' = GFS set)."""
    out = []
    for part in ("swell", "secondary_swell", "tertiary_swell", "wind"):
        h = num(row.get(f"{prefix}{part}_wave_height"))
        t = num(row.get(f"{prefix}{part}_wave_period"))
        d = num(row.get(f"{prefix}{part}_wave_direction"))
        if h is None or h < MIN_TRAIN_HEIGHT or not t:
            continue
        f = window_factor(d, spot)
        energy = h * h * t
        out.append({"part": part, "height": h, "period": t, "direction": d,
                    "factor": f, "energy": energy, "energy_eff": energy * f})
    return out


def mix(train_list: list[Row]) -> Row:
    """Main train, combined size of its family, cleanliness and conflict penalty."""
    swells = [t for t in train_list if t["part"] != "wind"]
    pool = [t for t in swells if t["energy_eff"] > 0] or [t for t in train_list if t["energy_eff"] > 0]
    if not pool:
        biggest = max(train_list, key=lambda t: t["energy"], default=None)
        return {"main": None, "outside": biggest, "others": [], "cleanliness": None,
                "conflict_penalty": 0.0, "family_height": 0.0, "other_energy": 0.0}
    main = max(pool, key=lambda t: t["energy_eff"])
    others, family_h2, other_e, penalty = [], main["height"] ** 2 * main["factor"], 0.0, 0.0
    for t in train_list:
        if t is main or t["energy_eff"] <= 0:
            continue
        angle = abs(diff(t["direction"], main["direction"])) if (
            t["direction"] is not None and main["direction"] is not None) else 0.0
        share = t["energy_eff"] / main["energy_eff"]
        w = conflict_weight(angle)
        if w == 0.0:
            family_h2 += t["height"] ** 2 * t["factor"]  # same family (incl. wind sea): adds size
        else:
            other_e += t["energy_eff"]
            penalty += share * w
        others.append({**t, "angle": angle, "share": share, "weight": w})
    total = main["energy_eff"] + other_e
    return {"main": main, "outside": None, "others": others,
            "cleanliness": main["energy_eff"] / total if total else None,
            "conflict_penalty": penalty, "family_height": math.sqrt(family_h2),
            "other_energy": other_e}


# ---------- history (wind 6/12/24 h, rain 24/72 h) ----------

def _at(series: dict[datetime, Row], t: datetime) -> Row | None:
    return series.get(t)


def wind_history(series: dict[datetime, Row], t: datetime, hours: int, normal: float
                 ) -> tuple[float | None, float | None]:
    """Mean speed and mean ONSHORE component (km/h, + = onshore) over the `hours` before t."""
    speeds, onshore = [], []
    for k in range(1, hours + 1):
        r = _at(series, t - timedelta(hours=k))
        if not r or r.get("wind_speed") is None or r.get("wind_direction") is None:
            continue
        s = float(r["wind_speed"])
        speeds.append(s)
        onshore.append(s * math.cos(math.radians(diff(float(r["wind_direction"]), normal))))
    if len(speeds) < hours / 2:
        return None, None
    return sum(speeds) / len(speeds), sum(onshore) / len(onshore)


def rain_sum(series: dict[datetime, Row], t: datetime, hours: int) -> float | None:
    vals = [series[t - timedelta(hours=k)].get("precipitation")
            for k in range(hours) if t - timedelta(hours=k) in series]
    vals = [v for v in vals if v is not None]
    return sum(vals) if len(vals) >= hours / 2 else None


def max_rain_24h(series: dict[datetime, Row], t: datetime, back: int = 72) -> float | None:
    sums = [rain_sum(series, t - timedelta(hours=k), 24) for k in range(0, back - 23, 6)]
    sums = [s for s in sums if s is not None]
    return max(sums) if sums else None


# ---------- features ----------

def features(row: Row, spot: Row, series: dict[datetime, Row] | None = None,
             daylight: bool | None = None, forecast: bool = True) -> Row:
    """Every raw input + derived value, flat, for the score and the AI (None = unknown).
    forecast=False for measured numbers (buoy): no FORECAST_HEIGHT_BIAS_M added."""
    normal = spot_geometry(spot)[0]
    t = row["valid_at"] if isinstance(row["valid_at"], datetime) else parse_time(row["valid_at"])
    series = series or {}
    m = mix(trains(row, spot))
    g = mix(trains(row, spot, "gfs_"))
    main = m["main"]
    f: Row = {}

    # main train + derived energy / breaking height
    f["main_part"] = main["part"] if main else None
    f["main_height"] = main["height"] if main else 0.0
    f["main_period"] = main["period"] if main else 0.0
    f["main_direction"] = main["direction"] if main else None
    f["main_angle"] = diff(main["direction"], normal) if main and main["direction"] is not None else None
    f["main_window_factor"] = main["factor"] if main else 0.0
    f["main_energy"] = main["energy"] if main else 0.0
    f["main_power_kw"] = 0.49 * f["main_energy"]
    f["main_wavelength_m"] = 1.56 * f["main_period"] ** 2
    h0 = m["family_height"]
    if forecast and h0 > 0:
        # the bias is in metres of total height; scale it by how much of it reaches the beach
        h0 += FORECAST_HEIGHT_BIAS_M * math.sqrt(main["factor"]) * min(1.0, h0 / BIAS_FULL_FROM_M)
    f["breaking_height"] = komar_breaking_height(h0, f["main_period"])
    f["other_energy"] = m["other_energy"]
    f["cleanliness"] = m["cleanliness"]
    f["conflict_penalty"] = m["conflict_penalty"]
    for part in ("swell", "secondary_swell", "wind"):
        tr = next((x for x in trains(row, spot) if x["part"] == part), None)
        f[f"{part}_energy_eff"] = tr["energy_eff"] if tr else 0.0
        f[f"{part}_angle_to_main"] = (abs(diff(tr["direction"], main["direction"]))
                                      if tr and main and tr is not main and tr["direction"] is not None
                                      and main["direction"] is not None else None)
    # second opinion from GFS-Wave (has a tertiary swell); AI only
    f["gfs_cleanliness"] = g["cleanliness"]
    f["gfs_conflict_penalty"] = g["conflict_penalty"]
    f["gfs_breaking_height"] = komar_breaking_height(
        g["family_height"], g["main"]["period"]) if g["main"] else (0.0 if row.get("gfs_swell_wave_height") is not None else None)
    tert = next((x for x in trains(row, spot, "gfs_") if x["part"] == "tertiary_swell"), None)
    f["gfs_tertiary_energy_eff"] = tert["energy_eff"] if tert else (
        0.0 if row.get("gfs_tertiary_swell_wave_height") is not None else None)

    # combined sea state (as before) for reference
    f["wave_height"] = num(row.get("wave_height"))
    f["wave_period"] = num(row.get("wave_period"))

    # wind now + history
    ws, wd, gust = num(row.get("wind_speed")), num(row.get("wind_direction")), num(row.get("wind_gusts"))
    f["wind_speed"], f["wind_gusts"] = ws, gust
    f["wind_rel"] = diff(wd, normal) if wd is not None else None  # 0 = onshore, +-180 = offshore
    f["wind_onshore"] = ws * math.cos(math.radians(f["wind_rel"])) if ws is not None and wd is not None else None
    f["wind_cross"] = abs(ws * math.sin(math.radians(f["wind_rel"]))) if ws is not None and wd is not None else None
    f["gust_ratio"] = gust / ws if gust is not None and ws else None
    for hours in (6, 12, 24):
        mean, onshore = wind_history(series, t, hours, normal)
        f[f"wind_mean_{hours}h"], f[f"wind_onshore_{hours}h"] = mean, onshore

    # tide, weather
    f["sea_level"] = num(row.get("sea_level_height"))
    for col in ("precipitation", "precipitation_probability", "weather_code", "cape",
                "temperature_2m", "sea_surface_temperature"):
        f[col] = num(row.get(col))
    f["rain_24h"] = rain_sum(series, t, 24)
    f["rain_max24h_72h"] = max_rain_24h(series, t)
    f["daylight"] = daylight
    return f


# ---------- scores ----------

def waves_score(f: Row) -> float:
    if not f["main_part"] or f["breaking_height"] <= 0:
        return 1.0
    s = interp(f["breaking_height"], WAVES_STEPS)
    if s > 1.0:
        if f["main_period"] < PERIOD_BONUS[0][0]:
            s += PERIOD_BONUS[0][1]
        elif f["main_period"] >= PERIOD_BONUS[1][0]:
            s += PERIOD_BONUS[1][1]
    return clamp(s)


def shape_parts(f: Row) -> list[tuple[str, float]]:
    """(cause, points lost) that pull Shape below 5."""
    parts: list[tuple[str, float]] = []
    if f["wind_speed"] is not None and f["wind_rel"] is not None:
        rel = "offshore" if abs(f["wind_rel"]) >= OFFSHORE_DEG else (
            "onshore" if abs(f["wind_rel"]) <= ONSHORE_DEG else "cross")
        parts.append(("wind", 5.0 - wind_table_score(f["wind_speed"], rel)))
        if (f["gust_ratio"] or 0) > GUSTY_RATIO and f["wind_speed"] >= GUSTY_MIN_KMH:
            parts.append(("gusts", 0.5))
    if f["conflict_penalty"]:
        parts.append(("crossed", min(CONFLICT_MAX, CONFLICT_WEIGHT * f["conflict_penalty"])))
    c = f["cleanliness"]
    if c is not None and c <= CLEAN_RATIO[1]:
        parts.append(("mixed", 1.0 if c < CLEAN_RATIO[0] else 0.5))
    leftover = f.get("wind_onshore_6h")
    if leftover is not None and leftover >= LEFTOVER_ONSHORE_KMH and (f["wind_onshore"] or 0) < 10:
        parts.append(("leftover", 0.5))
    return [p for p in parts if p[1] > 0]


def mess_points(f: Row) -> float:
    return sum(v for k, v in shape_parts(f) if k in ("crossed", "mixed"))


def shape_score(f: Row) -> float:
    return clamp(5.0 - sum(p for _, p in shape_parts(f)))


def overall_score(waves: float, shape: float) -> float:
    """Shape scales the size: perfect shape keeps waves, blown out keeps 40 % above flat."""
    return clamp(1 + (waves - 1) * (0.4 + 0.6 * (shape - 1) / 4))


def comfort_parts(f: Row, mind_rain: bool = False) -> list[tuple[str, float]]:
    parts: list[tuple[str, float]] = []
    prob, mm = f["precipitation_probability"], f["precipitation"]
    if not mind_rain and (prob is not None or mm is not None):
        p, r = prob or 0, mm or 0
        if p > RAIN_HEAVY[0] and r > RAIN_HEAVY[1]:
            parts.append(("rain", 2.5))
        elif r >= RAIN_LIGHT[1] or p > RAIN_LIGHT[0]:
            parts.append(("drizzle", 1.0))
    if f["temperature_2m"] is not None and f["temperature_2m"] < COLD_AIR_C:
        parts.append(("cold_air", 0.5))
    if f["sea_surface_temperature"] is not None and f["sea_surface_temperature"] < COLD_WATER_C:
        parts.append(("cold_water", 0.5))
    return parts


def comfort_score(f: Row, mind_rain: bool = False) -> float:
    if f["daylight"] is False:
        return 1.0
    return clamp(5.0 - sum(p for _, p in comfort_parts(f, mind_rain)))


def wetsuit(sst: float | None) -> str | None:
    if sst is None:
        return None
    if sst < 13:
        return "5/4 mm + boots"
    if sst < 16:
        return "4/3 mm"
    if sst < 20:
        return "3/2 mm"
    return "shorty or none"


def safety(f: Row, prefs: Row | None = None) -> list[Row]:
    """Flags: {'kind', 'text', 'skip' (forces the verdict to 1), 'cap' (verdict at most this)}."""
    out = []
    code, cape = f["weather_code"], f["cape"]
    rainy = (f["precipitation"] or 0) >= 0.5 or (f["precipitation_probability"] or 0) >= 60
    if (code is not None and int(code) in THUNDER_CODES) or ((cape or 0) >= THUNDER_CAPE and rainy):
        out.append({"kind": "thunder", "skip": True,
                    "text": "Thunderstorm risk: lightning, stay out of the water"})
    if (f["rain_max24h_72h"] or 0) >= POLLUTION_RAIN_MM:
        out.append({"kind": "water_quality", "skip": False,
                    "text": f"{fmt(f['rain_max24h_72h'])} mm of rain in a day recently: water near "
                            "drains and river mouths may be polluted for 2-3 days"})
    hb, angle = f["breaking_height"], f["main_angle"]
    if hb >= RIP_BREAKING_M and angle is not None and abs(angle) < RIP_FRONTAL_DEG:
        out.append({"kind": "rip", "skip": False,
                    "text": "Big waves straight onto the beach: strong rip currents likely"})
    limit = size_limit(prefs)
    if limit is not None and hb > limit:
        out.append({"kind": "too_big", "skip": False,
                    "cap": 1.0 if hb > TOO_BIG_SKIP_RATIO * limit else TOO_BIG_CAP,
                    "text": f"Waves around {fmt(hb, 1)} m: above your limit of {fmt(limit, 1)} m"})
    return out


def size_limit(prefs: Row | None) -> float | None:
    if not prefs:
        return None
    limits = [v for v in (LEVEL_MAX_M.get(prefs.get("level") or ""), prefs.get("max_wave_m"))
              if v is not None]
    return min(limits) if limits else None


# ---------- reason text ----------

def _wind_words(f: Row) -> str:
    ws, rel = f["wind_speed"], f["wind_rel"]
    if ws is None or rel is None:
        return "wind unknown"
    kind = "offshore" if abs(rel) >= OFFSHORE_DEG else "onshore" if abs(rel) <= ONSHORE_DEG else "cross-shore"
    if ws < 5:
        return "no wind"
    if ws < 12:
        return f"light {kind}"
    return f"{fmt(ws)} km/h {kind}"


def mess_text(row: Row, spot: Row) -> str | None:
    """'Secondary swell from the SE is crossing the main SW swell -> peaky and inconsistent'."""
    m = mix(trains(row, spot))
    if not m["main"] or m["main"]["direction"] is None:
        return None
    worst = max((o for o in m["others"] if o["weight"] > 0), default=None,
                key=lambda o: o["share"] * o["weight"])
    if worst is None or worst["share"] * worst["weight"] < 0.15:
        return None
    main_dir = compass(m["main"]["direction"])
    what = TRAIN_NAMES[worst["part"]]
    frm = compass(worst["direction"]) if worst["direction"] is not None else "another direction"
    if worst["weight"] >= 1.0:
        return (f"{what} from the {frm} is running against the main {main_dir} swell: "
                "bumpy faces, sets break unpredictably")
    if worst["part"] == "wind":
        return f"Wind waves from the {frm} on top of the {main_dir} swell: choppy surface"
    return (f"{what} from the {frm} is crossing the main {main_dir} swell at {fmt(worst['angle'])}°: "
            "peaky and inconsistent")


def reason(f: Row, row: Row, spot: Row, flags: list[Row], comfort: list[tuple[str, float]],
           waves: float, shape: float) -> str:
    if any(x["kind"] == "thunder" for x in flags):
        return "Thunderstorm risk: don't go in the water"
    if f["daylight"] is False:
        return "After dark"
    if not f["main_part"]:
        m = mix(trains(row, spot))
        out = m["outside"]
        if out and out["height"] >= 0.3 and out["direction"] is not None:
            return (f"{fmt(out['height'], 1)} m from the {compass(out['direction'])}, but it can't "
                    "reach this beach")
        return "Flat"
    hb, period = f["breaking_height"], f["main_period"]
    size = f"{fmt(hb, 1)} m at {fmt(period)} s from the {compass(f['main_direction'] or 0)}"
    if f["main_window_factor"] < BLOCKED_BELOW:
        size += " (mostly blocked here)"
    if overall_score(waves, shape) < 1.5:
        text = f"Too small: {size}"
    else:
        parts = dict(shape_parts(f))
        worst = max(parts, key=parts.get) if parts else None
        clean = "Clean" if shape >= 4.5 else "Fairly clean" if shape >= 3.5 else (
            "Bumpy" if shape >= 2.5 else "Messy")
        text = f"{clean} {size}, {_wind_words(f)}"
        if worst == "leftover":
            text += ", still choppy from the earlier onshore wind"
        elif worst in ("crossed", "mixed") and parts[worst] >= 0.5:
            text += ", other swells mixing in"
        elif worst == "gusts":
            text += ", gusty"
    weather = dict(comfort)
    prob = f["precipitation_probability"]
    if "rain" in weather or "drizzle" in weather:
        text += f", but {fmt(prob)}% chance of rain" if prob else ", but some rain"
    return text


# ---------- entry points ----------

def evaluate(row: Row, spot: Row, series: dict[datetime, Row] | None = None,
             daylight: bool | None = None, prefs: Row | None = None, forecast: bool = True) -> Row:
    prefs = prefs or {}
    f = features(row, spot, series, daylight, forecast)
    waves, shape = waves_score(f), shape_score(f)
    overall = overall_score(waves, shape)
    mind_rain = bool(prefs.get("dont_mind_rain"))  # "I don't mind rain"
    cparts = comfort_parts(f, mind_rain)
    comfort = comfort_score(f, mind_rain)
    flags = safety(f, prefs)
    verdict = clamp(overall - COMFORT_WEIGHT * (5.0 - comfort))
    for x in flags:
        verdict = min(verdict, x.get("cap", 5.0))
    if f["daylight"] is False or any(x["skip"] for x in flags):
        verdict = 1.0
    return {
        "waves": round(waves, 2), "shape": round(shape, 2), "overall": round(overall, 2),
        "comfort": round(comfort, 2), "verdict": round(verdict, 2),
        "reason": reason(f, row, spot, flags, cparts, waves, shape),
        "mess": mess_text(row, spot) if waves >= 1.5 and mess_points(f) >= MESS_SHOWN_FROM else None,
        "warnings": flags, "wetsuit": wetsuit(f["sea_surface_temperature"]),
        "comfort_causes": [k for k, _ in cparts],  # rain / drizzle / cold_air / cold_water
        "features": f,
    }


def parse_time(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def series_of(rows: Iterable[Row]) -> dict[datetime, Row]:
    """Index rows by valid_at (later rows win), for wind/rain history."""
    out: dict[datetime, Row] = {}
    for r in rows:
        t = r["valid_at"] if isinstance(r["valid_at"], datetime) else parse_time(r["valid_at"])
        out[t] = r
    return out


def evaluate_series(rows: list[Row], spot: Row, history: list[Row] | None = None,
                    sun: dict[str, tuple[datetime, datetime]] | None = None,
                    prefs: Row | None = None) -> list[Row]:
    """Evaluate forecast `rows`; `history` = earlier hours (e.g. lead-0 rows of past runs).
    `sun` = {'YYYY-MM-DD' (UTC date): (sunrise, sunset)} for the daylight flag."""
    series = series_of([*(history or []), *rows])
    out = []
    for r in rows:
        t = parse_time(r["valid_at"]) if isinstance(r["valid_at"], str) else r["valid_at"]
        daylight = None
        if sun and t.strftime("%Y-%m-%d") in sun:
            rise, set_ = sun[t.strftime("%Y-%m-%d")]
            daylight = rise <= t + timedelta(minutes=30) <= set_
        out.append({"valid_at": t, **evaluate(r, spot, series, daylight, prefs)})
    return out


# ---------- CLI ----------

def _sun_times(spot: Row) -> dict[str, tuple[datetime, datetime]]:
    import json
    import urllib.parse
    import urllib.request
    q = urllib.parse.urlencode({"latitude": spot["lat"], "longitude": spot["lon"],
                                "daily": "sunrise,sunset", "timezone": "UTC",
                                "past_days": 1, "forecast_days": 5})
    with urllib.request.urlopen(f"https://api.open-meteo.com/v1/forecast?{q}", timeout=30) as r:
        d = json.load(r)["daily"]
    return {day: (parse_time(a + "Z"), parse_time(b + "Z"))
            for day, a, b in zip(d["time"], d["sunrise"], d["sunset"])}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--spot", default="vilanova")
    ap.add_argument("--hours", type=int, default=48)
    ap.add_argument("--all-hours", action="store_true", help="also show night hours")
    ap.add_argument("--mind-rain", action="store_true", help='as "I don\'t mind rain"')
    ap.add_argument("--level", choices=list(LEVEL_MAX_M))
    args = ap.parse_args()

    import urllib.parse
    from jobs.check_connections import ROOT, env, load_dotenv
    from jobs.collect_forecast import Supabase, http
    from jobs.explore import simple_score
    load_dotenv(ROOT / ".env")
    db = Supabase(env("SUPABASE_URL") or "", env("SUPABASE_SERVICE_ROLE_KEY") or "")
    spot = http(f"{db.base}/spots?id=eq.{urllib.parse.quote(args.spot)}&select=*", db.headers)[0]
    latest = http(f"{db.base}/forecasts?spot_id=eq.{args.spot}&select=fetched_at"
                  "&order=fetched_at.desc&limit=1", db.headers)[0]["fetched_at"]
    latest = parse_time(latest).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = http(f"{db.base}/forecasts?spot_id=eq.{args.spot}&fetched_at=eq.{latest}"
                f"&lead_hours=lte.{args.hours}&order=valid_at&select=*", db.headers)
    since = (parse_time(latest) - timedelta(hours=72)).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Past hours from every earlier run (the hourly job doesn't run every hour on GitHub);
    # oldest run first, so series_of keeps the newest numbers for each hour.
    history = http(f"{db.base}/forecasts?spot_id=eq.{args.spot}"
                   f"&valid_at=gte.{since}&valid_at=lt.{latest}&order=fetched_at.desc"
                   "&select=*&limit=1000", db.headers)[::-1]
    prefs = {"dont_mind_rain": args.mind_rain, "level": args.level}
    results = evaluate_series(rows, spot, history, _sun_times(spot), prefs)
    print(f"{spot['name']}: normal {spot['beach_orientation']}, window "
          f"{spot.get('swell_window_min')}-{spot.get('swell_window_max')}; run {latest}; "
          f"{len(series_of(history))} history hours")
    print(" hour (UTC)       old  waves shape overall comfort VERDICT  reason / mess / warnings")
    for row, res in zip(rows, results):
        if res["features"]["daylight"] is False and not args.all_hours:
            continue
        old = simple_score(row, spot["beach_orientation"])
        line = (f" {res['valid_at']:%a %d %H:%M}   {old}   {res['waves']:4.1f}  {res['shape']:4.1f}"
                f"  {res['overall']:4.1f}    {res['comfort']:4.1f}   {round_half_up(res['verdict'])}"
                f"   {res['reason']}")
        print(line)
        if res["mess"]:
            print(" " * 52 + "~ " + res["mess"])
        for w in res["warnings"]:
            print(" " * 52 + "! " + w["text"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
