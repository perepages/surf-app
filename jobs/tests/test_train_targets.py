"""Targets of the physics-v1 models (needs jobs/requirements.txt: scikit-learn).

  python -m unittest jobs.tests.test_train_targets -v
"""
import unittest

from jobs import physics, train


class Targets(unittest.TestCase):
    def test_waves_from_size_follows_breaking_scale(self):
        self.assertEqual(train.waves_from_size("flat"), 1.0)
        self.assertLess(train.waves_from_size("knee"), train.waves_from_size("waist"))
        self.assertEqual(train.waves_from_size("overhead"), 5.0)

    def test_shape_from_overall_inverts_overall(self):
        for w in (2.5, 3.0, 4.5):
            for s in (1.0, 2.5, 4.0, 5.0):
                o = physics.overall_score(w, s)
                self.assertAlmostEqual(train.shape_from_overall(o, w), s, places=6)

    def test_no_shape_on_small_days(self):
        self.assertIsNone(train.shape_from_overall(2, 2.0))

    def test_waves_from_buoy_uses_window(self):
        spot = {"beach_orientation": 165, "swell_window_min": 105, "swell_window_max": 240}
        inside = train.waves_from_buoy({"wave_height": 1.2, "wave_period": 7, "wave_direction": 170}, spot)
        blocked = train.waves_from_buoy({"wave_height": 1.2, "wave_period": 7, "wave_direction": 60}, spot)
        self.assertGreater(inside, 3)
        self.assertEqual(blocked, 1.0)


    def test_weather_spoiled(self):
        self.assertTrue(train.weather_spoiled({"weather_problem": True}))
        self.assertFalse(train.weather_spoiled({"weather_problem": False, "weather_measured": {"rain_mm": 5}}))
        self.assertTrue(train.weather_spoiled({"weather_problem": None, "weather_measured": {"rain_mm": 1.2}}))
        self.assertFalse(train.weather_spoiled({"weather_measured": {"rain_mm": 0.2}}))
        self.assertFalse(train.weather_spoiled({}))

    def test_spoiled_ratings_left_out_of_overall_check(self):
        rows = [{"overall": 1.0, "physics_overall": 4.0, "weight": 1.0, "weather_spoiled": True},
                {"overall": 4.0, "physics_overall": 4.0, "weight": 1.0, "weather_spoiled": False}]
        self.assertEqual(train.overall_mae(None, rows), 0.0)


if __name__ == "__main__":
    unittest.main()
