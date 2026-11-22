"""Nightly: train a model per spot (or a general one), test it on the last 14 days, activate if better.

For every active spot (or --spot ID):
  1. Ratings: hidden ones (flagged as spam/outliers in /admin) are skipped; the same device +
     surfed_at counts once. Weights: source 'me' and 'past_session' 1.0, 'community' with
     near_beach = true 0.8, other 'community' 0.5.
  2. Features come from the forecast the surfer SAW (`forecast_shown`): the app's `conditions`,
     or for past sessions the screenshot hour nearest surfed_at. Anything missing there is
     filled from the `forecasts` row for that hour (shortest lead, else the historical row).
       swell_height, swell_period            m, s ('ncep_gfswave025' swell 0.0 = missing)
       swell_dir_rel                         swell direction minus beach orientation, -180..180
       wave_height                           combined sea state (not in the brief; added because
                                             in Vilanova wind sea often matters more than swell,
                                             and the simple score is built on it)
       wind_speed                            km/h
       wind_onshore, wind_cross              wind split relative to the beach (km/h):
                                             onshore > 0 blows in, < 0 = offshore; cross = along
       tide                                  sea_level_height, m (mostly storm surge here)
       solar_hour                            UTC hour + lon/15: daylight cycle, no time zones/DST
       month                                 1-12 (UTC)
       lead_hours                            hours between fetch and the rated hour (0 if fetched
                                             after it; unknown for screenshots = missing)
       simple_score                          the app's simple 1-5 score for those conditions
  3. Targets (each model learns a CORRECTION, so with little data it stays close to the
     baseline instead of guessing; prediction = baseline + correction, clipped):
       overall       1-5 rating (main model); baseline = simple score
       wave_height   real height: the rated wave size converted to metres if given, else the
                     nearest buoy's Hm0 that hour (first buoy in spots.buoy_ids with a reading);
                     baseline = forecast wave height (swell height if missing)
  4. Evaluation: ratings from the last --test-days (14) days are the test set; the model is fit
     on older ratings only and compared there with the simple score (overall) and the raw
     forecast height (wave_height). Needs --min-train older and --min-test recent ratings.
  5. Saved (unless --dry-run) after refitting on ALL rows, so the newest days are used:
       storage  models/<spot>/<version>.joblib (+ .json metrics, readable without Python)
       table    models row: version, artifact_path, accuracy, is_active = false, and
                n_ratings / n_spots / scope (migration 12; the app says "Learned from N
                surfer reports")
     accuracy = 1 - (weighted MAE of the overall model on the test set) / 4 (1.0 = always exact).
     The bundle records max_rating_id: the newest rating it learned from.
  6. Activated (is_active = true, via the `activate_model` function = one transaction) only if
     it beats BOTH:
       - the simple score, on the last 14 days, and
       - the current active model, on the test ratings the current model never saw (rating id
         newer than its max_rating_id). Last night's model was trained on almost all of the
         last 14 days, so comparing on those would always favour it. Fewer than --min-test such
         ratings = not enough new evidence = keep the current model.
     Otherwise the old model stays active. A current model that can't be loaded (e.g. made by
     another scikit-learn, or its file is gone) is replaced if the new one beats the simple
     score; one that can't be DOWNLOADED (network, Supabase busy, after 3 tries) is kept.
  7. General model: spots with too few ratings for their own model (step 4) get one model
     trained on the ratings of ALL spots (features are relative to each beach, so they pool).
     It's evaluated the same way on all spots' last 14 days, saved once in models/general/,
     with one `models` row per spot using it, and activated per spot by the rule in step 6.
     It never replaces a spot's own model. If all spots together are still too few, nothing
     changes: those spots keep their current model or the simple score.
  Then `python -m jobs.predict` writes the scores (the nightly workflow runs it next).

Not enough data is the normal state for a new spot, not an error (exit 0).

Run from the repo root (needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY):
  python -m jobs.train --dry-run     # train + evaluate, print, save nothing
  python -m jobs.train               # also upload the model, add a `models` row, activate
  python -m jobs.train --no-activate # save, but never activate
Needs scikit-learn (jobs/requirements.txt). Weather data by Open-Meteo.com.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.client import HTTPException
from typing import Any

# joblib asks Windows for the physical core count via a tool newer Windows lacks; that only
# prints a warning, and these models are tiny.
os.environ.setdefault("LOKY_MAX_CPU_COUNT", "1")
import joblib  # noqa: E402  (after the env var above)
import numpy as np
import sklearn
from sklearn.ensemble import HistGradientBoostingRegressor

from jobs import log
from jobs.check_connections import ROOT, env, load_dotenv
from jobs.collect_forecast import HttpError, Supabase, http
from jobs.explore import HISTORICAL, angle_diff, fetch_all, round_hour, simple_score, ts

JOB = "train"
BUCKET = "models"
UTC = timezone.utc
Row = dict[str, Any]

FEATURES = ["swell_height", "swell_period", "swell_dir_rel", "wave_height", "wind_speed",
            "wind_onshore", "wind_cross", "tide", "solar_hour", "month", "lead_hours",
            "simple_score"]
# target -> (baseline field, clip range)
TARGETS = {"overall": ("simple", (1.0, 5.0)), "real_height": ("forecast_height", (0.0, 6.0))}

WEIGHT_ME = 1.0           # 'me' and 'past_session'
WEIGHT_NEAR_BEACH = 0.8   # 'community' with near_beach = true
WEIGHT_COMMUNITY = 0.5    # other 'community'

# Rated wave size -> metres (rough face height at a beach break; flat = nothing to ride).
WAVE_SIZE_M = {"flat": 0.1, "ankle": 0.25, "knee": 0.45, "waist": 0.7, "chest": 1.0,
               "head": 1.6, "overhead": 2.2}

IN_CHUNK = 100  # timestamps per PostgREST `in.(...)` filter


# ---------- reading ----------

def weight(r: Row) -> float:
    if r["source"] in ("me", "past_session"):
        return WEIGHT_ME
    return WEIGHT_NEAR_BEACH if r.get("near_beach") is True else WEIGHT_COMMUNITY


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def rows_at_hours(db: Supabase, table: str, select: str, spot_id: str, column: str,
                  hours: list[datetime], order: str) -> list[Row]:
    out: list[Row] = []
    for i in range(0, len(hours), IN_CHUNK):
        stamps = ",".join(f'"{iso(h)}"' for h in hours[i:i + IN_CHUNK])
        query = urllib.parse.urlencode({"select": select, "spot_id": f"eq.{spot_id}",
                                        column: f"in.({stamps})", "order": order})
        out += fetch_all(db, table, query)
    return out


def load_ratings(db: Supabase, spot_id: str) -> list[Row]:
    rows = fetch_all(db, "ratings", "select=id,surfed_at,overall,wave_size,source,device_id,"
                     f"near_beach,forecast_shown&spot_id=eq.{spot_id}&hidden=eq.false&order=surfed_at,id")
    seen, out = set(), []
    for r in rows:
        r["surfed_at"] = ts(r["surfed_at"])
        key = (r["device_id"], r["surfed_at"]) if r.get("device_id") else ("id", r["id"])
        if key not in seen:  # a timed-out send that was saved twice counts once
            seen.add(key)
            out.append(r)
    return out


# ---------- features ----------

def num(v: Any) -> float:
    try:
        return float("nan") if v is None else float(v)
    except (TypeError, ValueError):
        return float("nan")


def signed_angle(a: float, b: float) -> float:
    """a - b folded to -180..180."""
    return ((a - b + 180) % 360) - 180


def shown_conditions(r: Row) -> tuple[Row, float | None]:
    """(conditions the surfer saw, lead hours) from forecast_shown; ({}, None) if none."""
    shown = r.get("forecast_shown")
    if not isinstance(shown, dict):
        return {}, None
    if isinstance(shown.get("conditions"), dict):  # the app
        cond = dict(shown["conditions"])
        cond["marine_model"] = shown.get("marine_model")
        lead = None
        try:
            lead = (ts(shown["valid_at"]) - ts(shown["fetched_at"])).total_seconds() / 3600
            lead = max(0.0, lead)  # fetched after the hour = Open-Meteo's latest numbers, lead 0
        except (KeyError, TypeError, ValueError):
            pass
        return cond, lead
    hours = shown.get("hours")
    if isinstance(hours, list) and hours:  # past-session screenshot: nearest hour
        try:
            best = min(hours, key=lambda h: abs((ts(h["valid_at"]) - r["surfed_at"]).total_seconds()))
        except (KeyError, TypeError, ValueError):
            return {}, None
        return dict(best), None  # when it was looked at is unknown
    return {}, None


def best_db_forecast(rows: list[Row]) -> Row | None:
    live = [f for f in rows if f.get("marine_model") != HISTORICAL and (f.get("lead_hours") or 0) >= 0]
    if live:
        return min(live, key=lambda f: f["lead_hours"])
    return rows[0] if rows else None


def features(cond: Row, lead: float | None, spot: Row, when: datetime) -> dict[str, float]:
    faces = spot["beach_orientation"]
    swell_h, swell_p = num(cond.get("swell_wave_height")), num(cond.get("swell_wave_period"))
    if cond.get("marine_model") == "ncep_gfswave025" and swell_h == 0:
        swell_h = swell_p = float("nan")  # GFS wave reports "no swell" as 0.0
    swell_dir = num(cond.get("swell_wave_direction"))
    wind, wind_dir = num(cond.get("wind_speed")), num(cond.get("wind_direction"))
    onshore = cross = float("nan")
    if not (math.isnan(wind) or math.isnan(wind_dir)):
        rel = math.radians(signed_angle(wind_dir, faces))  # 0 = blowing straight in
        onshore, cross = wind * math.cos(rel), wind * math.sin(rel)
    return {
        "swell_height": swell_h,
        "swell_period": swell_p,
        "swell_dir_rel": float("nan") if math.isnan(swell_dir) else signed_angle(swell_dir, faces),
        "wave_height": num(cond.get("wave_height")),
        "wind_speed": wind,
        "wind_onshore": onshore,
        "wind_cross": cross,
        "tide": num(cond.get("sea_level_height")),
        "solar_hour": (when.hour + when.minute / 60 + spot["lon"] / 15) % 24,
        "month": float(when.month),
        "lead_hours": num(lead),
    }


def build_dataset(db: Supabase, spot: Row) -> list[Row]:
    ratings = load_ratings(db, spot["id"])
    hours = sorted({round_hour(r["surfed_at"]) for r in ratings})
    fc_rows = rows_at_hours(db, "forecasts", "valid_at,lead_hours,marine_model,wave_height,"
                            "wave_period,wave_direction,swell_wave_height,swell_wave_period,"
                            "swell_wave_direction,sea_level_height,wind_speed,wind_direction",
                            spot["id"], "valid_at", hours, "valid_at,fetched_at")
    by_hour: dict[datetime, list[Row]] = {}
    for f in fc_rows:
        by_hour.setdefault(ts(f["valid_at"]), []).append(f)
    buoys = list(spot.get("buoy_ids") or [])
    obs = rows_at_hours(db, "observations", "buoy_id,observed_at,wave_height", spot["id"],
                        "observed_at", hours, "observed_at") if buoys else []
    buoy_at = {(ts(o["observed_at"]), o["buoy_id"]): o["wave_height"] for o in obs
               if o["wave_height"] is not None}

    data = []
    for r in ratings:
        h = round_hour(r["surfed_at"])
        cond, lead = shown_conditions(r)
        db_fc = best_db_forecast(by_hour.get(h, []))
        if db_fc:  # fill what the shown forecast lacks (screenshots have no swell or tide)
            for k, v in db_fc.items():
                if cond.get(k) is None:
                    cond[k] = v
            shown = r.get("forecast_shown")  # null for some sources: no copy of what was seen
            if lead is None and not (isinstance(shown, dict) and shown.get("hours")):
                lead = db_fc.get("lead_hours")  # nothing was shown: the stored forecast's lead
        if cond.get("wave_height") is None and cond.get("swell_wave_height") is None:
            continue  # no forecast at all for this hour: nothing to learn from
        if r.get("wave_size") in WAVE_SIZE_M:
            real_h, real_src = WAVE_SIZE_M[r["wave_size"]], f"rated {r['wave_size']}"
        else:
            real_h, real_src = next(((buoy_at[(h, b)], f"buoy {b}") for b in buoys if (h, b) in buoy_at),
                                    (None, None))
        fc_height = first_num(cond.get("wave_height"), cond.get("swell_wave_height"))
        data.append({
            "id": r["id"], "spot_id": spot["id"], "surfed_at": r["surfed_at"], "source": r["source"], "weight": weight(r),
            "overall": float(r["overall"]), "real_height": real_h, "real_height_source": real_src,
            "simple": float(simple_score(cond, spot["beach_orientation"])),
            "forecast_height": fc_height,
            "x": {**features(cond, lead, spot, h), "simple_score": float(simple_score(cond, spot["beach_orientation"]))},
        })
    return data


def first_num(*values: Any) -> float | None:
    return next((float(v) for v in values if v is not None), None)


# ---------- split / train / evaluate ----------

def split_recent(data: list[Row], now: datetime, test_days: int) -> tuple[list[Row], list[Row]]:
    """Ratings from the last `test_days` days = test; everything older = train."""
    cut = now - timedelta(days=test_days)
    return [d for d in data if d["surfed_at"] < cut], [d for d in data if d["surfed_at"] >= cut]


def make_model(n_rows: int) -> HistGradientBoostingRegressor:
    # Small, heavily regularised trees: rating data is small and noisy.
    return HistGradientBoostingRegressor(
        max_iter=300, learning_rate=0.05, max_depth=3, max_leaf_nodes=8,
        min_samples_leaf=max(5, n_rows // 20), l2_regularization=1.0, random_state=0)


def matrix(rows: list[Row], features: list[str] = FEATURES) -> np.ndarray:
    """Feature matrix; a feature a row doesn't have (older/newer model) is missing (NaN)."""
    return np.array([[r["x"].get(f, float("nan")) for f in features] for r in rows], dtype=float)


