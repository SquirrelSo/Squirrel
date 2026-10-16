"""Test helpers that reach below the stores, for whichever storage the suite runs on (files, or
PostgreSQL with TEST_ACCOUNTS_DATABASE_URL; see conftest.py)."""

from __future__ import annotations

from backend import config
from backend.db import accounts as db_accounts
from backend.db import connection
from backend.profiles import store as profile_store

_KIND_OF_FILE = {
    profile_store.FITNESS_FILENAME: "fitness",
    profile_store.ACTIVITIES_FILENAME: "activities",
    profile_store.PHYSIQUE_FILENAME: "physique",
    profile_store.HABITS_FILENAME: "habits",
    profile_store.MEASUREMENTS_FILENAME: "measurements",
    profile_store.CONSENTS_FILENAME: "consents",
}


def corrupt_profile_data(user_id: str, filename: str) -> None:
    """Make one of a user's profile documents unreadable: a broken file, or a row without its data."""
    if connection.enabled():
        db_accounts.write_data(user_id, _KIND_OF_FILE[filename], {"corrupt": True})
    else:
        (config.user_dir(user_id) / filename).write_text("{not json")


def still_corrupt(user_id: str, filename: str) -> bool:
    """Whether the document corrupt_profile_data broke is still exactly as it left it."""
    if connection.enabled():
        return db_accounts.read_data(user_id, _KIND_OF_FILE[filename]) == {"corrupt": True}
    return (config.user_dir(user_id) / filename).read_text() == "{not json"


def has_profile_data(user_id: str, filename: str) -> bool:
    if connection.enabled():
        return db_accounts.read_data(user_id, _KIND_OF_FILE[filename]) is not None
    return (config.user_dir(user_id) / filename).exists()


def profiles_in_database() -> list[str]:
    """Every user id with a profile row (always empty when the suite runs on files)."""
    return db_accounts.list_profile_user_ids() if connection.enabled() else []
