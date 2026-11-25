"""Random test cases for the physics score, as JSON on stdout (for `npm run physics-parity`,
which checks web/src/scoring/physics.ts gives the same results as jobs/physics.py).

  python -m jobs.physics_cases [N] [SEED]
"""
from __future__ import annotations

import json
import random
import sys
from datetime import datetime, timedelta, timezone

from jobs import physics

T0 = datetime(2026, 11, 25, 12, tzinfo=timezone.utc)


def maybe(rng: random.Random, value, p_none: float = 0.1):
    return None if rng.random() < p_none else value


def hour(rng: random.Random, t: datetime) -> dict:
    return {
        "valid_at": t,
        "swell_wave_height": maybe(rng, round(rng.uniform(0, 2.2), 2)),
        "swell_wave_period": maybe(rng, round(rng.uniform(2.5, 11), 1)),
        "swell_wave_direction": maybe(rng, rng.randint(0, 359)),
        "secondary_swell_wave_height": maybe(rng, rng.choice([0.0, round(rng.uniform(0, 1), 2)]), 0.3),
        "secondary_swell_wave_period": maybe(rng, round(rng.uniform(2, 9), 1)),
        "secondary_swell_wave_direction": maybe(rng, rng.randint(0, 359)),
        "wind_wave_height": maybe(rng, round(rng.uniform(0, 1), 2)),
        "wind_wave_period": maybe(rng, round(rng.uniform(1, 5), 1)),
        "wind_wave_direction": maybe(rng, rng.randint(0, 359)),
        "wind_speed": maybe(rng, round(rng.uniform(0, 45), 1)),
        "wind_direction": maybe(rng, rng.randint(0, 359)),
        "wind_gusts": maybe(rng, round(rng.uniform(0, 70), 1)),
        "precipitation": maybe(rng, rng.choice([0.0, 0.0, round(rng.uniform(0, 6), 1)])),
        "precipitation_probability": maybe(rng, rng.randint(0, 100)),
        "weather_code": maybe(rng, rng.choice([0, 1, 3, 61, 63, 80, 95, 96, 99])),
        "cape": maybe(rng, rng.choice([0, 200, 900, 1500])),
        "temperature_2m": maybe(rng, round(rng.uniform(3, 32), 1)),
        "sea_surface_temperature": maybe(rng, round(rng.uniform(11, 27), 1)),
    }


TS_NAMES = {
    "swell_wave_height": "swellHeight", "swell_wave_period": "swellPeriod",
    "swell_wave_direction": "swellDirection", "secondary_swell_wave_height": "secondarySwellHeight",
    "secondary_swell_wave_period": "secondarySwellPeriod",
    "secondary_swell_wave_direction": "secondarySwellDirection", "wind_wave_height": "windWaveHeight",
    "wind_wave_period": "windWavePeriod", "wind_wave_direction": "windWaveDirection",
    "wind_speed": "windSpeed", "wind_direction": "windDirection", "wind_gusts": "windGusts",
    "precipitation": "precipitation", "precipitation_probability": "precipProb",
    "weather_code": "weatherCode", "cape": "cape", "temperature_2m": "airTemp",
    "sea_surface_temperature": "seaTemp",
}


def to_ts(h: dict) -> dict:
    out = {TS_NAMES[k]: v for k, v in h.items() if k in TS_NAMES}
    out["time"] = int(h["valid_at"].timestamp())
    return out


def main() -> int:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    rng = random.Random(int(sys.argv[2]) if len(sys.argv) > 2 else 7)
    cases = []
    for _ in range(n):
        normal = rng.randint(0, 359)
        spot = {"beach_orientation": normal}
        if rng.random() < 0.8:
            spot["swell_window_min"] = (normal - rng.randint(40, 100)) % 360
            spot["swell_window_max"] = (normal + rng.randint(40, 100)) % 360
        history = []
        if rng.random() < 0.7:
            wet = rng.random() < 0.3
            for k in range(1, 73):
                h = hour(rng, T0 - timedelta(hours=k))
                if wet:
                    h["precipitation"] = round(rng.uniform(0.5, 3), 1)
                history.append(h)
        now = hour(rng, T0)
        daylight = rng.choice([True, True, False, None])
        prefs = {"dont_mind_rain": rng.random() < 0.3,
                 "level": rng.choice([None, "beginner", "intermediate", "advanced"]),
                 "max_wave_m": rng.choice([None, None, 1.0, 2.0])}
        res = physics.evaluate(now, spot, physics.series_of([*history, now]), daylight, prefs)
        cases.append({
            "spot": {"beachOrientation": normal, "swellWindowMin": spot.get("swell_window_min"),
                     "swellWindowMax": spot.get("swell_window_max")},
            "hour": to_ts(now), "history": [to_ts(h) for h in history], "daylight": daylight,
            "prefs": {"dontMindRain": prefs["dont_mind_rain"], "level": prefs["level"],
                      "maxWaveM": prefs["max_wave_m"]},
            "expect": {k: res[k] for k in ("waves", "shape", "overall", "comfort", "verdict",
                                           "reason", "mess", "wetsuit")}
                      | {"warnings": [w["kind"] for w in res["warnings"]]},
        })
    json.dump(cases, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
