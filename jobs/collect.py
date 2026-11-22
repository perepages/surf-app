"""Hourly job: collect forecast, tide, buoy, cam snapshot + crowd count for every spot.

Steps: forecast + tide (jobs/collect_forecast.py), buoys (jobs/collect_buoy.py), cam snapshot +
60-day cleanup (jobs/collect_cam.py). Crowd counting comes later.
Each step runs even if an earlier one failed; exit code 1 if any step failed.
All times are stored in UTC.

Run from the repo root:
  python -m jobs.collect                 # all steps
  python -m jobs.collect --only buoy     # one step (GitHub Actions runs each step like this,
                                         # so each shows up as its own step in the run)
  --dry-run, --show N, --any-time are passed on to the steps.
"""
import argparse
import sys
import traceback

from jobs import collect_buoy, collect_cam, collect_forecast, log

STEPS = {
    "forecast": collect_forecast,
    "buoy": collect_buoy,
    "cam": collect_cam,
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", choices=list(STEPS), help="run just this step")
    args, _ = parser.parse_known_args()

    failed = 0
    for name, module in STEPS.items():
        if args.only and name != args.only:
            continue
        job = module.__name__.split(".")[-1]
        try:
            failed |= 1 if module.main() else 0
        except Exception as exc:  # e.g. Supabase unreachable while listing spots
            traceback.print_exc()
            log.fail(job, f"crashed: {type(exc).__name__}: {exc}")
            failed = 1
    return failed


if __name__ == "__main__":
    sys.exit(main())
