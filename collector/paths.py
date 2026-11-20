"""Where the app keeps its data. The single place to change these paths.

Data lives OUTSIDE the project folder because the project sits in OneDrive:
OneDrive syncing a SQLite file while it is being written can lock it or create
conflicting copies. Default: ~/surf-app-data (C:\\Users\\<you>\\surf-app-data on
Windows), which OneDrive does not sync. Override with the SURF_DATA_DIR
environment variable (e.g. on a server).
"""

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("SURF_DATA_DIR") or Path.home() / "surf-app-data")

DB_PATH = DATA_DIR / "surf.db"
SNAPSHOT_DIR = DATA_DIR / "snapshots"
LOG_PATH = DATA_DIR / "logs" / "collector.log"
