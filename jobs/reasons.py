"""Plain-words reason for an AI score, e.g. "Offshore wind under 15 km/h — usually better than forecast here".

Shown in the app under the score when the AI changes the 1-5 value the physics score would
show. Written by jobs/predict.py into `predictions.reason`.

How the cause is found (SHAP-style, computed exactly, no extra library):
  The AI score = overall(physics Waves + waves correction, physics Shape + shape correction)
  (jobs/train.py, engine physics-v1). The conditions are split into 8 groups (wind, wind
  history, swell, crossed swells, tide, weather, time of day, season). For every one of the
  2^8 = 256 combinations the groups left out are set to their ordinary value (training median,
  bundle["reference"]) and both models are asked again, with the physics scores of the hour
  kept fixed; each group's Shapley value is its average effect over all combinations. They add
  up exactly to: AI(this hour) - AI(this hour with ordinary conditions). The rest is how this
  spot differs from the physics rules in general ("Days like this").

Which words:
  - The AI must change the shown 1-5 value, else no reason (the app shows the physics reason).
  - The group pushing hardest in the direction of the change is named, if it pushes at least
    MIN_PUSH points and more than the general spot difference; a second group is added when it
    pushes at least half as hard. Otherwise: "Days like this — usually ... than forecast here".
  - Conditions are named by range, not exact numbers ("under 15 km/h", "short-period swell"),
    because the model learned from ranges of similar days, not from that one number.
Lead time and the physics scores themselves stay fixed: they're never a reason.
"""
from __future__ import annotations

import math
from typing import Any, Callable, Sequence

import numpy as np

from jobs import physics
from jobs.train import corrected

Row = dict[str, Any]

GROUPS = {
    "wind": ["wind_speed", "wind_gusts", "wind_rel", "wind_onshore", "wind_cross", "gust_ratio"],
    "wind_history": ["wind_mean_6h", "wind_onshore_6h", "wind_mean_12h", "wind_onshore_12h",
                     "wind_mean_24h", "wind_onshore_24h"],
    "swell": ["main_height", "main_period", "main_angle", "main_window_factor", "main_energy",
              "main_power_kw", "main_wavelength_m", "breaking_height", "main_part_code",
              "wave_height", "wave_period", "gfs_breaking_height"],
    "mix": ["other_energy", "cleanliness", "conflict_penalty", "swell_energy_eff",
            "swell_angle_to_main", "secondary_swell_energy_eff", "secondary_swell_angle_to_main",
            "wind_energy_eff", "wind_angle_to_main", "gfs_cleanliness", "gfs_conflict_penalty",
            "gfs_tertiary_energy_eff"],
    "tide": ["sea_level"],
    "weather": ["precipitation", "precipitation_probability", "weather_code", "cape",
                "temperature_2m", "sea_surface_temperature", "rain_24h", "rain_max24h_72h"],
    "time": ["solar_hour"],
    "season": ["month"],
}
SWELL_PARTS = ["breaking_height", "main_period", "main_angle"]  # size / period / direction
MIN_PUSH = 0.15    # points; smaller effects aren't worth naming
SECOND_SHARE = 0.5  # a second cause is named if it pushes at least half as hard as the first


def ai_overall(bundle: Row, rows: Sequence[Row]) -> np.ndarray:
    """overall(AI waves, AI shape) with each row's physics scores as baselines."""
    w = corrected(bundle.get("waves"), list(rows), "physics_waves")
    s = corrected(bundle.get("shape"), list(rows), "physics_shape")
    return np.array([physics.overall_score(a, b) for a, b in zip(w, s)])


# ---------- Shapley values per group ----------

def _weights(n: int) -> list[float]:
    """Shapley weight for a coalition of size s (not containing the group): s!(n-s-1)!/n!"""
    return [math.factorial(s) * math.factorial(n - s - 1) / math.factorial(n) for s in range(n)]


def _masked(row: Row, keep: Callable[[str], bool], ref: dict[str, float]) -> Row:
    x = dict(row["x"])
    for name, feats in GROUPS.items():
        if keep(name):
            continue
        for f in feats:
            if f in x and not math.isnan(ref.get(f, float("nan"))):
                x[f] = ref[f]
    return {**row, "x": x}


def group_shapley(bundle: Row, rows: Sequence[Row], ref: dict[str, float]
                  ) -> tuple[np.ndarray, np.ndarray]:
    """(phi[row, group], base[row]): per-group Shapley values of the AI overall, and the AI
    overall with every group at its reference value. phi.sum(1) + base = AI overall."""
    names = list(GROUPS)
    n, masks = len(names), 1 << len(names)
    variants = [_masked(r, lambda name, m=mask: bool(m >> names.index(name) & 1), ref)
                for r in rows for mask in range(masks)]
    v = ai_overall(bundle, variants).reshape(len(rows), masks)
    w = _weights(n)
    phi = np.zeros((len(rows), n))
    for g in range(n):
        bit = 1 << g
        for mask in range(masks):
            if not mask & bit:
                phi[:, g] += w[bin(mask).count("1")] * (v[:, mask | bit] - v[:, mask])
    return phi, v[:, 0]


# ---------- words ----------

def _cap(s: str) -> str:
    return s[:1].upper() + s[1:]


def _low(s: str) -> str:
    return s[:1].lower() + s[1:]


def swell_parts(bundle: Row, row: Row, ref: dict[str, float], sign: int) -> set[str]:
    """Which of size / period / direction actually push the score the way it moved: each is
    set to its ordinary value alone; those causing at least 30% of the biggest push are named."""
    feats = [f for f in SWELL_PARTS if not math.isnan(ref.get(f, float("nan")))]
    variants = [row] + [{**row, "x": {**row["x"], f: ref[f]}} for f in feats]
    v = ai_overall(bundle, variants)
    push = {f: sign * (v[0] - v[k + 1]) for k, f in enumerate(feats)}
    top = max(push.values(), default=0)
    return {f for f, p in push.items() if top > 0 and p >= 0.3 * top} or set(feats)


