"""Hourly job: collect forecast, tide, buoy, cam snapshot + crowd count for every spot.

Placeholder for Step 1. Real collection is built in a later step.
All times are stored in UTC.
"""
from datetime import datetime, timezone


def main() -> None:
    print(f"[collect] placeholder run at {datetime.now(timezone.utc).isoformat()}")


if __name__ == "__main__":
    main()
