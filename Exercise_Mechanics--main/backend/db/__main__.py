"""python -m backend.db migrate | backfill | import-files"""

from __future__ import annotations

import logging
import sys

from backend.db import connection
from backend.db.exercise_sessions import backfill
from backend.db.import_files import import_files
from backend.db.migrate import migrate

USAGE = "usage: python -m backend.db migrate | backfill | import-files"


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    command = argv[0] if argv else ""
    if command not in ("migrate", "backfill", "import-files"):
        print(USAGE)
        return 2
    if not connection.enabled():
        print("DATABASE_URL is not set")
        return 1
    if command == "migrate":
        applied = migrate()
        print(f"applied: {', '.join(applied)}" if applied else "already up to date")
    elif command == "backfill":
        written, skipped = backfill()
        print(f"sessions written: {written}, skipped (nothing recorded yet): {skipped}")
    else:
        migrate()
        c = import_files()
        print(f"profiles imported: {c.profiles}, sign-in accounts: {c.accounts}, profile details: {c.data_rows}, "
              f"already in the database (left as they are): {c.already_there}, unreadable: {c.unreadable}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
