"""Sign-in limits (auth/throttle.py) on the real app: guessing passwords and mass sign-ups are refused."""

from __future__ import annotations

import pytest

from backend import config
from backend.auth import throttle
from backend.tests.asgi_client import call

(config._REPO_ROOT / "frontend-dist").mkdir(exist_ok=True)
from backend.main import app  # noqa: E402

PAGE_ONE = {"first_name": "Ana", "last_name": "Tester", "gender": "female", "height_cm": 165, "weight_kg": 60,
            "date_of_birth": "1994-05-10", "mobile": "9990001111"}


@pytest.fixture(autouse=True)
def _users(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path / "users")


@pytest.fixture
def clock(monkeypatch):
    now = [1_800_000_000.0]
    monkeypatch.setattr(throttle.time, "time", lambda: now[0])
    return now


def register(email: str, client: str = "10.0.0.1"):
    return call(app, "POST", "/api/auth/register", client=client,
                json={"email": email, "password": "correct horse", "first_name": "Ana", "last_name": "T"})


def login(email: str, password: str, client: str = "10.0.0.2"):
    return call(app, "POST", "/api/auth/login", json={"email": email, "password": password}, client=client)


def test_five_wrong_passwords_lock_the_email_even_for_the_right_one(clock):
    assert register("ana@example.test").status == 201
    for _ in range(5):
        assert login("ana@example.test", "guess guess").status == 401
    locked = login("ana@example.test", "correct horse")
    assert locked.status == 429 and "Try again in 15 minutes" in locked.json()["detail"]
    assert int(locked.headers["retry-after"]) == 15 * 60
    # From another address too: the lock is on the account, not the device.
    assert login("ANA@example.test", "correct horse", client="10.9.9.9").status == 429
    clock[0] += 15 * 60
    assert login("ana@example.test", "correct horse").status == 200


def test_a_successful_login_clears_the_failures():
    register("ana@example.test")
    for _ in range(4):
        login("ana@example.test", "guess guess")
    assert login("ana@example.test", "correct horse").status == 200
    for _ in range(4):
        assert login("ana@example.test", "guess guess").status == 401  # a fresh count of 5


def test_one_address_guessing_many_emails_is_stopped():
    for n in range(throttle.LOGIN_IP.max_hits):
        assert login(f"user{n}@example.test", "guess guess", client="10.6.6.6").status == 401
    assert login("someone@example.test", "guess guess", client="10.6.6.6").status == 429
    assert login("someone@example.test", "guess guess", client="10.7.7.7").status == 401  # others unaffected


def test_sign_ups_are_limited_per_address_on_both_sign_up_routes():
    for n in range(throttle.SIGNUP_IP.max_hits - 2):
        assert register(f"a{n}@example.test", client="10.1.1.1").status == 201
    for n in range(2):
        body = {**PAGE_ONE, "email": f"b{n}@example.test", "password": "correct horse"}
        assert call(app, "POST", "/api/users", json=body, client="10.1.1.1").status == 200
    assert register("c@example.test", client="10.1.1.1").status == 429
    body = {**PAGE_ONE, "email": "d@example.test", "password": "correct horse"}
    assert call(app, "POST", "/api/users", json=body, client="10.1.1.1").status == 429
    assert register("e@example.test", client="10.2.2.2").status == 201


def test_refreshes_are_limited_per_address():
    for _ in range(throttle.REFRESH_IP.max_hits):
        assert call(app, "POST", "/api/auth/refresh", json={"refresh_token": "x" * 32}, client="10.3.3.3").status == 401
    assert call(app, "POST", "/api/auth/refresh", json={"refresh_token": "x" * 32}, client="10.3.3.3").status == 429


def test_emails_are_never_stored_in_plain_text():
    register("ana@example.test")
    login("ana@example.test", "guess guess")
    assert throttle.email_key("Ana@Example.test ") == throttle.email_key("ana@example.test")
    assert "ana@example.test" not in repr(throttle._memory)
