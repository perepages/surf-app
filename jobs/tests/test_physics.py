"""Unit tests for jobs/physics.py (standard library unittest).

  python -m unittest jobs.tests.test_physics -v
"""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from jobs import physics as p

SPOT = {"beach_orientation": 165, "swell_window_min": 105, "swell_window_max": 240}
T0 = datetime(2026, 11, 25, 12, tzinfo=timezone.utc)


def row(**kw):
    base = {"valid_at": T0, "swell_wave_height": 0.8, "swell_wave_period": 7,
            "swell_wave_direction": 170, "wind_speed": 3, "wind_direction": 345,
            "wind_gusts": 5, "sea_surface_temperature": 18, "temperature_2m": 18,
            "precipitation": 0, "precipitation_probability": 0, "weather_code": 1, "cape": 0}
    base.update(kw)
    return base


def ev(**kw):
    return p.evaluate(row(**kw), SPOT, daylight=True)


class Geometry(unittest.TestCase):
    def test_window_factor(self):
        self.assertAlmostEqual(p.window_factor(165, SPOT), 1.0)
        self.assertEqual(p.window_factor(90, SPOT), 0.0)          # blocked by the port
        self.assertEqual(p.window_factor(250, SPOT), 0.0)         # outside
        self.assertLess(p.window_factor(110, SPOT), 0.4)          # 5 deg inside the edge: tapered
        self.assertGreater(p.window_factor(130, SPOT), 0.5)

    def test_window_crossing_north(self):
        spot = {"beach_orientation": 0, "swell_window_min": 300, "swell_window_max": 60}
        self.assertAlmostEqual(p.window_factor(0, spot), 1.0)
        self.assertEqual(p.window_factor(180, spot), 0.0)

    def test_no_window_stored(self):
        spot = {"beach_orientation": 165}
        self.assertAlmostEqual(p.window_factor(165, spot), 1.0)
        self.assertEqual(p.window_factor(345, spot), 0.0)

    def test_komar(self):
        # 1 m at 8 s -> ~1.41 m (no short-period shrink)
        self.assertAlmostEqual(p.komar_breaking_height(1.0, 8), 1.414, places=2)
        # 1 m at 9 s carries more than at 5 s, and short chop is shrunk
        self.assertGreater(p.komar_breaking_height(1.0, 9), p.komar_breaking_height(1.0, 5))
        self.assertLess(p.komar_breaking_height(0.5, 4),
                        0.39 * 9.81 ** 0.2 * (4 * 0.25) ** 0.4)