def reference(rows: list[Row]) -> dict[str, float]:
    """Median of each feature: the 'ordinary' value jobs/reasons.py swaps in to explain a score."""
    out = {}
    for f in FEATURES:
        vals = np.array([r["x"][f] for r in rows], dtype=float)
        vals = vals[~np.isnan(vals)]
        out[f] = float(np.median(vals)) if len(vals) else float("nan")
    return out


def usable(rows: list[Row], target: str) -> list[Row]:
    base = TARGETS[target][0]
    return [r for r in rows if r[target] is not None and r[base] is not None]


def fit(rows: list[Row], target: str) -> HistGradientBoostingRegressor | None:
    """Learn target - baseline. None if no row has both."""
    base, clip = TARGETS[target]
    rows = usable(rows, target)
    if not rows:
        return None
    model = make_model(len(rows))
    model.fit(matrix(rows), np.array([r[target] - r[base] for r in rows]),
              sample_weight=np.array([r["weight"] for r in rows]))
    model.baseline_, model.clip_, model.features_ = base, clip, list(FEATURES)  # predict the same way later
    return model


def predict(model: HistGradientBoostingRegressor, rows: list[Row]) -> np.ndarray:
    """Baseline + learned correction. Rows need the baseline field (simple / forecast_height)."""
    baseline = np.array([r[model.baseline_] for r in rows], dtype=float)
    return np.clip(baseline + model.predict(matrix(rows, model.features_)), *model.clip_)


