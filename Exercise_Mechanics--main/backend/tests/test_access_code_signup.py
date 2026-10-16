"""The separate, four-field access-code signup path."""

from __future__ import annotations

import logging
import base64
import json
import re

import psycopg
import pytest
from fastapi import FastAPI

from backend import config, mailer
from backend.auth.store import register_account
from backend.auth.router import router as auth_router
from backend.auth.store import read_credential
from backend.db import connection
from backend.tests.asgi_client import call
from backend.profiles.router import router as profiles_router
from backend.users.router import router as users_router
from backend.users.store import read_profile


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path / "users")
    monkeypatch.setenv("SIGNUP_ACCESS_CODE", "731904")
    app = FastAPI()
    app.include_router(auth_router)
    app.include_router(users_router)
    app.include_router(profiles_router)
    return app


def _payload(**overrides):
    return {"email": "john.doe@gmail.com", "full_name": "John Doe", "phone": "+919876543210",
            "access_code": "731904", **overrides}


def _count_accounts() -> int:
    if connection.enabled():
        with psycopg.connect(connection.database_url()) as conn:
            return conn.execute("SELECT count(*) FROM user_accounts").fetchone()[0]
    return len(list((config.AUTH_DIR / "credentials").glob("*.json")))


def _claims(token: str) -> dict:
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def test_all_four_fields_create_account_with_original_email_lookup_and_normalized_phone(app):
    response = call(app, "POST", "/api/auth/signup/access-code", json=_payload())
    assert response.status == 201
    assert _count_accounts() == 1
    assert read_credential("john.doe@gmail.com") is not None
    assert read_credential("johndoe@gmail.com") is None
    profile = read_profile(response.json()["user_id"])
    assert profile["email"] == "john.doe@gmail.com"
    assert profile["email_as_entered"] == "john.doe@gmail.com"
    assert profile["full_name"] == "John Doe"
    assert profile["mobile"] == "+919876543210"
    assert "phone_number_unverified" not in profile
    assert profile["created_at"]


@pytest.mark.parametrize("field", ["email", "full_name", "phone", "access_code"])
def test_each_missing_required_field_is_refused_without_account_row(app, field):
    payload = _payload()
    del payload[field]
    response = call(app, "POST", "/api/auth/signup/access-code", json=payload)
    assert response.status == 422
    assert _count_accounts() == 0


def test_wrong_access_code_is_generic_and_creates_no_account(app):
    response = call(app, "POST", "/api/auth/signup/access-code", json=_payload(access_code="000000"))
    assert response.status == 403
    assert response.json()["detail"] == "Sign-up failed. Check your details and try again."
    assert _count_accounts() == 0


def test_unset_access_code_fails_closed(app, monkeypatch):
    monkeypatch.delenv("SIGNUP_ACCESS_CODE")
    response = call(app, "POST", "/api/auth/signup/access-code", json=_payload())
    assert response.status == 403
    assert response.json()["detail"] == "Sign-up failed. Check your details and try again."
    assert _count_accounts() == 0


def test_gmail_alias_is_checked_against_both_sides_without_changing_existing_lookup(app):
    existing = register_account("john.doe@gmail.com", "not-a-login-password", "John", "Doe")
    response = call(app, "POST", "/api/auth/signup/access-code", json=_payload(email="johndoe@gmail.com"))
    assert response.status == 409
    assert read_credential("john.doe@gmail.com")["user_id"] == existing
    assert read_credential("johndoe@gmail.com") is None
    assert _count_accounts() == 1


def test_googlemail_alias_is_treated_as_the_same_gmail_mailbox(app):
    existing = register_account("john.doe+legacy@googlemail.com", "not-a-login-password", "John", "Doe")
    response = call(app, "POST", "/api/auth/signup/access-code", json=_payload(email="johndoe@gmail.com"))
    assert response.status == 409
    assert read_credential("john.doe+legacy@googlemail.com")["user_id"] == existing
    assert _count_accounts() == 1


def test_existing_ac_in_email_code_signup_route_still_works(app, monkeypatch):
    sent = []
    monkeypatch.setenv(config.EMAIL_VERIFICATION_ENV, "on")
    monkeypatch.setenv(config.ALLOWED_EMAIL_DOMAINS_ENV, "*")
    monkeypatch.setattr(mailer, "send_email", lambda to, subject, text: sent.append((to, text)))
    response = call(app, "POST", "/api/auth/email/start", json={"email": "student@iiserkol.ac.in"})
    assert response.status == 202
    assert response.json()["new_account"] is True
    assert sent[0][0] == "student@iiserkol.ac.in"
    code = re.search(r"\b(\d{6})\b", sent[0][1]).group(1)
    verified = call(app, "POST", "/api/auth/email/verify", json={
        "email": "student@iiserkol.ac.in", "code": code, "first_name": "Student",
    })
    assert verified.status == 200 and verified.json()["new_account"] is True
    assert _count_accounts() == 1


def test_gmail_alias_email_code_sign_in_finds_same_account_and_sends_to_typed_alias(app, monkeypatch):
    sent = []
    monkeypatch.setattr(mailer, "send_email", lambda to, subject, text: sent.append((to, text)))
    user_id = register_account("john.doe@gmail.com", "not-a-login-password", "John", "Doe")

    alias = "JohnDoe+x@googlemail.com"
    started = call(app, "POST", "/api/auth/email/start", json={"email": alias})
    assert started.status == 202 and started.json()["new_account"] is False
    assert sent[-1][0] == "johndoe+x@googlemail.com"
    code = re.search(r"\b(\d{6})\b", sent[-1][1]).group(1)

    verified = call(app, "POST", "/api/auth/email/verify", json={"email": alias, "code": code})
    assert verified.status == 200
    assert verified.json()["new_account"] is False
    assert verified.json()["user_id"] == user_id


