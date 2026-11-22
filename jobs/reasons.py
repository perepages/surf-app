"""Plain-words reason for an AI score, e.g. "Offshore wind under 15 km/h — usually better than forecast here".

Shown in the app under the score (Verdict / ConditionsPanel) when the AI changes the 1-5 value
the app would otherwise show. Written by jobs/predict.py into `predictions.reason`.

How the cause is found (SHAP-style, computed exactly, no extra library):
  The model predicts a CORRECTION to the simple score. The conditions are split into 6 groups
  (wind, swell, waves, tide, time of day, season). For every one of the 2^6 = 64 combinations
  the groups left out are set to their ordinary value (training median, bundle["reference"]) and
  the model is asked again; each group's Shapley value is its average effect over all
  combinations. These add up exactly to: correction(this hour) - correction(an ordinary hour).
  The rest, correction(an ordinary hour), is how this spot differs from the rules in general.

Which words:
  - The AI must change the shown 1-5 value, else no reason (the app shows the simple reason).
  - The group pushing hardest in the direction of the change is named, if it pushes at least
    MIN_PUSH points and more than the general spot difference; a second group is added when it
    pushes at least half as hard. Otherwise: "Days like this — usually ... than forecast here".
  - Conditions are named by range, not exact numbers ("under 15 km/h", "short-period swell"),
    because the model learned from ranges of similar days, not from that one number.
Lead time and the simple score itself stay fixed: they're never a reason.
"""
from __future__ import annotations

import math
from typing import Any, Sequence

import numpy as np

from jobs.explore import compass, wind_relation
from jobs.train import matrix

Row = dict[str, Any]

GROUPS = {
    "wind": ["wind_speed", "wind_onshore", "wind_cross"],
    "swell": ["swell_height", "swell_period", "swell_dir_rel"],
    "waves": ["wave_height"],
    "tide": ["tide"],
    "time": ["solar_hour"],
    "season": ["month"],
}
MIN_PUSH = 0.15    # points; smaller effects aren't worth naming
SECOND_SHARE = 0.5  # a second cause is named if it pushes at least half as hard as the first


# ---------- Shapley values per group ----------

def _weights(n: int) -> list[float]:
    """Shapley weight for a coalition of size s (not containing the group): s!(n-s-1)!/n!"""
    return [math.factorial(s) * math.factorial(n - s - 1) / math.factorial(n) for s in range(n)]


def group_shapley(model: Any, rows: Sequence[Row], ref: dict[str, float]) -> tuple[np.ndarray, np.ndarray]:
    """(phi[row, group], base[row]): per-group Shapley values of the model's raw correction,
    and the correction with every group at its reference value. phi.sum(1) + base = correction."""
    names = list(GROUPS)
    n, masks = len(names), 1 << len(names)
    variants = []
    for r in rows:
        for mask in range(masks):  # bit g set = group g keeps this hour's value
            x = dict(r["x"])
            for g, name in enumerate(names):
                if not mask >> g & 1:
                    for f in GROUPS[name]:
                        if f in x and not math.isnan(ref.get(f, float("nan"))):
                            x[f] = ref[f]
            variants.append({"x": x})
    v = model.predict(matrix(variants, model.features_)).reshape(len(rows), masks)
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


def swell_parts(model: Any, row: Row, ref: dict[str, float], sign: int) -> set[str]:
    """Which swell features (size, period, direction) actually push the score the way it moved:
    each is set to its ordinary value alone; those causing at least 30% of the biggest push are
    named. So "long-period swell" isn't padded with a size and direction that don't matter."""
    feats = [f for f in GROUPS["swell"] if not math.isnan(ref.get(f, float("nan")))]
    variants = [row] + [{"x": {**row["x"], f: ref[f]}} for f in feats]
    v = model.predict(matrix(variants, model.features_))
    push = {f: sign * (v[0] - v[k + 1]) for k, f in enumerate(feats)}
    top = max(push.values(), default=0)
    return {f for f, p in push.items() if top > 0 and p >= 0.3 * top} or set(feats)


