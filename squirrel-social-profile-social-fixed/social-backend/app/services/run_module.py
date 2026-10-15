"""Read-only client for the Run Module, called with the *caller's own* bearer token.

The Run Module stays the source of truth for runs and XP. Social never accepts those numbers
from the app; it reads them here:

  GET /v1/users/me/xp  → { xp, updated_at, breakdown }
  GET /v1/runs/:id     → { run_id, status, started_at, stats{distance_m, moving_time_s, elapsed_time_s}, ... }
  GET /v1/leaderboard/xp?window=daily|weekly&limit=N
                       → { window, day, entries[{rank, user_id, xp}], me{rank, user_id, xp} | null }
                         (XP earned in the window, by the account's JWT subject; for the boards)

One call is made with the *service* token instead (SOCIAL_INTERNAL_TOKEN), for other people's XP:

  POST /internal/v1/xp/totals { subjects[] ≤200 } → { subject: xp }   (ADR-032 "XP reads")
  POST /internal/v1/xp/award  { subject, amount, reason, source: "social", idempotency_key, source_id?, metadata? }
                              → bare integer: the subject's new total (ambassador rewards, CONTRACT §1)
  POST /internal/v1/xp/reverse { source: "social", idempotency_key, reason } → bare integer; 404 = no such award

Award and reverse are called after Social's own commit and fail soft: they return None (logged)
and the caller keeps the reward row pending, to retry on its next check.

ASSUMPTION (matches mobile/src/api/endpoints.ts): GET /v1/runs/:id only returns runs owned by
the token's user (404 otherwise), which is what makes "this run is yours" provable here.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Protocol

import httpx

log = logging.getLogger(__name__)

XP_SOURCE = "social"


class RunModuleError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class RunModule(Protocol):
    configured: bool

    def get_xp(self, token: str) -> int | None: ...

    def get_run(self, token: str, run_id: str) -> dict: ...

    def get_xp_board(self, token: str, window: str, limit: int) -> dict | None: ...

    def get_xp_totals(self, service_token: str, subjects: list[str]) -> dict[str, int] | None: ...

    def award_xp(self, service_token: str, subject: str, amount: int, reason: str, idempotency_key: str, *,
                 source_id: str | None = None, metadata: dict | None = None) -> int | None: ...

    def reverse_xp(self, service_token: str, idempotency_key: str, reason: str) -> int | None: ...


TOTALS_BATCH = 200  # the route's limit
TOTALS_TIMEOUT_S = 2.0  # a list waits on this call, so it is short
TOTALS_BACKOFF_S = 30.0  # after a failure, lists use the cached figures without asking for this long


def is_run_module_subject(subject: str) -> bool:
    """The Run Module keys people by UUID and rejects a whole batch over one id that isn't."""
    try:
        uuid.UUID(subject)
    except ValueError:
        return False
    return True


