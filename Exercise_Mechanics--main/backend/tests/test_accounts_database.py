"""Accounts and profiles in PostgreSQL (migration 002), and Partner Hunt preferences (005), against a
real database.

Runs when TEST_DATABASE_URL points at a disposable database (its tables are dropped and recreated);
skipped otherwise. The rest of the suite covers the same behaviour on either storage (conftest.py);
this file covers what only a shared database has: concurrent requests, restarts, and the import.
"""

from __future__ import annotations

import os
import threading
import time

import psycopg
import pytest

from backend import config
from backend.auth import store as auth_store
from backend.db import connection
from backend.db.import_files import import_files
from backend.db.migrate import migrate
from backend.partners import service as partners
from backend.partners import store as partner_store
from backend.profiles import store as profile_store
from backend.profiles.service import onboard
from backend.tests.db_reset import drop_exercise_tables
from backend.users.store import read_profile, read_skill, write_skill

TEST_URL = os.environ.get("TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(not TEST_URL, reason="TEST_DATABASE_URL not set")

CORE = {"first_name": "Ana", "last_name": "Tester", "gender": "female", "height_cm": 165.0, "weight_kg": 60.0,
        "date_of_birth": "1994-05-10", "mobile": "9990001111", "email": "ana@example.test"}


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path / "users")
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        drop_exercise_tables(conn)
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        migrate(conn)
    monkeypatch.setenv("DATABASE_URL", TEST_URL)
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        yield conn
    connection.close_pools()


