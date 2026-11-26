"""The app's forecast files (jobs/collect_forecast.py build_file / build_index), no network.

python -m unittest jobs.tests.test_forecast_files
"""
import unittest
from datetime import datetime, timezone

from jobs import collect_forecast as cf

START = 1795734000  # 2026-11-26 23:00 UTC
SPOT = {"id": "x", "lat": 41.2, "lon": 1.7}


def data(hours: int = 48, gfs_hour: int | None = None):
    keys = [cf.utc_key(START + i * 3600) for i in range(hours)]
    marine = {k: {"wave_height": 0.5 + i / 100, "sea_level_height_msl": -0.4123} for i, k in enumerate(keys)}
    wind = {k: {"wind_speed_10m": 12.34, "is_day": i % 2} for i, k in enumerate(keys)}
    models = {k: cf.DEFAULT_MODEL for k in keys}
    if gfs_hour is not None:
        models[keys[gfs_hour]] = cf.FALLBACK_MARINE_MODEL
    return {"marine": marine, "models": models, "wind": wind, "gfs": {}, "timezone": "Europe/Madrid",
            "daily": {"time": [1795561200, 1795647600], "sunrise": [1, 2], "sunset": [3, 4]},
            "utc_offset_seconds": 3600, "fetched_now": datetime(2026, 11, 26, 15, 26, 7, 123, tzinfo=timezone.utc)}


class FileTest(unittest.TestCase):
    def test_columns_and_rounding(self):
        f = cf.build_file(SPOT, data())
        self.assertEqual((f["v"], f["start"], f["hours"]), (cf.FILE_VERSION, START, 48))
        self.assertEqual(f["fetchedAt"], "2026-11-26T15:26:07Z")
        self.assertEqual(f["hourly"]["tide"][0], -0.412)
        self.assertEqual(f["hourly"]["windSpeed"][0], 12.3)
        self.assertEqual(f["hourly"]["isDay"][:3], [0, 1, 0])
        self.assertIsNone(f["hourly"]["seaTemp"][0])  # not asked = null, never missing
        self.assertEqual(set(f["hourly"]), set(cf.FILE_FIELDS))
        self.assertEqual(f["marineModel"], "best_match")
        self.assertEqual(cf.build_file(SPOT, data(gfs_hour=3))["marineModel"], "best_match+ncep_gfswave025")

    def test_local_dates(self):
        # Local midnights (UTC+1): 25 Nov and 26 Nov.
        self.assertEqual(cf.build_file(SPOT, data())["daily"]["date"], ["2026-11-25", "2026-11-26"])

    def test_gap_refused(self):
        d = data()
        del d["marine"][cf.utc_key(START + 5 * 3600)]
        with self.assertRaises(ValueError):
            cf.build_file(SPOT, d)

    def test_index_slice(self):
        f = cf.build_file(SPOT, data(200))
        now = datetime.fromtimestamp(START + 100 * 3600 + 1800, tz=timezone.utc)
        part = cf.build_index({"x": f}, now)["spots"]["x"]
        self.assertEqual(part["start"], START + (100 - cf.INDEX_PAST_H) * 3600)
        self.assertEqual(part["hours"], cf.INDEX_PAST_H + cf.INDEX_AHEAD_H + 1)
        self.assertEqual(part["hourly"]["waveHeight"][cf.INDEX_PAST_H], f["hourly"]["waveHeight"][100])
        # A file that ended before now gives nothing (spot left out, not an empty entry).
        late = datetime.fromtimestamp(START + 400 * 3600, tz=timezone.utc)
        self.assertEqual(cf.build_index({"x": f}, late)["spots"], {})


if __name__ == "__main__":
    unittest.main()