def wmae(pred: np.ndarray, truth: np.ndarray, w: np.ndarray) -> float:
    return float(np.sum(np.abs(pred - truth) * w) / np.sum(w))


def overall_mae(model: HistGradientBoostingRegressor | None, rows: list[Row]) -> float:
    """Weighted error in points of `model` on rows (None = the simple score)."""
    pred = np.array([d["simple"] for d in rows]) if model is None else predict(model, rows)
    return wmae(pred, np.array([d["overall"] for d in rows]), np.array([d["weight"] for d in rows]))


def evaluate(train: list[Row], test: list[Row]) -> tuple[Row, HistGradientBoostingRegressor]:
    """Fit on train only, measure on test. Returns (metrics, the train-only overall model)."""
    m: Row = {"n_train": len(train), "n_test": len(test),
              "test_from": iso(min(d["surfed_at"] for d in test)),
              "test_to": iso(max(d["surfed_at"] for d in test))}
    model = fit(train, "overall")
    y = np.array([d["overall"] for d in test])
    w = np.array([d["weight"] for d in test])
    pred = predict(model, test)
    simple = np.array([d["simple"] for d in test])
    m["overall"] = {
        "model_mae": wmae(pred, y, w), "simple_mae": wmae(simple, y, w),
        "model_within_1": float(np.average(np.abs(pred - y) <= 1, weights=w)),
        "simple_within_1": float(np.average(np.abs(simple - y) <= 1, weights=w)),
    }
    m["overall"]["beats_simple"] = m["overall"]["model_mae"] < m["overall"]["simple_mae"]

    h_train, h_test = usable(train, "real_height"), usable(test, "real_height")
    if h_train and h_test:
        hm = fit(h_train, "real_height")
        yh = np.array([d["real_height"] for d in h_test])
        wh = np.array([d["weight"] for d in h_test])
        m["wave_height"] = {
            "n_train": len(h_train), "n_test": len(h_test),
            "model_mae_m": wmae(predict(hm, h_test), yh, wh),
            "forecast_mae_m": wmae(np.array([d["forecast_height"] for d in h_test]), yh, wh),
        }
        m["wave_height"]["beats_forecast"] = m["wave_height"]["model_mae_m"] < m["wave_height"]["forecast_mae_m"]
    else:
        m["wave_height"] = {"n_train": len(h_train), "n_test": len(h_test),
                            "note": "not enough ratings with a real height (rated size or buoy) to test"}
    m["accuracy"] = 1 - m["overall"]["model_mae"] / 4
    return m, model


