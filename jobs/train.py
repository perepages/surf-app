"""Nightly job: retrain the model per spot; promote it only if it beats the current one.

Placeholder for Step 1. Real training is built in a later step.
"""
from datetime import datetime, timezone


def main() -> None:
    print(f"[train] placeholder run at {datetime.now(timezone.utc).isoformat()}")


if __name__ == "__main__":
    main()
