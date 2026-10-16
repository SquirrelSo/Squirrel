"""PostgreSQL storage.

Optional: without DATABASE_URL the backend runs on its per-user files, and every database call here
is a no-op. With it:

  * accounts, refresh tokens and profiles live in the database only (accounts.py, migration 002),
    and so do Partner Hunt preferences (partner_hunt.py, migration 005);
  * each exercise session is mirrored into `exercise_sessions` (migration 001) and, for accounts,
    into the shared `activity_sessions` that XP is derived from (activity_sessions.py). Session files
    stay the source of truth, so a database that is down never interrupts training;
    `python -m backend.db backfill` catches the tables up afterwards.

    python -m backend.db migrate        apply pending migrations
    python -m backend.db backfill       write every stored session into the tables
    python -m backend.db import-files   copy accounts and profiles from data/ into the database
"""