# ---------- current model + decision ----------

def storage_url(db: Supabase) -> str:
    return db.base.replace("/rest/v1", "/storage/v1")


class DownloadError(Exception):
    """The model file couldn't be fetched (network, Supabase busy): says nothing about the model."""


DOWNLOAD_ATTEMPTS = 3


def download(db: Supabase, path: str) -> bytes:
    """A file from the private bucket, retrying network errors / 429 / 5xx. A 4xx (e.g. the
    file is gone) raises HTTPError at once: that model really can't be used."""
    url = f"{storage_url(db)}/object/{BUCKET}/{urllib.parse.quote(path)}"
    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=db.headers), timeout=60) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code != 429 and exc.code < 500:
                raise
            error: Exception = exc
        except (OSError, HTTPException) as exc:  # timeouts, resets, DNS
            error = exc
        if attempt < DOWNLOAD_ATTEMPTS:
            time.sleep(2 ** attempt)
    raise DownloadError(f"{type(error).__name__}: {error}")


def load_bundle(db: Supabase, path: str) -> Row:
    """Download and unpickle a model file. Only ever from our private bucket (pickles run code)."""
    return joblib.load(io.BytesIO(download(db, path)))


def active_model(db: Supabase, spot_id: str) -> Row | None:
    rows = http(f"{db.base}/models?select=id,version,artifact_path,accuracy"
                f"&spot_id=eq.{urllib.parse.quote(spot_id)}&is_active=eq.true", db.headers)
    return rows[0] if rows else None


