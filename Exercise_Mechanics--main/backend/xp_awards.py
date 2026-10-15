"""XP awards, reported to the Run Module, which owns the only XP ledger (ADR-032; contract §1):

    POST {RUN_MODULE_URL}/internal/v1/xp/award
         { subject, amount, reason, source: "exercise", idempotency_key, source_id?, metadata? }
    → 200 the subject's new total (a bare integer); a replay with the same key is the same 200.

Exercise awards two things, each a flat amount decided by the product owner (ADR-033):

    shared_workout_finished  20 XP to each player who finished a shared race (did not leave before
                             the end, reported at least one rep). Never per rep. The Run Module caps
                             it at 3 a day.          idempotency_key shared:{session_id}:{subject}
    buddy_connected          20 XP to each person when a Partner Hunt connection is accepted, once per
                             pair per person.        idempotency_key buddy:{min(a,b)}:{max(a,b)}:{subject}

The call carries the same short-lived service token as the XP gate (auth.tokens.issue_service_token,
`sub: exercise_module`), or a fixed RUN_MODULE_TOKEN if one is set. Fire-and-forget on a daemon
thread, after the caller has saved its own change: a failure is logged and never fails the action,
and the idempotency key makes a later replay harmless. Without RUN_MODULE_URL nothing is sent.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import urllib.error
import urllib.request
from collections.abc import Callable

from backend.auth.tokens import issue_service_token
from backend.partners.xp_gate import RUN_MODULE_TOKEN_ENV, RUN_MODULE_URL_ENV, _PRIVATE_HOSTPORT

log = logging.getLogger(__name__)

AWARD_PATH = "/internal/v1/xp/award"
SOURCE = "exercise"
TIMEOUT_S = 10

SHARED_WORKOUT_FINISHED = "shared_workout_finished"
BUDDY_CONNECTED = "buddy_connected"
AMOUNTS = {SHARED_WORKOUT_FINISHED: 20, BUDDY_CONNECTED: 20}

# Seams for tests: the HTTP opener, and how the send is run (a daemon thread).
_urlopen = urllib.request.urlopen


def _in_background(send: Callable[[], None]) -> None:
    threading.Thread(target=send, name="xp-award", daemon=True).start()


def shared_workout_key(session_id: str, subject: str) -> str:
    return f"shared:{session_id}:{subject}"


def buddy_key(a: str, b: str, subject: str) -> str:
    low, high = sorted((a, b))
    return f"buddy:{low}:{high}:{subject}"


def run_module_url() -> str | None:
    url = os.environ.get(RUN_MODULE_URL_ENV, "").strip()
    if _PRIVATE_HOSTPORT.fullmatch(url):
        url = "http://" + url
    return url.rstrip("/") or None


def award(*, subject: str, reason: str, idempotency_key: str, source_id: str | None = None,
          metadata: dict | None = None) -> None:
    """Report one award. Returns at once; the call runs in the background."""
    base = run_module_url()
    if base is None:
        log.debug("XP award %s for %s not sent: %s is not set", reason, idempotency_key, RUN_MODULE_URL_ENV)
        return
    payload: dict = {"subject": subject, "amount": AMOUNTS[reason], "reason": reason, "source": SOURCE,
                     "idempotency_key": idempotency_key}
    if source_id is not None:
        payload["source_id"] = source_id
    if metadata:
        payload["metadata"] = metadata

    def send() -> None:
        try:
            token = os.environ.get(RUN_MODULE_TOKEN_ENV) or issue_service_token()
            request = urllib.request.Request(
                base + AWARD_PATH, data=json.dumps(payload).encode(), method="POST",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                         "Accept": "application/json"},
            )
            with _urlopen(request, timeout=TIMEOUT_S) as response:
                response.read()
        except urllib.error.HTTPError as exc:
            log.warning("Run Module refused XP award %s (%s): HTTP %s", reason, idempotency_key, exc.code)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            log.warning("XP award %s (%s) not sent, Run Module unreachable: %s", reason, idempotency_key, exc)
        except Exception:  # noqa: BLE001 — a background award must never raise anywhere
            log.exception("XP award %s (%s) failed", reason, idempotency_key)

    _in_background(send)
