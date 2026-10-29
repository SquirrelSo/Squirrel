"""Drops every table backend/db/migrations creates, so a disposable test database can be migrated from scratch.

Keep this list in step with the migrations: a table missing here survives the drop, and re-running
the migrations then fails with DuplicateTable.
"""

from __future__ import annotations

EXERCISE_TABLES = (
    "exercise_sessions", "activity_types", "user_refresh_tokens", "user_accounts", "user_profile_data",
    "user_personal_details", "user_profiles", "auth_throttle", "email_verification_codes",
    "partner_hunt_preferences", "shared_workout_sessions", "partner_requests", "schema_migrations",
)


def drop_exercise_tables(conn) -> None:
    conn.execute(f"DROP TABLE IF EXISTS {', '.join(EXERCISE_TABLES)} CASCADE")