def decide(db: Supabase, spot_id: str, candidate: HistGradientBoostingRegressor, metrics: Row,
           test: list[Row], min_test: int, scope: str) -> Row:
    """Should the new model become this spot's active model? See the module doc, step 6."""
    out: Row = {"current_version": None, "current_scope": None, "compared_on": 0,
                "candidate_mae": None, "current_mae": None}

    def done(activate: bool, why: str) -> Row:
        out.update(activate=activate, why=why)
        return out

    beats_simple = metrics["overall"]["beats_simple"]
    current = active_model(db, spot_id)
    if not current:
        return done(beats_simple, "no current model; " + ("beats" if beats_simple else "doesn't beat")
                    + " the simple score")
    out["current_version"] = current["version"]
    try:
        bundle = load_bundle(db, current["artifact_path"])
    except DownloadError as exc:
        # A network blip must not swap out a good model: keep it, try again tomorrow night.
        out["current_error"] = str(exc)
        return done(False, "couldn't download the current model to compare; keeping it")
    except Exception as exc:  # unusable current model: predict.py can't use it either
        out["current_error"] = f"{type(exc).__name__}: {exc}"
        return done(beats_simple, "current model can't be loaded; "
                    + ("beats" if beats_simple else "doesn't beat") + " the simple score")
    out["current_scope"] = bundle.get("scope", "spot")
    if scope == "general" and out["current_scope"] == "spot":
        return done(False, "the spot has its own model; a general model never replaces it")
    if not beats_simple:
        return done(False, "doesn't beat the simple score")
    # Only ratings the current model never saw make a fair test for both.
    seen_until = bundle.get("max_rating_id", -1)
    unseen = [d for d in test if d["id"] > seen_until]
    out["compared_on"] = len(unseen)
    if len(unseen) < min_test:
        return done(False, f"only {len(unseen)} test ratings are newer than the current model "
                           f"(need {min_test}); keeping it")
    out["candidate_mae"] = overall_mae(candidate, unseen)
    out["current_mae"] = overall_mae(bundle["overall"], unseen)
    better = out["candidate_mae"] < out["current_mae"]
    return done(better, f"on {len(unseen)} new ratings: off by {out['candidate_mae']:.2f} vs current "
                        f"{out['current_mae']:.2f}" + ("" if better else "; keeping the current one"))


