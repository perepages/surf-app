"""jobs/train.py prune_models with a fake database (no network).

python -m unittest jobs.tests.test_prune_models
"""
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from jobs import train

NOW = datetime(2026, 12, 20, 3, 30, tzinfo=timezone.utc)


def row(i, days_ago, path, active=False):
    return {"id": i, "trained_at": (NOW - timedelta(days=days_ago)).isoformat(),
            "artifact_path": path, "is_active": active}


class PruneTest(unittest.TestCase):
    def run_prune(self, rows, dry_run=False):
        calls = {"files": [], "deleted_rows": []}

        def fake_http(url, headers=None, method="GET", body=None):
            if method == "GET":
                return rows
            calls["deleted_rows"].append(url.split("id=in.(")[1].rstrip(")"))
            return None

        with mock.patch.object(train, "http", fake_http), \
             mock.patch.object(train, "delete_files", lambda db, paths: calls["files"].extend(paths)):
            n = train.prune_models(mock.Mock(base="https://x/rest/v1", headers={}), NOW, dry_run)
        return n, calls

    def test_keeps_active_and_recent(self):
        rows = [
            row(1, 30, "vilanova/a.joblib", active=True),  # old but active: kept
            row(2, 20, "vilanova/b.joblib"),                # old: deleted
            row(3, 3, "vilanova/c.joblib"),                 # recent: kept
            row(4, 20, "general/g1.joblib"),                # shared file, other row recent -> file kept
            row(5, 2, "general/g1.joblib"),
            row(6, 25, "general/g0.joblib"),                # shared by two old rows -> file deleted
            row(7, 25, "general/g0.joblib"),
        ]
        n, calls = self.run_prune(rows)
        self.assertEqual(n, 4)
        self.assertEqual(sorted(calls["files"]), sorted([
            "vilanova/b.joblib", "vilanova/b.json", "general/g0.joblib", "general/g0.json"]))
        self.assertEqual(calls["deleted_rows"], ["2,4,6,7"])

    def test_dry_run_deletes_nothing(self):
        n, calls = self.run_prune([row(2, 20, "vilanova/b.joblib")], dry_run=True)
        self.assertEqual((n, calls["files"], calls["deleted_rows"]), (1, [], []))

    def test_nothing_old(self):
        n, calls = self.run_prune([row(1, 1, "x/a.joblib"), row(2, 40, "x/b.joblib", active=True)])
        self.assertEqual((n, calls["files"], calls["deleted_rows"]), (0, [], []))


if __name__ == "__main__":
    unittest.main()