def phrase(group: str, cond: Row, ref: dict[str, float], beach_faces: float, solar_hour: float,
           month: int, swell_parts: set[str] | None = None) -> str:
    """The condition as a range in plain words, capitalised. `swell_parts` limits which swell
    features are named (see swell_parts()); None = all."""
    if group == "wind":
        speed, direction = cond.get("wind_speed"), cond.get("wind_direction")
        if speed is None:
            return "This wind"
        if speed < 5:
            return "Almost no wind"
        rel = "" if direction is None else {"offshore": "Offshore ", "cross": "Cross-shore ",
                                            "onshore": "Onshore "}[wind_relation(direction, beach_faces)]
        size = ("under 15 km/h" if speed < 15 else "15–25 km/h" if speed < 25 else
                "25–35 km/h" if speed < 35 else "over 35 km/h")
        return _cap(f"{rel}wind {size}")
    if group == "swell":
        h, p, d = (cond.get("swell_wave_height"), cond.get("swell_wave_period"),
                   cond.get("swell_wave_direction"))
        if not h:  # None, or GFS-wave's 0.0
            return "No real swell"
        parts = swell_parts if swell_parts is not None else {"swell_height", "swell_period", "swell_dir_rel"}
        size = ("small " if h < 0.5 else "big " if h >= 1.2 else "") if "swell_height" in parts else ""
        period = ("" if not p else "short-period " if p < 6 else "long-period " if p >= 9 else
                  "mid-period ") if "swell_period" in parts else ""
        where = f" from the {compass(d)}" if d is not None and "swell_dir_rel" in parts else ""
        return _cap(f"{size}{period}swell{where}")
    if group == "waves":
        h = cond.get("wave_height")
        if h is None:
            return "This wave size"
        return ("Waves under 0.5 m" if h < 0.5 else "Waves 0.5–1 m" if h < 1 else
                "Waves 1–1.5 m" if h < 1.5 else "Waves over 1.5 m")
    if group == "tide":
        level, usual = cond.get("sea_level_height"), ref.get("tide", float("nan"))
        if level is None or math.isnan(usual):
            return "This sea level"
        diff = level - usual
        return ("Higher sea level than usual" if diff >= 0.05 else
                "Lower sea level than usual" if diff <= -0.05 else "Usual sea level")
    if group == "time":
        return ("Early morning" if solar_hour < 9 else "Morning" if solar_hour < 12 else
                "Midday" if solar_hour < 15 else "Afternoon" if solar_hour < 18 else "Evening")
    if group == "season":
        return {12: "Winter", 1: "Winter", 2: "Winter", 3: "Spring", 4: "Spring", 5: "Spring",
                6: "Summer", 7: "Summer", 8: "Summer"}.get(month, "Autumn") + " days"
    raise ValueError(group)


def reasons(model: Any, rows: Sequence[Row], ai: Sequence[float], ref: dict[str, float],
            conds: Sequence[Row], beach_faces: float, shown: Any) -> list[str | None]:
    """One reason (or None) per row. `shown(x)` = the 1-5 value the app shows for score x."""
    out: list[str | None] = [None] * len(rows)
    todo = [i for i, r in enumerate(rows) if ref and shown(ai[i]) != int(r["simple"])]
    if not todo:
        return out
    phi, base = group_shapley(model, [rows[i] for i in todo], ref)
    names = list(GROUPS)
    for k, i in enumerate(todo):
        up = shown(ai[i]) > int(rows[i]["simple"])
        sign = 1 if up else -1
        push = sign * phi[k]                       # > 0 = pushes the way the score moved
        order = sorted(range(len(names)), key=lambda g: -push[g])
        top = order[0]
        tail = f" — usually {'better' if up else 'worse'} than forecast here"
        if push[top] < MIN_PUSH or push[top] < sign * base[k]:
            out[i] = "Days like this" + tail      # the spot in general, not one condition
            continue
        x = rows[i]["x"]
        parts = (swell_parts(model, rows[i], ref, sign)
                 if "swell" in (names[order[0]], names[order[1]]) else None)
        words = [phrase(names[g], conds[i], ref, beach_faces, x["solar_hour"], int(x["month"]), parts)
                 for g in order[:2]]
        second = order[1]
        if push[second] >= max(MIN_PUSH, SECOND_SHARE * push[top]):
            out[i] = f"{words[0]} and {_low(words[1])}{tail}"
        else:
            out[i] = words[0] + tail
    return out