def activate(db: Supabase, model_id: int) -> None:
    try:
        http(f"{db.base}/rpc/activate_model", db.headers, method="POST", body={"p_model_id": model_id})
    except HttpError as exc:
        if exc.code == 404:
            raise RuntimeError("function activate_model is missing: apply migration "
                               "20261122000011_activate_model.sql") from None
        raise


# ---------- saving ----------

def upload(db: Supabase, path: str, data: bytes, content_type: str) -> None:
    headers = {**db.headers, "Content-Type": content_type, "x-upsert": "false"}
    http(f"{storage_url(db)}/object/{BUCKET}/{urllib.parse.quote(path)}", headers, method="POST", body=data)


def delete_files(db: Supabase, paths: list[str]) -> None:
    http(f"{storage_url(db)}/object/{BUCKET}", db.headers, method="DELETE", body={"prefixes": paths})


def upload_bundle(db: Supabase, folder: str, version: str, bundle: Row, metrics: Row) -> list[str]:
    buf = io.BytesIO()
    joblib.dump(bundle, buf, compress=3)
    paths = [f"{folder}/{version}.joblib", f"{folder}/{version}.json"]
    upload(db, paths[0], buf.getvalue(), "application/octet-stream")
    upload(db, paths[1], json.dumps(metrics, indent=2).encode(), "application/json")
    return paths


def insert_model_row(db: Supabase, spot_id: str, version: str, accuracy: float, path: str,
                     info: Row) -> int:
    """`info` = n_ratings / n_spots / scope (the app's "Learned from N surfer reports")."""
    url, headers = f"{db.base}/models?select=id", {**db.headers, "Prefer": "return=representation"}
    row = {"spot_id": spot_id, "version": version, "accuracy": accuracy, "artifact_path": path,
           "is_active": False}
    try:
        return http(url, headers, method="POST", body=[{**row, **info}])[0]["id"]
    except HttpError as exc:
        if exc.code != 400 or not any(col in str(exc) for col in info):
            raise
        # Migration 12 not applied yet: still save the model, just without the counts.
        log.warn(JOB, "models has no n_ratings/n_spots/scope columns (apply migration "
                      "20261122000012_model_info.sql); saved without them")
        return http(url, headers, method="POST", body=[row])[0]["id"]


