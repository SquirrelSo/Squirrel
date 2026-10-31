"""Client for the Run Module's XP gate.

The Run Module owns XP. It derives XP from the shared ``activity_sessions`` table and exposes two
calls (integration contract, section 7):

    meetsXPGate(userId, minXP) -> true | false
    getUserXP(userId)          -> { xp, updatedAt }     xp is 0 for a new user, never null

Partner Hunt only ever calls them; it never computes XP itself.

Failure policy. Every failure closes the gate — nobody gets into Partner Hunt on an XP read that did
not happen. But "the XP service could not be reached" and "you have not earned enough XP yet" are
reported as different things (``XPServiceUnavailable`` versus a clean ``False``), because they ask the
user for different things: the first is not theirs to fix, the second is. Collapsing them would tell a
runner with 400 XP to go and earn more.

A malformed reply counts as unavailable, not as zero. The contract promises ``xp`` is never null; a
null or a string there means something upstream is wrong, and quietly treating it as 0 XP would hide
that behind an ordinary-looking "locked" state.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Protocol

from backend.auth.tokens import issue_service_token

log = logging.getLogger(__name__)

RUN_MODULE_URL_ENV = "RUN_MODULE_URL"
RUN_MODULE_TOKEN_ENV = "RUN_MODULE_TOKEN"
DEV_XP_ENV = "PARTNER_HUNT_DEV_XP"

# HTTP routes on the Run Module (its ADR-027). Service-only: Partner Hunt asks about OTHER users (a
# candidate who has not cleared the gate must not appear on anyone's board), which a user's token
# cannot do. Each call carries a short-lived service token this backend signs (auth.tokens).
GATE_PATH = "/v1/users/{user_id}/xp-gate"
XP_PATH = "/v1/users/{user_id}/xp"

DEFAULT_TIMEOUT_S = 2.0


class XPServiceUnavailable(RuntimeError):
    """The XP gate could not be consulted: unreachable, unconfigured, or it answered nonsense."""


@dataclass(frozen=True)
class XPStatus:
    xp: int
    updated_at: str | None


class XPGate(Protocol):
    def meets_xp_gate(self, user_id: str, min_xp: int) -> bool: ...

    def get_user_xp(self, user_id: str) -> XPStatus: ...


class RunModuleXPGate:
    """The real gate: the Run Module over HTTP."""

    def __init__(
        self,
        base_url: str,
        *,
        token: str | Callable[[], str] | None = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        opener: Callable[..., object] = urllib.request.urlopen,
    ) -> None:
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError(f"{RUN_MODULE_URL_ENV} must be an http(s) URL, got {base_url!r}")
        self._base = base_url.rstrip("/")
        self._token = token
        self._timeout_s = timeout_s
        self._open = opener

    def meets_xp_gate(self, user_id: str, min_xp: int) -> bool:
        query = urllib.parse.urlencode({"minXP": min_xp})
        body = self._get(GATE_PATH.format(user_id=_quote(user_id)) + f"?{query}")
        # The contract's return is `true | false`. Only a real JSON boolean is accepted: a 1, a "true"
        # or an object would mean the two sides disagree about the shape, which must surface.
        if not isinstance(body, bool):
            raise XPServiceUnavailable("XP gate returned a non-boolean answer")
        return body

    def get_user_xp(self, user_id: str) -> XPStatus:
        body = self._get(XP_PATH.format(user_id=_quote(user_id)))
        if not isinstance(body, dict):
            raise XPServiceUnavailable("XP lookup returned a non-object answer")
        return _parse_xp_status(body.get("xp"), body.get("updatedAt"))

    def _get(self, path: str) -> object:
        headers = {"Accept": "application/json"}
        token = self._token() if callable(self._token) else self._token
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(self._base + path, headers=headers, method="GET")
        try:
            with self._open(request, timeout=self._timeout_s) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise XPServiceUnavailable(f"XP service answered HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise XPServiceUnavailable("XP service is unreachable") from exc
        except (ValueError, UnicodeDecodeError) as exc:
            raise XPServiceUnavailable("XP service returned invalid JSON") from exc


class FixedXPGate:
    """A stand-in with fixed XP values. For tests, and for local development without a Run Module.

    It applies the obvious rule (``xp >= min_xp``); the real gate is the Run Module's, which may
    grow further conditions. Never the production gate.
    """

    def __init__(
        self,
        xp_by_user: Mapping[str, int] | None = None,
        *,
        default_xp: int = 0,
        updated_at: str | None = None,
    ) -> None:
        self._xp = dict(xp_by_user or {})
        self._default = default_xp
        self._updated_at = updated_at

    def meets_xp_gate(self, user_id: str, min_xp: int) -> bool:
        return self.get_user_xp(user_id).xp >= min_xp

    def get_user_xp(self, user_id: str) -> XPStatus:
        return XPStatus(self._xp.get(user_id, self._default), self._updated_at)


class UnconfiguredXPGate:
    """No XP source is configured. Every call fails as unavailable, so the gate stays shut."""

    def meets_xp_gate(self, user_id: str, min_xp: int) -> bool:
        raise XPServiceUnavailable(f"{RUN_MODULE_URL_ENV} is not configured")

    def get_user_xp(self, user_id: str) -> XPStatus:
        raise XPServiceUnavailable(f"{RUN_MODULE_URL_ENV} is not configured")


_PRIVATE_HOSTPORT = re.compile(r"[A-Za-z0-9.-]+:[0-9]{1,5}")


def xp_gate_from_env(env: Mapping[str, str] = os.environ) -> XPGate:
    """Pick the gate from the environment.

    RUN_MODULE_URL set        → the real Run Module, with a fresh service token per call (or a fixed
                                RUN_MODULE_TOKEN, if set). A bare "host:port" means http:// on a
                                private network.
    else PARTNER_HUNT_DEV_XP  → every user has that much XP. Local development only; logged loudly.
    else                      → unconfigured: Partner Hunt stays locked and says why.
    """
    url = env.get(RUN_MODULE_URL_ENV, "").strip()
    if _PRIVATE_HOSTPORT.fullmatch(url):
        url = "http://" + url  # a host's private-network "host:port" (e.g. Render's hostport)
    if url:
        return RunModuleXPGate(url, token=env.get(RUN_MODULE_TOKEN_ENV) or issue_service_token)
    dev_xp = env.get(DEV_XP_ENV, "").strip()
    if dev_xp:
        try:
            value = int(dev_xp)
        except ValueError as exc:
            raise ValueError(f"{DEV_XP_ENV} must be a whole number, got {dev_xp!r}") from exc
        if value < 0:
            raise ValueError(f"{DEV_XP_ENV} cannot be negative")
        log.warning(
            "Partner Hunt is using a FAKE XP gate: every user has %d XP (%s). Never set this in "
            "production — set %s to the Run Module instead.",
            value, DEV_XP_ENV, RUN_MODULE_URL_ENV,
        )
        return FixedXPGate(default_xp=value)
    return UnconfiguredXPGate()


def _parse_xp_status(xp: object, updated_at: object) -> XPStatus:
    # bool is an int subclass in Python; `True` XP is a shape error, not 1 XP.
    if isinstance(xp, bool) or not isinstance(xp, int) or xp < 0:
        raise XPServiceUnavailable("XP lookup returned an invalid xp value")
    if updated_at is not None and not isinstance(updated_at, str):
        raise XPServiceUnavailable("XP lookup returned an invalid updatedAt value")
    return XPStatus(xp, updated_at)


def _quote(user_id: str) -> str:
    return urllib.parse.quote(user_id, safe="")
