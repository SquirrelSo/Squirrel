"""An in-memory stand-in for the Run Module's XP award route (POST /internal/v1/xp/award), plugged in
where backend/xp_awards.py opens its HTTP request (see the `fake_run_module` fixture in conftest.py).

It records every award in `awards` and answers like the Run Module: a replay of the same
(source, idempotency_key) returns the same total and adds nothing. Set `failure` to make calls fail
the way an outage would.
"""

from __future__ import annotations

import io
import json
import urllib.error

URL = "http://run.test"


class FakeRunModule:
    def __init__(self) -> None:
        self.calls: list[dict] = []           # every request body, replays included
        self.headers: list[str | None] = []   # the Authorization header of each call
        self.ledger: dict[tuple[str, str], dict] = {}
        self.failure: int | str | None = None  # None, an HTTP status, or "down"

    @property
    def awards(self) -> list[dict]:
        """Distinct awards, as the ledger keeps them."""
        return list(self.ledger.values())

    def total(self, subject: str) -> int:
        return sum(a["amount"] for a in self.ledger.values() if a["subject"] == subject)

    def __call__(self, request, timeout):
        assert request.full_url == URL + "/internal/v1/xp/award" and request.get_method() == "POST"
        assert 0 < timeout <= 30
        body = json.loads(request.data)
        self.calls.append(body)
        self.headers.append(request.get_header("Authorization"))
        if self.failure == "down":
            raise urllib.error.URLError("connection refused")
        if isinstance(self.failure, int):
            raise urllib.error.HTTPError(request.full_url, self.failure, "error", {}, io.BytesIO(b"{}"))
        self.ledger.setdefault((body["source"], body["idempotency_key"]), body)
        return io.BytesIO(json.dumps(self.total(body["subject"])).encode())