def model_info(bundle: Row, data: list[Row]) -> Row:
    return {"n_ratings": len(data), "n_spots": len({d["spot_id"] for d in data}) or 1,
            "scope": bundle.get("scope", "spot")}


def save(db: Supabase, spot: Row, version: str, bundle: Row, metrics: Row,
         info: Row | None = None) -> tuple[int, str]:
    """One spot's own model: files + row (files removed again if the row fails)."""
    paths = upload_bundle(db, spot["id"], version, bundle, metrics)
    try:
        return insert_model_row(db, spot["id"], version, metrics["accuracy"], paths[0],
                                info or {}), paths[0]
    except Exception:
        delete_files(db, paths)
        raise


# ---------- one training (a spot's own model, or the general one) ----------

def log_metrics(label: str, train: list[Row], test: list[Row], metrics: Row) -> None:
    o, wh = metrics["overall"], metrics["wave_height"]
    log.info(f"[{label}] test {metrics['test_from'][:10]} .. {metrics['test_to'][:10]}: "
             f"{len(train)} train / {len(test)} test ratings")
    log.info(f"[{label}] overall: model off by {o['model_mae']:.2f}, simple score by "
             f"{o['simple_mae']:.2f} points (within 1 point: {o['model_within_1']:.0%} vs "
             f"{o['simple_within_1']:.0%}) -> {'beats' if o['beats_simple'] else 'does NOT beat'} "
             "the simple score")
    if "model_mae_m" in wh:
        log.info(f"[{label}] wave height: model off by {wh['model_mae_m']:.2f} m, raw forecast by "
                 f"{wh['forecast_mae_m']:.2f} m ({wh['n_test']} test ratings)")
    else:
        log.info(f"[{label}] wave height: {wh['note']}")


def enough(train: list[Row], test: list[Row], args: argparse.Namespace) -> bool:
    return len(train) >= args.min_train and len(test) >= args.min_test


