"""Test harness.

* Schema is built by running the real Alembic migrations (not create_all), once per session.
* Database: a temp SQLite file by default; set SOCIAL_TEST_DATABASE_URL to run the same suite on
  PostgreSQL, e.g. postgresql+psycopg://social:social@localhost:5432/social_test. TEST_DATABASE_URL
  (the other services' name) alone stops the run instead of quietly testing on SQLite.
* Tokens are real RS256 JWTs signed with a key generated for the session.
* The Run Module and object storage are replaced by in-process doubles (the only external
  services); everything else — HTTP layer, auth, SQL — is the production code path.
"""

from __future__ import annotations

import os
import time
import uuid
from pathlib import Path

import jwt
import pytest
from alembic import command
from alembic.config import Config
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.config import Settings
from app.db import Database
from app.main import create_app
from app.ratelimit import LIMITS, RateLimiter
from app.services.media import StoredObject
from app.services.push import RecordingPush
from app.services.run_module import RunModuleError

ROOT = Path(__file__).resolve().parent.parent

# --------------------------------------------------------------------------- keys & tokens

_PRIVATE = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PRIVATE_PEM = _PRIVATE.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
PUBLIC_PEM = _PRIVATE.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()


def make_token(sub: str, *, exp_in: int = 3600, key: str = PRIVATE_PEM, **claims) -> str:
    now = int(time.time())
    return jwt.encode({"sub": sub, "iat": now, "exp": now + exp_in, **claims}, key, algorithm="RS256")


def auth(sub: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(sub)}"}


# --------------------------------------------------------------------------- doubles


class FakeRunModule:
    """Stands in for the Run Module over HTTP: per-subject XP and runs, keyed by the token."""

    configured = True

    def __init__(self):
        self.xp: dict[str, int] = {}
        self.runs: dict[tuple[str, str], dict] = {}
        self.calls: list[tuple[str, str]] = []
        self.fail_with: int | None = None
        # XP earned in the current board window, by subject (GET /v1/leaderboard/xp).
        self.board_xp: dict[str, int] = {}
        self.board_available = True
        # POST /internal/v1/xp/totals (other people's XP, service token): False = unreachable.
        self.totals_available = True
        self.totals_calls: list[list[str]] = []
        # POST /internal/v1/xp/award and /reverse (ambassador rewards): every call, and the ledger.
        self.awards: list[dict] = []
        self.reversals: list[dict] = []
        self.awarded: dict[str, tuple[str, int]] = {}
        self.reversed: set[str] = set()
        self.award_available = True

    @staticmethod
    def _sub(token: str) -> str:
        return jwt.decode(token, options={"verify_signature": False})["sub"]

    def add_run(self, sub: str, run_id: str, *, status: str = "finalized", distance_m: float = 5120, moving_time_s: float = 1800, started_at: str = "2026-09-27T06:00:00Z"):
        self.runs[(sub, run_id)] = {
            "run_id": run_id,
            "status": status,
            "started_at": started_at,
            "stats": {"distance_m": distance_m, "moving_time_s": moving_time_s, "elapsed_time_s": moving_time_s + 60},
            "territory": {"id": "t1", "area_m2": 1234.0, "claimed_at": started_at, "geometry": {"type": "Polygon", "coordinates": [[[73.8, 18.5]]]}},
            "rejection": None,
            "score": None,
        }

    def get_xp(self, token: str) -> int | None:
        sub = self._sub(token)
        self.calls.append(("xp", sub))
        return self.xp.get(sub)

    def get_xp_totals(self, service_token: str, subjects: list[str]) -> dict[str, int] | None:
        assert service_token == "svc-secret"
        self.totals_calls.append(list(subjects))
        if not self.totals_available:
            return None
        return {s: self.xp.get(s, 0) for s in subjects}  # like the Run Module: 0 for no XP yet

    def get_xp_board(self, token: str, window: str, limit: int) -> dict | None:
        self.calls.append(("xp_board", window))
        if not self.board_available:
            return None
        ranked = sorted(((sub, xp) for sub, xp in self.board_xp.items() if xp > 0), key=lambda r: (-r[1], r[0]))
        entries = [{"rank": i + 1, "user_id": sub, "xp": xp} for i, (sub, xp) in enumerate(ranked)]
        me = next((e for e in entries if e["user_id"] == self._sub(token)), None)
        return {"window": window, "day": "2026-09-29", "entries": entries[:limit], "me": me}

    def award_xp(self, service_token: str, subject: str, amount: int, reason: str, idempotency_key: str, *,
                 source_id: str | None = None, metadata: dict | None = None) -> int | None:
        """POST /internal/v1/xp/award: idempotent on the key, like the Run Module."""
        assert service_token == "svc-secret"
        self.awards.append({"subject": subject, "amount": amount, "reason": reason, "source": "social",
                            "idempotency_key": idempotency_key, "source_id": source_id})
        if not self.award_available:
            return None
        if idempotency_key not in self.awarded:
            self.awarded[idempotency_key] = (subject, amount)
            self.xp[subject] = self.xp.get(subject, 0) + amount
        return self.xp.get(subject, 0)

    def reverse_xp(self, service_token: str, idempotency_key: str, reason: str) -> int | None:
        assert service_token == "svc-secret"
        self.reversals.append({"source": "social", "idempotency_key": idempotency_key, "reason": reason})
        if not self.award_available:
            return None
        if idempotency_key not in self.awarded:
            return -1  # 404: no such award
        subject, amount = self.awarded[idempotency_key]
        if idempotency_key not in self.reversed:
            self.reversed.add(idempotency_key)
            self.xp[subject] = self.xp.get(subject, 0) - amount
        return self.xp.get(subject, 0)

    def get_run(self, token: str, run_id: str) -> dict:
        sub = self._sub(token)
        self.calls.append(("run", run_id))
        if self.fail_with:
            raise RunModuleError(self.fail_with, "boom")
        run = self.runs.get((sub, run_id))
        if not run:  # the Run Module only serves the caller's own runs
            raise RunModuleError(404, "not found")
        return run