def test_ambiguous_gmail_alias_falls_back_without_selecting_an_existing_account(app, monkeypatch):
    sent = []
    monkeypatch.setattr(mailer, "send_email", lambda to, subject, text: sent.append((to, text)))
    first = register_account("john.doe@gmail.com", "not-a-login-password", "John", "Doe")
    second = register_account("johndoe+old@googlemail.com", "not-a-login-password", "Other", "Person")
    assert first != second

    started = call(app, "POST", "/api/auth/email/start", json={"email": "JohnDoe@gmail.com"})
    assert started.status == 202
    assert started.json()["new_account"] is True
    assert sent[-1][0] == "johndoe@gmail.com"
    code = re.search(r"\b(\d{6})\b", sent[-1][1]).group(1)
    fallback = call(app, "POST", "/api/auth/email/verify", json={
        "email": "JohnDoe@gmail.com", "code": code, "first_name": "John",
    })
    assert fallback.status == 200 and fallback.json()["new_account"] is True
    assert fallback.json()["user_id"] not in {first, second}


def test_exact_email_match_wins_even_when_an_alias_is_also_present(app, monkeypatch):
    sent = []
    monkeypatch.setattr(mailer, "send_email", lambda to, subject, text: sent.append((to, text)))
    exact_id = register_account("john.doe@gmail.com", "not-a-login-password", "John", "Doe")
    register_account("johndoe+other@gmail.com", "not-a-login-password", "Other", "Person")

    started = call(app, "POST", "/api/auth/email/start", json={"email": "john.doe@gmail.com"})
    assert started.status == 202 and started.json()["new_account"] is False
    code = re.search(r"\b(\d{6})\b", sent[-1][1]).group(1)
    verified = call(app, "POST", "/api/auth/email/verify", json={"email": "john.doe@gmail.com", "code": code})
    assert verified.status == 200 and verified.json()["user_id"] == exact_id


def test_non_gmail_domains_are_not_folded_for_email_code_sign_in(app, monkeypatch):
    sent = []
    monkeypatch.setattr(mailer, "send_email", lambda to, subject, text: sent.append(to))
    register_account("j.ohn@company.example", "not-a-login-password", "John", "Doe")
    started = call(app, "POST", "/api/auth/email/start", json={"email": "john@company.example"})
    assert started.status == 202
    assert started.json()["new_account"] is True
    assert sent[-1] == "john@company.example"


def test_access_code_signup_per_ip_limit_counts_only_failed_attempts(app):
    successful = [call(app, "POST", "/api/auth/signup/access-code",
                       json=_payload(email=f"eventuser{i}@gmail.com")) for i in range(6)]
    assert [r.status for r in successful] == [201] * 6
    responses = [call(app, "POST", "/api/auth/signup/access-code", json=_payload(access_code="000000"))
                 for _ in range(6)]
    assert [r.status for r in responses] == [403, 403, 403, 403, 403, 429]
    assert _count_accounts() == 6


def test_access_code_signup_global_limit_caps_failures_across_ips(app):
    failures = [call(app, "POST", "/api/auth/signup/access-code", json=_payload(access_code="000000"),
                     client=f"198.51.100.{i}") for i in range(1, 101)]
    assert all(response.status == 403 for response in failures)
    capped = call(app, "POST", "/api/auth/signup/access-code", json=_payload(access_code="000000"),
                  client="203.0.113.200")
    assert capped.status == 429
    assert _count_accounts() == 0


def test_email_verification_revokes_refresh_but_access_token_lives_until_expiry(app, monkeypatch):
    sent = []
    monkeypatch.setattr(mailer, "send_email", lambda to, subject, text: sent.append(text))
    created = call(app, "POST", "/api/auth/signup/access-code", json=_payload())
    assert created.status == 201
    first_token = created.json()["access_token"]
    first_refresh = created.json()["refresh_token"]
    before = call(app, "GET", "/api/me/profile-details", headers={"authorization": f"Bearer {first_token}"})
    assert before.status == 200

    started = call(app, "POST", "/api/auth/email/start", json={"email": "john.doe@gmail.com"})
    assert started.status == 202
    code = re.search(r"\b(\d{6})\b", sent[-1]).group(1)
    verified = call(app, "POST", "/api/auth/email/verify", json={"email": "john.doe@gmail.com", "code": code})
    assert verified.status == 200
    assert verified.json()["new_account"] is False
    assert "session_version" not in read_profile(created.json()["user_id"])
    assert "sv" not in _claims(verified.json()["access_token"])

    # Access tokens are stateless and intentionally remain valid until their 15-minute expiry.
    still_valid = call(app, "GET", "/api/me/profile-details", headers={"authorization": f"Bearer {first_token}"})
    assert still_valid.status == 200
    assert call(app, "POST", "/api/auth/refresh", json={"refresh_token": first_refresh}).status == 401
    fresh = call(app, "GET", "/api/me/profile-details",
                 headers={"authorization": f"Bearer {verified.json()['access_token']}"})
    assert fresh.status == 200


def test_access_code_is_absent_from_response_and_logs(app, caplog):
    caplog.set_level(logging.DEBUG)
    response = call(app, "POST", "/api/auth/signup/access-code", json=_payload())
    assert response.status == 201
    rejected = call(app, "POST", "/api/auth/signup/access-code", json=_payload(access_code="000000"))
    assert rejected.status == 403
    assert "731904" not in response.text
    assert "731904" not in rejected.text
    assert "731904" not in caplog.text