def finish(db: Supabase, scope: str, spots: list[Row], data: list[Row], train: list[Row],
           test: list[Row], args: argparse.Namespace, now: datetime) -> None:
    """Evaluate, decide per spot, save the refit-on-all model, activate where it wins."""
    label = spots[0]["id"] if scope == "spot" else "general"
    metrics, candidate = evaluate(train, test)
    log_metrics(label, train, test, metrics)
    decisions = {s["id"]: decide(db, s["id"], candidate, metrics, test, args.min_test, scope)
                 for s in spots}
    for sid, d in decisions.items():
        log.info(f"[{sid}] {'ACTIVATE' if d['activate'] else 'keep current'}: {d['why']}")

    version = f"{label}-{now:%Y%m%dT%H%MZ}"
    metrics.update({"version": version, "scope": scope, "trained_at": iso(now),
                    "test_days": args.test_days, "features": FEATURES, "decisions": decisions,
                    "spots_trained_on": sorted({d["spot_id"] for d in data}),
                    "weights": {"me/past_session": WEIGHT_ME, "community near_beach": WEIGHT_NEAR_BEACH,
                                "community": WEIGHT_COMMUNITY},
                    "accuracy_definition": "1 - weighted MAE of overall on the test set / 4",
                    "saved_model_fitted_on": "all rows (train + test)",
                    "sklearn": sklearn.__version__})
    bundle = {
        "version": version, "scope": scope, "spots_trained_on": metrics["spots_trained_on"],
        "features": FEATURES, "wave_size_m": WAVE_SIZE_M, "metrics": metrics,
        "reference": reference(data),
        # The newest rating this model learned from: the next night's comparison uses only
        # ratings newer than this (see decide()).
        "max_rating_id": max(d["id"] for d in data),
        # Each predicts baseline + correction: see predict(). The baseline (simple score /
        # forecast height) must be computed the same way when the model is used.
        "overall": fit(data, "overall"),
        "wave_height": fit(data, "real_height"),  # None if no real heights at all
    }
    if args.dry_run:
        log.ok(JOB, f"[{label}] would save {version} (accuracy {metrics['accuracy']:.3f}); dry run")
        return
    if scope == "spot":
        model_id, path = save(db, spots[0], version, bundle, metrics, model_info(bundle, data))
        ids = {spots[0]["id"]: model_id}
    else:  # one file, one models row per spot that uses it
        paths = upload_bundle(db, "general", version, bundle, metrics)
        path, ids = paths[0], {}
        for s in spots:
            ids[s["id"]] = insert_model_row(db, s["id"], version, metrics["accuracy"], path,
                                            model_info(bundle, data))
    log.ok(JOB, f"[{label}] saved {version} to {BUCKET}/{path}, accuracy {metrics['accuracy']:.3f}")
    for sid, model_id in ids.items():
        if decisions[sid]["activate"] and not args.no_activate:
            activate(db, model_id)
            log.ok(JOB, f"[{sid}] {version} is now the active model")
        elif decisions[sid]["activate"]:
            log.info(f"[{sid}] would win, but --no-activate: left inactive")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--spot", help="only this spot id (default: every active spot)")
    parser.add_argument("--dry-run", action="store_true", help="train and evaluate, save nothing")
    parser.add_argument("--no-activate", action="store_true", help="save models, never activate them")
    parser.add_argument("--test-days", type=int, default=14, metavar="N",
                        help="evaluate on the ratings of the last N days (default 14)")
    parser.add_argument("--min-train", type=int, default=30, metavar="N",
                        help="fewest training ratings for a model (default 30)")
    parser.add_argument("--min-test", type=int, default=10, metavar="N",
                        help="fewest test ratings in the last --test-days days (default 10)")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    load_dotenv(ROOT / ".env")
    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        log.fail(JOB, "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (.env or GitHub secrets)")
        return 1
    db = Supabase(url, key)
    now = datetime.now(UTC).replace(second=0, microsecond=0)
    spots = http(f"{db.base}/spots?select=id,lat,lon,beach_orientation,buoy_ids,active&order=id", db.headers)
    targets = [s for s in spots if (s["id"] == args.spot if args.spot else s["active"])]
    if not targets:
        log.fail(JOB, "No matching spots.")
        return 1
    print(f"[{JOB}] {iso(now)}{' (dry run)' if args.dry_run else ''}, scikit-learn "
          f"{sklearn.__version__}, test = last {args.test_days} days")

    failed, pooled, low = [], [], []
    for spot in spots:  # every spot's ratings feed the general model, inactive ones too
        try:
            data = build_dataset(db, spot)
        except Exception as exc:
            if spot in targets:
                failed.append(spot["id"])
                log.fail(JOB, f"[{spot['id']}] can't read ratings: {type(exc).__name__}: {exc}")
            continue
        pooled += data
        if spot not in targets:
            continue
        train, test = split_recent(data, now, args.test_days)
        log.info(f"[{spot['id']}] {len(data)} usable ratings: {len(train)} older, {len(test)} in "
                 f"the last {args.test_days} days")
        if not enough(train, test, args):
            low.append(spot)  # handled by the general model below
            continue
        try:
            finish(db, "spot", [spot], data, train, test, args, now)
        except Exception as exc:  # one spot failing must not stop the others
            failed.append(spot["id"])
            log.fail(JOB, f"[{spot['id']}] {type(exc).__name__}: {exc}")

    if low:
        names = ", ".join(s["id"] for s in low)
        train, test = split_recent(pooled, now, args.test_days)
        if not enough(train, test, args):
            log.ok(JOB, f"[general] too few ratings across all spots for {names}: {len(train)} older / "
                        f"{len(test)} recent, need {args.min_train} / {args.min_test}; they keep "
                        "their current model or the simple score")
        else:
            log.info(f"[general] for {names}: {len(pooled)} ratings from "
                     f"{len({d['spot_id'] for d in pooled})} spots")
            try:
                finish(db, "general", low, pooled, train, test, args, now)
            except Exception as exc:
                failed += [s["id"] for s in low]
                log.fail(JOB, f"[general] {type(exc).__name__}: {exc}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