def _in_parallel(fn, n: int) -> list:
    results: list = [None] * n
    start = threading.Barrier(n)

    def run(i: int) -> None:
        start.wait()
        try:
            results[i] = fn(i)
        except Exception as exc:  # noqa: BLE001 — collected and asserted on
            results[i] = exc

    threads = [threading.Thread(target=run, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


def test_an_account_lives_in_the_database_and_survives_a_restart(db):
    identity = onboard(dict(CORE), password="correct horse")
    uid = identity["user_id"]
    assert not (config.USERS_DIR / uid / config.PROFILE_FILENAME).exists()  # nothing on disk
    row = db.execute("SELECT first_name, last_name, email FROM user_profiles WHERE user_id = %s", (uid,)).fetchone()
    assert row == ("Ana", "Tester", "ana@example.test")  # readable columns in the Supabase editor
    [(stored,)] = db.execute("SELECT password_hash FROM user_accounts").fetchall()
    assert stored.startswith("scrypt$") and "correct horse" not in stored

    connection.close_pools()  # a redeploy: nothing in memory, nothing on disk
    credential = auth_store.read_credential("ANA@example.test ")
    assert credential["user_id"] == uid
    assert read_profile(uid)["height_cm"] == 165.0
    assert profile_store.read_measurements(uid)[0]["weight_kg"] == 60.0


def test_two_sign_ups_with_one_email_at_the_same_moment_make_one_account(db):
    results = _in_parallel(lambda i: auth_store.register_account("same@example.test", "correct horse", "A", str(i)), 8)
    made = [r for r in results if isinstance(r, str)]
    assert len(made) == 1
    assert all(isinstance(r, auth_store.EmailTaken) for r in results if not isinstance(r, str))
    assert db.execute("SELECT count(*) FROM user_profiles").fetchone() == (1,)  # no orphan profiles


def test_gmail_alias_credentials_returns_a_stored_alias_match(db):
    uid = auth_store.register_account("John.Doe@gmail.com", "correct horse", "John", "Doe")

    matches = auth_store.db_accounts.gmail_alias_credentials("johndoe@gmail.com")

    assert [match["user_id"] for match in matches] == [uid]


def test_gmail_alias_credentials_returns_all_ambiguous_matches(db):
    first = auth_store.register_account("a.b@gmail.com", "correct horse", "A", "One")
    second = auth_store.register_account("ab+two@googlemail.com", "correct horse", "A", "Two")

    matches = auth_store.db_accounts.gmail_alias_credentials("ab@gmail.com")

    assert {match["user_id"] for match in matches} == {first, second}


def test_gmail_alias_credentials_matches_stored_googlemail_plus_tag(db):
    uid = auth_store.register_account("John.Doe+run@googlemail.com", "correct horse", "John", "Doe")

    matches = auth_store.db_accounts.gmail_alias_credentials("johndoe@gmail.com")

    assert [match["user_id"] for match in matches] == [uid]


def test_a_refresh_token_works_once_even_when_two_refreshes_race(db):
    uid = auth_store.register_account("ana@example.test", "correct horse", "Ana", "Tester")
    token, _ = auth_store.issue_refresh_token(uid)
    assert token not in str(db.execute("SELECT * FROM user_refresh_tokens").fetchall())  # only its hash
    results = _in_parallel(lambda _: auth_store.consume_refresh_token(token), 6)
    assert sorted(results, key=str) == sorted([uid] + [None] * 5, key=str)
    expired, _ = auth_store.issue_refresh_token(uid, now=time.time() - 10 * config.REFRESH_TOKEN_TTL_SECONDS)
    assert auth_store.consume_refresh_token(expired) is None
    assert db.execute("SELECT count(*) FROM user_refresh_tokens").fetchone() == (0,)


def test_consent_decisions_made_at_once_are_all_kept(db):
    uid = onboard(dict(CORE), password="correct horse")["user_id"]
    event = lambda i: {"category": "habits", "granted": bool(i % 2), "policy_version": "v1", "recorded_at": str(i)}
    _in_parallel(lambda i: profile_store.append_consent_event(uid, event(i)), 10)
    assert sorted(e["recorded_at"] for e in profile_store.read_consent_events(uid)) == [str(i) for i in range(10)]


def test_import_copies_accounts_and_profiles_from_files_once(db, monkeypatch):
    # A server from before: everything in files.
    monkeypatch.delenv("DATABASE_URL")
    uid = onboard(dict(CORE), password="correct horse")["user_id"]
    write_skill(uid, "advanced")
    legacy = onboard({**CORE, "email": "old@example.test"})["user_id"]  # password-less, from the browser coach

    monkeypatch.setenv("DATABASE_URL", TEST_URL)
    counts = import_files()
    assert (counts.profiles, counts.accounts, counts.already_there) == (2, 1, 0)
    assert auth_store.read_credential("ana@example.test")["user_id"] == uid  # same id, same password hash
    assert read_skill(uid) == ("advanced", True)
    assert read_profile(legacy)["email"] == "old@example.test"
    assert profile_store.read_measurements(uid)[0]["height_cm"] == 165.0

    write_skill(uid, "beginner")  # used since the import: a second run must not undo it
    again = import_files()
    assert (again.profiles, again.already_there) == (0, 2)
    assert read_skill(uid) == ("beginner", True)


def test_the_database_refuses_impossible_rows(db):
    bad = [
        ("INSERT INTO user_profiles (user_id, profile) VALUES ('Bad Id', '{\"user_id\": \"Bad Id\"}')"),
        ("INSERT INTO user_profiles (user_id, profile) VALUES ('ana-1', '{\"user_id\": \"someone-else\"}')"),
        ("INSERT INTO user_profile_data (user_id, kind, data) VALUES ('ana-1', 'passwords', '{}')"),
    ]
    for statement in bad:
        with pytest.raises(psycopg.errors.IntegrityError):
            db.execute(statement)
    db.execute("INSERT INTO user_profiles (user_id, profile) VALUES ('ana-1', '{\"user_id\": \"ana-1\"}')")
    for email, digest in (("Ana@Example.test", "scrypt$1"), ("ana@example.test", "plaintext")):
        with pytest.raises(psycopg.errors.IntegrityError):
            db.execute("INSERT INTO user_accounts (user_id, email, password_hash) VALUES ('ana-1', %s, %s)",
                       (email, digest))
    for user_id, email, course, cgpa in (("nobody-1", "ana@gmail.test", "BSc", 8), ("ana-1", "Ana@Gmail.test", "BSc", 8),
                                         ("ana-1", "not-an-email", "BSc", 8), ("ana-1", "ana@gmail.test", "", 8),
                                         ("ana-1", "ana@gmail.test", "BSc", 10.5)):
        with pytest.raises(psycopg.errors.IntegrityError):
            db.execute("INSERT INTO user_personal_details (user_id, personal_email, course, cgpa) "
                       "VALUES (%s, %s, %s, %s)", (user_id, email, course, cgpa))
    db.execute("INSERT INTO user_personal_details (user_id, personal_email, course, cgpa) "
               "VALUES ('ana-1', 'ana@gmail.test', 'BSc', NULL)")
    db.execute("DELETE FROM user_profiles WHERE user_id = 'ana-1'")
    assert db.execute("SELECT count(*) FROM user_personal_details").fetchone()[0] == 0  # goes with the account


def test_partner_hunt_preferences_live_in_the_database_and_survive_a_restart(db):
    uid = onboard(dict(CORE), password="correct horse")["user_id"]
    assert partner_store.read_preferences(uid) is None  # none saved: the default, as with no file
    preferences = {"visible": True, "activities": ["running"], "mode": "remote", "city": None,
                   "preferred_times": ["morning"], "partner_genders": [], "partner_age_min": 18,
                   "partner_age_max": 40}
    partners.save_preferences(uid, preferences)
    partners.save_preferences(uid, {**preferences, "visible": False})  # a save replaces the last one
    assert not (config.USERS_DIR / uid / partner_store.PREFERENCES_FILENAME).exists()  # nothing on disk
    [(stored,)] = db.execute("SELECT preferences FROM partner_hunt_preferences WHERE user_id = %s", (uid,)).fetchall()
    assert stored == {**preferences, "visible": False}

    connection.close_pools()  # a redeploy: nothing in memory, nothing on disk
    assert partner_store.read_preferences(uid) == {**preferences, "visible": False}

    # Only an object can be stored, and a user's preferences go with their profile.
    with pytest.raises(psycopg.errors.IntegrityError):
        db.execute("UPDATE partner_hunt_preferences SET preferences = '[]' WHERE user_id = %s", (uid,))
    db.execute("DELETE FROM user_profiles WHERE user_id = %s", (uid,))
    assert partner_store.read_preferences(uid) is None