class HttpRunModule:
    def __init__(self, base_url: str | None, timeout_s: float = 4.0):
        self.base_url = base_url
        self.configured = bool(base_url)
        self._client = httpx.Client(base_url=base_url, timeout=timeout_s) if base_url else None
        self._totals_down_until = 0.0

    def _get(self, token: str, path: str) -> dict:
        if not self._client:
            raise RunModuleError(503, "Run Module is not configured.")
        try:
            res = self._client.get(path, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
        except httpx.HTTPError as e:
            raise RunModuleError(502, f"Run Module unreachable: {type(e).__name__}") from None
        if res.status_code >= 400:
            raise RunModuleError(res.status_code, f"Run Module returned {res.status_code}")
        try:
            body = res.json()
        except ValueError:
            raise RunModuleError(502, "Run Module returned invalid JSON") from None
        if not isinstance(body, dict):
            raise RunModuleError(502, "Run Module returned an unexpected body")
        return body

    def get_xp(self, token: str) -> int | None:
        """Best effort: None when unavailable (the cached figure is served instead)."""
        if not self.configured:
            return None
        try:
            xp = self._get(token, "/v1/users/me/xp").get("xp")
        except RunModuleError:
            return None
        return int(xp) if isinstance(xp, (int, float)) and xp >= 0 else None

    def get_run(self, token: str, run_id: str) -> dict:
        # run_id is validated against RUN_ID_RE (URL-safe characters only) before it gets here.
        return self._get(token, f"/v1/runs/{run_id}")

    def get_xp_board(self, token: str, window: str, limit: int) -> dict | None:
        """Best effort: None when unavailable (the board says so)."""
        if not self.configured:
            return None
        try:
            body = self._get(token, f"/v1/leaderboard/xp?window={window}&limit={int(limit)}")
        except RunModuleError:
            return None
        return body if isinstance(body.get("entries"), list) else None

    def get_xp_totals(self, service_token: str, subjects: list[str]) -> dict[str, int] | None:
        """Best effort: other people's XP totals, TOTALS_BATCH at a time; None when unavailable (the
        cached figures are served instead). Only UUID subjects are sent."""
        if not self._client or not service_token or time.monotonic() < self._totals_down_until:
            return None
        wanted = [s for s in dict.fromkeys(subjects) if is_run_module_subject(s)]
        totals: dict[str, int] = {}
        for i in range(0, len(wanted), TOTALS_BATCH):
            try:
                res = self._client.post("/internal/v1/xp/totals", json={"subjects": wanted[i:i + TOTALS_BATCH]},
                                        headers={"Authorization": f"Bearer {service_token}", "Accept": "application/json"},
                                        timeout=TOTALS_TIMEOUT_S)
                body = res.json() if res.status_code == 200 else None
            except (httpx.HTTPError, ValueError):
                body = None
            if not isinstance(body, dict):
                self._totals_down_until = time.monotonic() + TOTALS_BACKOFF_S
                return totals or None
            totals.update({k: int(v) for k, v in body.items() if isinstance(v, (int, float)) and v >= 0})
        return totals

    def _post_service(self, service_token: str, path: str, body: dict) -> tuple[int, object] | None:
        if not self._client or not service_token:
            return None
        try:
            res = self._client.post(path, json=body, headers={"Authorization": f"Bearer {service_token}",
                                                              "Accept": "application/json"})
        except httpx.HTTPError as e:
            log.warning("run module %s unreachable: %s", path, type(e).__name__)
            return None
        try:
            payload = res.json()
        except ValueError:
            payload = None
        return res.status_code, payload

    def award_xp(self, service_token: str, subject: str, amount: int, reason: str, idempotency_key: str, *,
                 source_id: str | None = None, metadata: dict | None = None) -> int | None:
        """The subject's new XP total, or None when the award didn't go through (logged; retry later)."""
        body: dict = {"subject": subject, "amount": int(amount), "reason": reason, "source": XP_SOURCE,
                      "idempotency_key": idempotency_key}
        if source_id:
            body["source_id"] = source_id[:200]
        if metadata:
            body["metadata"] = metadata
        answer = self._post_service(service_token, "/internal/v1/xp/award", body)
        if answer is None:
            return None
        status, payload = answer
        if status == 200 and isinstance(payload, (int, float)) and not isinstance(payload, bool):
            return int(payload)
        log.warning("run module xp award %s answered %s: %s", idempotency_key, status, str(payload)[:200])
        return None

    def reverse_xp(self, service_token: str, idempotency_key: str, reason: str) -> int | None:
        """The new total; -1 when the Run Module has no such award (nothing to reverse); None on failure."""
        answer = self._post_service(service_token, "/internal/v1/xp/reverse",
                                    {"source": XP_SOURCE, "idempotency_key": idempotency_key, "reason": reason[:200]})
        if answer is None:
            return None
        status, payload = answer
        if status == 200 and isinstance(payload, (int, float)) and not isinstance(payload, bool):
            return int(payload)
        if status == 404:
            return -1
        log.warning("run module xp reverse %s answered %s: %s", idempotency_key, status, str(payload)[:200])
        return None