def _val(x: Row, key: str) -> float | None:
    v = x.get(key)
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else float(v)


def phrase(group: str, x: Row, cond: Row, ref: dict[str, float], normal: float,
           parts: set[str] | None = None) -> str:
    """The condition as a range in plain words, capitalised."""
    if group == "wind":
        speed, direction = cond.get("wind_speed"), cond.get("wind_direction")
        if speed is None:
            return "This wind"
        if speed < 5:
            return "Almost no wind"
        rel = "" if direction is None else {"offshore": "Offshore ", "cross": "Cross-shore ",
                                            "onshore": "Onshore "}[physics.wind_relation(direction, normal)]
        size = ("under 15 km/h" if speed < 15 else "15–25 km/h" if speed < 25 else
                "25–35 km/h" if speed < 35 else "over 35 km/h")
        return _cap(f"{rel}wind {size}")
    if group == "wind_history":
        onshore, mean = _val(x, "wind_onshore_12h"), _val(x, "wind_mean_12h")
        if onshore is not None and onshore >= 15:
            return "After hours of onshore wind"
        if onshore is not None and onshore <= -10:
            return "After hours of offshore wind"
        if mean is not None and mean < 8:
            return "After a calm spell"
        return "The wind of the last hours"
    if group == "swell":
        hb, period, angle = _val(x, "breaking_height"), _val(x, "main_period"), _val(x, "main_angle")
        if not hb:
            return "No real swell"
        parts = parts if parts is not None else set(SWELL_PARTS)
        size = ("small " if hb < 0.5 else "big " if hb >= 1.2 else "") if "breaking_height" in parts else ""
        per = ("" if not period else "short-period " if period < 6 else "long-period " if period >= 9
               else "mid-period ") if "main_period" in parts else ""
        where = (f" from the {physics.compass(normal + angle)}"
                 if angle is not None and "main_angle" in parts else "")
        return _cap(f"{size}{per}swell{where}")
    if group == "mix":
        clean, conflict = _val(x, "cleanliness"), _val(x, "conflict_penalty") or 0
        if conflict >= 0.3:
            return "Crossed swells"
        if clean is not None and clean > physics.CLEAN_RATIO[1]:
            return "One clean swell"
        return "A mixed-up sea"
    if group == "tide":
        level, usual = _val(x, "sea_level"), ref.get("sea_level", float("nan"))
        if level is None or math.isnan(usual):
            return "This sea level"
        diff = level - usual
        return ("Higher sea level than usual" if diff >= 0.05 else
                "Lower sea level than usual" if diff <= -0.05 else "Usual sea level")
    if group == "weather":
        rain, prob, temp = _val(x, "precipitation") or 0, _val(x, "precipitation_probability") or 0, _val(x, "temperature_2m")
        if rain >= 0.1 or prob > 40:
            return "Rainy weather"
        if (_val(x, "rain_max24h_72h") or 0) >= physics.POLLUTION_RAIN_MM:
            return "Days after heavy rain"
        if temp is not None and temp < physics.COLD_AIR_C:
            return "Cold weather"
        return "Dry weather"
    if group == "time":
        h = _val(x, "solar_hour") or 12
        return ("Early morning" if h < 9 else "Morning" if h < 12 else
                "Midday" if h < 15 else "Afternoon" if h < 18 else "Evening")
    if group == "season":
        month = int(_val(x, "month") or 1)
        return {12: "Winter", 1: "Winter", 2: "Winter", 3: "Spring", 4: "Spring", 5: "Spring",
                6: "Summer", 7: "Summer", 8: "Summer"}.get(month, "Autumn") + " days"
    raise ValueError(group)


def reasons(bundle: Row, rows: Sequence[Row], ai: Sequence[float], ref: dict[str, float],
            conds: Sequence[Row], normal: float, shown: Callable[[float], int]) -> list[str | None]:
    """One reason (or None) per row. Rows need x, physics_waves, physics_shape, physics_overall.
    `shown(x)` = the 1-5 value the app shows for score x."""
    out: list[str | None] = [None] * len(rows)
    todo = [i for i, r in enumerate(rows) if ref and shown(ai[i]) != shown(r["physics_overall"])]
    if not todo:
        return out
    phi, base = group_shapley(bundle, [rows[i] for i in todo], ref)
    names = list(GROUPS)
    for k, i in enumerate(todo):
        up = shown(ai[i]) > shown(rows[i]["physics_overall"])
        sign = 1 if up else -1
        push = sign * phi[k]                       # > 0 = pushes the way the score moved
        order = sorted(range(len(names)), key=lambda g: -push[g])
        top = order[0]
        tail = f" — usually {'better' if up else 'worse'} than forecast here"
        general = sign * (base[k] - rows[i]["physics_overall"])
        if push[top] < MIN_PUSH or push[top] < general:
            out[i] = "Days like this" + tail      # the spot in general, not one condition
            continue
        parts = (swell_parts(bundle, rows[i], ref, sign)
                 if "swell" in (names[order[0]], names[order[1]]) else None)
        words = [phrase(names[g], rows[i]["x"], conds[i], ref, normal, parts) for g in order[:2]]
        second = order[1]
        if push[second] >= max(MIN_PUSH, SECOND_SHARE * push[top]):
            out[i] = f"{words[0]} and {_low(words[1])}{tail}"
        else:
            out[i] = words[0] + tail
    return out
