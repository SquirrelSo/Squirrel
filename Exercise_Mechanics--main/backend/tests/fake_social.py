"""An in-memory stand-in for the Social service's internal routes, plugged in where
backend/social_blocks.py and backend/social_people.py open their HTTP requests (see the
`fake_social` fixture in conftest.py).

It answers like social-backend/app/routers/internal.py: GET /internal/v1/blocks/{sub} returns
everyone blocked either way, POST /internal/v1/blocks/import adds pairs idempotently, and
POST /internal/v1/people/resolve turns subjects into people (provisioning unseen ones, as Social
does), and POST /internal/v1/notifications is recorded in `notifications`. Set `failure` to make every call fail the way a real outage would.
"""

from __future__ import annotations

import io
import json
import urllib.error
import urllib.parse
import uuid

URL = "http://social.test"
TOKEN = "svc-test-token"


class FakeSocial:
    def __init__(self) -> None:
        self.pairs: set[tuple[str, str]] = set()   # (blocker, blocked)
        self.requests: list[tuple[str, str, dict | None]] = []
        # None: answer normally. An int: answer with that HTTP status. "down": connection refused.
        # "timeout": no answer in time. "garbage": 200 with a body that is not the contract's shape.
        self.failure: int | str | None = None
        self.names: dict[str, str] = {}             # display names by subject; a default otherwise
        self.notifications: list[dict] = []
        self.notifications_fail = False             # only the notification route fails

    def block(self, blocker: str, blocked: str) -> None:
        """A block made elsewhere, e.g. with the app's Block button."""
        self.pairs.add((blocker, blocked))

    def profile_id(self, sub: str) -> str:
        """The Social profile id this fake gives a subject (stable, and never the subject itself)."""
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"social-profile:{sub}"))

    def name(self, sub: str) -> str:
        return self.names.get(sub, f"Member {sub[:6]}")

    def lookups(self) -> list[str]:
        return [urllib.parse.unquote(path.rsplit("/", 1)[1]) for method, path, _ in self.requests if method == "GET"]

    def __call__(self, request, timeout):
        method, url = request.get_method(), request.full_url
        assert url.startswith(URL + "/internal/v1/")
        path = url[len(URL):]
        # Anything a request waits on must time out quickly; notifications are sent in the background.
        assert 0 < timeout <= (90 if path == "/internal/v1/notifications" else 10)
        body = json.loads(request.data) if request.data else None
        self.requests.append((method, path, body))
        if self.failure == "down":
            raise urllib.error.URLError("connection refused")
        if self.failure == "timeout":
            raise TimeoutError("timed out")
        if isinstance(self.failure, int):
            raise urllib.error.HTTPError(url, self.failure, "error", {}, io.BytesIO(b"{}"))
        if request.get_header("Authorization") != f"Bearer {TOKEN}":
            raise urllib.error.HTTPError(url, 401, "Unauthorized", {}, io.BytesIO(b"{}"))
        if self.failure == "garbage":
            return io.BytesIO(b'{"blocked": "everyone"}')
        if method == "POST" and path == "/internal/v1/notifications":
            if self.notifications_fail:
                raise urllib.error.HTTPError(url, 502, "Bad Gateway", {}, io.BytesIO(b"{}"))
            self.notifications.append(body)
            return io.BytesIO(json.dumps({"created": True, "notification_id": str(uuid.uuid4())}).encode())
        if method == "POST" and path == "/internal/v1/people/resolve":
            people = [{"subject": sub, "profile_id": self.profile_id(sub), "username": f"user{i}",
                       "display_name": self.name(sub), "avatar_url": None, "hostel": None, "level": 1}
                      for i, sub in enumerate(dict.fromkeys(body.get("subjects", [])))]
            return io.BytesIO(json.dumps({"people": people}).encode())
        if method == "POST" and path == "/internal/v1/blocks/import":
            counts = {"imported": 0, "already": 0, "skipped": 0}
            for pair in body["blocks"]:
                key = (pair["blocker"], pair["blocked"])
                if key[0] == key[1]:
                    counts["skipped"] += 1
                elif key in self.pairs:
                    counts["already"] += 1
                else:
                    self.pairs.add(key)
                    counts["imported"] += 1
            return io.BytesIO(json.dumps(counts).encode())
        assert method == "GET" and path.startswith("/internal/v1/blocks/")
        sub = urllib.parse.unquote(path.rsplit("/", 1)[1])
        blocked = sorted({b for a, b in self.pairs if a == sub} | {a for a, b in self.pairs if b == sub})
        return io.BytesIO(json.dumps({"subject": sub, "blocked": blocked, "as_of": "2026-10-01T00:00:00Z"}).encode())