class Scores(unittest.TestCase):
    def test_clean_offshore_day_is_good(self):
        r = ev(wind_speed=8, wind_direction=345)
        self.assertGreaterEqual(r["waves"], 3.5)
        self.assertEqual(r["shape"], 5.0)
        self.assertIn("Clean", r["reason"])
        self.assertIn("offshore", r["reason"])

    def test_onshore_blows_it_out(self):
        clean, blown = ev(), ev(wind_speed=25, wind_direction=165)
        self.assertEqual(blown["waves"], clean["waves"])      # wind doesn't change waves
        self.assertLessEqual(blown["shape"], 1.5)
        self.assertLess(blown["overall"], clean["overall"] - 1)

    def test_flat_stays_flat(self):
        r = ev(swell_wave_height=0.1, wind_speed=40, wind_direction=165)
        self.assertEqual(r["waves"], 1.0)
        self.assertEqual(r["overall"], 1.0)

    def test_swell_outside_window(self):
        r = ev(swell_wave_height=1.5, swell_wave_direction=80)
        self.assertEqual(r["waves"], 1.0)
        self.assertIn("can't reach", r["reason"])

    def test_crossed_swell_hurts_shape_and_explains(self):
        r = ev(secondary_swell_wave_height=0.6, secondary_swell_wave_period=6,
               secondary_swell_wave_direction=120)
        self.assertLess(r["shape"], 5)
        self.assertIn("from the ESE is crossing the main S swell", r["mess"])
        # the same swell near the window edge barely reaches the beach: not mentioned
        edge = ev(secondary_swell_wave_height=0.6, secondary_swell_wave_period=6,
                  secondary_swell_wave_direction=230)
        self.assertIsNone(edge["mess"])

    def test_opposing_train_penalised_more_than_crossed(self):
        crossed = ev(secondary_swell_wave_height=0.5, secondary_swell_wave_period=6,
                     secondary_swell_wave_direction=230)  # 60 deg from main
        same = ev(secondary_swell_wave_height=0.5, secondary_swell_wave_period=6,
                  secondary_swell_wave_direction=180)     # 10 deg: same family
        self.assertEqual(same["shape"], 5.0)
        self.assertGreater(same["waves"], ev()["waves"])  # adds size
        self.assertLess(crossed["shape"], same["shape"])
        self.assertEqual(p.conflict_weight(150), 1.0)

    def test_gfs_zero_means_absent(self):
        r = ev(gfs_tertiary_swell_wave_height=0.0, gfs_tertiary_swell_wave_period=0.0,
               gfs_tertiary_swell_wave_direction=0)
        self.assertEqual(r["features"]["gfs_tertiary_energy_eff"], 0.0)

    def test_rain_is_comfort_not_waves(self):
        dry, wet = ev(), ev(precipitation=3, precipitation_probability=80)
        self.assertEqual(wet["waves"], dry["waves"])
        self.assertEqual(wet["shape"], dry["shape"])
        self.assertLess(wet["comfort"], dry["comfort"])
        self.assertLess(wet["verdict"], dry["verdict"])
        self.assertIn("80% chance of rain", wet["reason"])
        mind = p.evaluate(row(precipitation=3, precipitation_probability=80), SPOT,
                          daylight=True, prefs={"dont_mind_rain": True})
        self.assertEqual(mind["verdict"], dry["verdict"])

    def test_thunder_forces_skip(self):
        r = ev(weather_code=95)
        self.assertEqual(r["verdict"], 1.0)
        self.assertEqual(r["warnings"][0]["kind"], "thunder")
        self.assertEqual(ev(cape=1500, precipitation=2)["verdict"], 1.0)
        self.assertGreater(ev(cape=1500)["verdict"], 1.0)  # CAPE alone, dry: no flag

    def test_dark_is_skip(self):
        r = p.evaluate(row(), SPOT, daylight=False)
        self.assertEqual(r["verdict"], 1.0)
        self.assertEqual(r["reason"], "After dark")

    def test_level_and_rip(self):
        big = row(swell_wave_height=1.8, swell_wave_period=8, swell_wave_direction=165)
        r = p.evaluate(big, SPOT, daylight=True, prefs={"level": "beginner"})
        kinds = {w["kind"] for w in r["warnings"]}
        self.assertEqual(kinds, {"too_big", "rip"})
        r = p.evaluate(big, SPOT, daylight=True, prefs={"max_wave_m": 3})
        self.assertNotIn("too_big", {w["kind"] for w in r["warnings"]})

    def test_too_big_caps_the_verdict(self):
        big = row(swell_wave_height=1.8, swell_wave_period=8, swell_wave_direction=165)
        free = p.evaluate(big, SPOT, daylight=True)["verdict"]
        self.assertGreater(free, 3)
        self.assertEqual(p.evaluate(big, SPOT, daylight=True, prefs={"level": "beginner"})["verdict"], 1.0)
        mid = p.evaluate(big, SPOT, daylight=True, prefs={"max_wave_m": 2.0})["verdict"]
        self.assertEqual(mid, 2.0)  # breaking ~2.3 m: above 2.0, below 1.5 x 2.0

    def test_wetsuit(self):
        self.assertEqual(p.wetsuit(14), "4/3 mm")
        self.assertEqual(p.wetsuit(18), "3/2 mm")
        self.assertEqual(p.wetsuit(21), "shorty or none")


class History(unittest.TestCase):
    def series(self, speed, direction, rain=0.0):
        return p.series_of([{"valid_at": T0 - timedelta(hours=k), "wind_speed": speed,
                             "wind_direction": direction, "precipitation": rain}
                            for k in range(1, 73)])

    def test_wind_history_onshore_component(self):
        f = p.features(row(), SPOT, self.series(30, 165), True)
        self.assertAlmostEqual(f["wind_onshore_6h"], 30, places=3)
        self.assertAlmostEqual(f["wind_mean_24h"], 30, places=3)
        f = p.features(row(), SPOT, self.series(30, 345), True)
        self.assertAlmostEqual(f["wind_onshore_12h"], -30, places=3)

    def test_leftover_chop_after_onshore(self):
        calm = p.evaluate(row(), SPOT, self.series(5, 345), True)
        after = p.evaluate(row(), SPOT, self.series(30, 165), True)
        self.assertLess(after["shape"], calm["shape"])
        self.assertIn("earlier onshore wind", after["reason"])

    def test_pollution_warning_after_heavy_rain(self):
        r = p.evaluate(row(), SPOT, self.series(5, 345, rain=1.5), True)  # 36 mm / 24 h
        self.assertIn("water_quality", {w["kind"] for w in r["warnings"]})
        r = p.evaluate(row(), SPOT, self.series(5, 345, rain=0.2), True)
        self.assertNotIn("water_quality", {w["kind"] for w in r["warnings"]})


if __name__ == "__main__":
    unittest.main()