class FakeRoutePoints:
    """Stands in for the Run Module's run_points: run id → [(lat, lng, recorded_at)]."""

    def __init__(self):
        self.runs: dict[str, list] = {}
        self.reads: list[str] = []

    def points(self, db, run_id: str) -> list:
        self.reads.append(run_id)
        return list(self.runs.get(run_id, []))


class FakeStorage:
    configured = True

    def __init__(self):
        self.objects: dict[str, StoredObject] = {}
        self.presigned: list[str] = []

    def presign_put(self, key, content_type, byte_size):
        self.presigned.append(key)
        return f"https://uploads.test/{key}?sig=abc", {"Content-Type": content_type}

    def head(self, key):
        return self.objects.get(key)

    def public_url(self, key):
        return f"https://cdn.test/{key}"


# --------------------------------------------------------------------------- database

TABLES = ["ambassador_rewards", "ambassador_task_submissions", "ambassador_tasks", "ambassador_profiles",
          "notification_preferences", "push_tickets", "ambassador_applications", "date_dismissals", "zone_visits", "dates_prefs", "user_blocks", "push_tokens", "notifications", "social_challenges", "checkins", "event_rsvps", "events", "crew_vouches",
          "crew_members", "crews", "members", "user_badges", "comments", "post_saves", "post_likes", "posts", "media", "activities", "follows", "user_stats", "users"]


def pytest_configure(config):
    if os.environ.get("TEST_DATABASE_URL") and not os.environ.get("SOCIAL_TEST_DATABASE_URL"):
        raise pytest.UsageError(
            "TEST_DATABASE_URL is set but this suite reads SOCIAL_TEST_DATABASE_URL; it would have run on "
            "SQLite instead. Set SOCIAL_TEST_DATABASE_URL (or unset TEST_DATABASE_URL to use SQLite)."
        )


@pytest.fixture(scope="session")
def database(tmp_path_factory) -> Database:
    url = os.environ.get("SOCIAL_TEST_DATABASE_URL") or f"sqlite:///{tmp_path_factory.mktemp('db') / 'social.db'}"
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "migrations"))
    cfg.set_main_option("sqlalchemy.url", url)
    cfg.attributes["configure_logger"] = False
    if url.startswith("postgresql"):
        command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")
    return Database(url)


@pytest.fixture(autouse=True)
def clean(database):
    yield
    with database.engine.begin() as conn:
        if database.engine.dialect.name == "postgresql":
            conn.execute(text("TRUNCATE " + ", ".join(TABLES) + " CASCADE"))
        else:
            for t in TABLES:
                conn.execute(text(f"DELETE FROM {t}"))


@pytest.fixture
def settings(database) -> Settings:
    return Settings(database_url=str(database.engine.url), jwt_public_key=PUBLIC_PEM, run_module_url="http://run-module.test",
                    internal_token="svc-secret", reminders_enabled=False, app_url="https://app.test")


@pytest.fixture
def run_module() -> FakeRunModule:
    return FakeRunModule()


@pytest.fixture
def storage() -> FakeStorage:
    return FakeStorage()


@pytest.fixture
def limiter() -> RateLimiter:
    # Production limits, except post creation: many tests seed dozens of posts from one user.
    # test_post_create_rate_limit checks the real post limits.
    return RateLimiter(limits={**LIMITS, "post:create": (1000, 60), "post:create:day": (1000, 86_400)})


@pytest.fixture
def pushes() -> RecordingPush:
    return RecordingPush()


@pytest.fixture
def route_points() -> FakeRoutePoints:
    return FakeRoutePoints()


@pytest.fixture
def client(settings, database, run_module, storage, limiter, pushes, route_points) -> TestClient:
    app = create_app(settings, database=database, run_module=run_module, storage=storage, limiter=limiter, push=pushes,
                     route_points=route_points)
    return TestClient(app)


# --------------------------------------------------------------------------- helpers


class Api:
    """Thin helper so tests read like the app's calls."""

    def __init__(self, client: TestClient):
        self.c = client

    def me(self, sub: str) -> dict:
        r = self.c.get("/v1/users/me/profile", headers=auth(sub))
        assert r.status_code == 200, r.text
        return r.json()

    def user(self, sub: str, username: str | None = None, **fields) -> dict:
        """Provision `sub` and optionally set profile fields. Returns the public user id."""
        me = self.me(sub)
        patch = dict(fields)
        if username:
            patch["username"] = username
        if patch:
            r = self.c.patch("/v1/users/me/profile", json=patch, headers=auth(sub))
            assert r.status_code == 200, r.text
            me = r.json()
        return me["user"]

    def post(self, sub: str, **body) -> dict:
        body.setdefault("caption", "Morning miles")
        r = self.c.post("/v1/posts", json=body, headers=auth(sub))
        assert r.status_code == 201, r.text
        return r.json()

    def follow(self, sub: str, user_id: str) -> dict:
        r = self.c.post(f"/v1/users/{user_id}/follow", headers=auth(sub))
        assert r.status_code == 200, r.text
        return r.json()

    def feed(self, sub: str, feed: str = "for_you", **params) -> dict:
        r = self.c.get("/v1/feed", params={"feed": feed, **params}, headers=auth(sub))
        assert r.status_code == 200, r.text
        return r.json()


@pytest.fixture
def api(client) -> Api:
    return Api(client)


def new_sub() -> str:
    return str(uuid.uuid4())
