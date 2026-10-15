"""Shared test setup.

Every test runs with sign-in storage in a temporary folder and a fixed signing secret, so no test
can write credentials, refresh tokens or invites into the real data/ directory.

No test ever uses the DATABASE_URL of the shell it runs in: it is removed, so a developer whose
.env points at Supabase cannot write test accounts into it. To run the whole suite with accounts and
profiles in PostgreSQL instead of files, point TEST_ACCOUNTS_DATABASE_URL at a disposable database;
its account and profile tables are emptied before every test.

Social is never called for real either: SOCIAL_API_URL and SOCIAL_INTERNAL_TOKEN are removed, and
tests that need Social's blocks use the `fake_social` fixture (tests/fake_social.py).
"""

from __future__ import annotations

import os

import psycopg
import pytest

from backend import config, social_blocks, social_notify, social_people, xp_awards
from backend.auth import throttle
from backend.tests.fake_run_module import URL as RUN_URL, FakeRunModule
from backend.tests.fake_social import TOKEN as SOCIAL_TOKEN, URL as SOCIAL_URL, FakeSocial

ACCOUNTS_DB_URL = os.environ.get("TEST_ACCOUNTS_DATABASE_URL", "")
_ACCOUNT_TABLES = ("user_refresh_tokens, user_accounts, user_profile_data, user_personal_details, user_profiles, "
                   "auth_throttle, email_verification_codes, partner_hunt_preferences, shared_workout_sessions, partner_requests")


@pytest.fixture(scope="session")
def _accounts_database():
    if not ACCOUNTS_DB_URL:
        yield None
        return
    from backend.db import migrate

    with psycopg.connect(ACCOUNTS_DB_URL) as conn:
        migrate.migrate(conn)
        conn.commit()
    yield ACCOUNTS_DB_URL


@pytest.fixture(autouse=True)
def _isolated_auth_storage(tmp_path_factory, monkeypatch, _accounts_database):
    root = tmp_path_factory.mktemp("auth-data")
    monkeypatch.setattr(config, "AUTH_DIR", root / "auth")
    monkeypatch.setattr(config, "INVITES_DIR", root / "invites")
    monkeypatch.setattr(config, "SHARED_WORKOUTS_DIR", root / "shared_workouts")
    monkeypatch.setattr(config, "PARTNER_REQUESTS_FILE", root / "partner_hunt" / "requests.json")
    monkeypatch.setenv(config.AUTH_SECRET_ENV, "test-signing-secret")
    monkeypatch.delenv(config.REQUIRE_AUTH_ENV, raising=False)
    # Sign-up's email gate is tested in test_email_verification.py; elsewhere any address signs up
    # without a code.
    monkeypatch.setenv(config.EMAIL_VERIFICATION_ENV, "off")
    monkeypatch.setenv(config.ALLOWED_EMAIL_DOMAINS_ENV, "*")
    for name in ("SMTP_USER", "SMTP_PASSWORD", "RESEND_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    for name in ("SOCIAL_API_URL", "SOCIAL_INTERNAL_TOKEN", "RUN_MODULE_URL", "RUN_MODULE_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    social_blocks.clear_cache()
    throttle.reset_memory()
    from backend.shared_workouts import hub, presence, service as shared_service

    hub.reset()
    presence.reset()
    shared_service.reset_rate_limits()
    if _accounts_database:
        with psycopg.connect(_accounts_database, autocommit=True) as conn:
            conn.execute(f"TRUNCATE {_ACCOUNT_TABLES}")
        monkeypatch.setenv("DATABASE_URL", _accounts_database)


@pytest.fixture
def fake_social(monkeypatch) -> FakeSocial:
    """Social's internal routes (blocks, people/resolve, notifications), in memory: configured as Social would be,
    and answering normally until a test sets `failure`."""
    social = FakeSocial()
    monkeypatch.setenv("SOCIAL_API_URL", SOCIAL_URL)
    monkeypatch.setenv("SOCIAL_INTERNAL_TOKEN", SOCIAL_TOKEN)
    monkeypatch.setattr(social_blocks, "_urlopen", social)
    monkeypatch.setattr(social_people, "_urlopen", social)
    monkeypatch.setattr(social_notify, "_urlopen", social)
    monkeypatch.setattr(social_notify, "_in_background", lambda send: send())   # inline, so tests see it
    return social


@pytest.fixture
def fake_run_module(monkeypatch) -> FakeRunModule:
    """The Run Module's XP award route, recorded in memory (`awards`), sent inline so tests see it."""
    run = FakeRunModule()
    monkeypatch.setenv("RUN_MODULE_URL", RUN_URL)
    monkeypatch.setattr(xp_awards, "_urlopen", run)
    monkeypatch.setattr(xp_awards, "_in_background", lambda send: send())
    return run


@pytest.fixture
def legacy_rep_counting(monkeypatch):
    """Count every rep past min_rep_peak, however fast or shallow (the policy before fsm.yaml's
    count_shallow / min_rep_ms). For tests of scoring, coaching and capture mechanics that drive
    synthetic reps at 100 ms a frame: far quicker than a person, and deliberately shallow ones.
    The counting policy itself is tested against the real configs in test_rep_counting_policy.py."""
    from backend.engine import rep_outcome

    monkeypatch.setattr(rep_outcome, "fsm_policy_inputs", lambda fsm: {})
