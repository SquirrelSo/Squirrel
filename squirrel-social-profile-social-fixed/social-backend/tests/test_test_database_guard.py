"""The suite refuses to run on SQLite when only TEST_DATABASE_URL (the other services' name) is set."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_only_test_database_url_set_stops_the_run():
    env = {k: v for k, v in os.environ.items() if k != "SOCIAL_TEST_DATABASE_URL"}
    env["TEST_DATABASE_URL"] = "postgresql+psycopg://nobody@localhost:1/none"
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "--collect-only", "-p", "no:cacheprovider",
                        "tests/test_follows.py"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
    assert r.returncode != 0
    assert "SOCIAL_TEST_DATABASE_URL" in r.stdout + r.stderr
