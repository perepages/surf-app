"""Clear logs for the collectors, locally and in GitHub Actions.

Every message is printed as a normal line. Inside GitHub Actions (GITHUB_ACTIONS=true):
  - warn()/fail() also become annotations, listed at the top of the run page, so a broken
    buoy or cam is visible without opening the log;
  - ok()/warn()/fail() also add a row to the run's Summary table.
Never pass key values in a message (GitHub hides known secrets, but don't rely on it).
"""
from __future__ import annotations

import os

IN_ACTIONS = os.environ.get("GITHUB_ACTIONS") == "true"


def _escape(text: str) -> str:
    # Workflow-command escaping, so '%', newlines and ':' can't break the annotation.
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _summary(job: str, status: str, message: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not (IN_ACTIONS and path):
        return
    cell = message.replace("|", "\\|").replace("\n", " ")
    try:
        new = not os.path.exists(path) or os.path.getsize(path) == 0
        with open(path, "a", encoding="utf-8") as f:
            if new:
                f.write(f"### {job}\n\n| | Result |\n|---|---|\n")
            f.write(f"| {status} | {cell} |\n")
    except OSError:
        pass  # the summary is a nicety; never fail a run over it


def ok(job: str, message: str) -> None:
    print(f"  OK    {message}", flush=True)
    _summary(job, "✅", message)


def info(message: str) -> None:
    print(f"        {message}", flush=True)


def warn(job: str, message: str) -> None:
    print(f"  WARN  {message}", flush=True)
    if IN_ACTIONS:
        print(f"::warning title={job}::{_escape(message)}", flush=True)
    _summary(job, "⚠️", message)


def fail(job: str, message: str) -> None:
    print(f"  FAIL  {message}", flush=True)
    if IN_ACTIONS:
        print(f"::error title={job}::{_escape(message)}", flush=True)
    _summary(job, "❌", message)
