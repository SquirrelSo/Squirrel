"""Blocks, asked of the Social service, which owns them (ADR-032). Partner Hunt and activity matching
keep no block list of their own: a person blocked with the app's Block button is never suggested here.

    GET  {SOCIAL_API_URL}/internal/v1/blocks/{sub}   everyone blocked EITHER way with that person
    POST {SOCIAL_API_URL}/internal/v1/blocks/import  create a block (idempotent; removes follows)

Both carry the service token SOCIAL_INTERNAL_TOKEN, the same two settings as social_publish.py.
Exercise user ids are the login `sub`, so they are sent as they are.

Failure policy: fail closed. An answer is cached for at most CACHE_TTL_S and never used after that.
Social unreachable, a timeout, any non-2xx (a 404 included: Social answers 200 with an empty list for
a person it has not seen, so a 404 means the route is missing or the token is unset there), a
malformed answer, or the two settings missing — all raise BlocksUnreachable, and the caller withholds
the list or refuses the action. Fewer people shown, never a blocked person shown.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from backend import social_publish

log = logging.getLogger(__name__)

BLOCKS_PATH = "/internal/v1/blocks/{sub}"
IMPORT_PATH = "/internal/v1/blocks/import"

TIMEOUT_S = 3        # a board or a block waits on this call, so it is short
CACHE_TTL_S = 30     # ADR-032: at most 30 seconds, no stale fallback
_MAX_CACHED = 5000   # expired answers are dropped once the cache grows past this

# Seams for tests: the HTTP opener and the clock.
_urlopen = urllib.request.urlopen
_clock = time.monotonic

_cache: dict[str, tuple[float, frozenset[str]]] = {}
_lock = threading.Lock()


class BlocksUnreachable(RuntimeError):
    """Social could not be asked, or did not answer usably. Never read as "blocks nobody"."""


def blocked_either_way(sub: str) -> frozenset[str]:
    """Everyone `sub` blocked or was blocked by. One call covers both directions, so a board needs
    only the viewer's set. Raises BlocksUnreachable when there is no answer younger than CACHE_TTL_S."""
    now = _clock()
    with _lock:
        cached = _cache.get(sub)
    if cached is not None and now - cached[0] < CACHE_TTL_S:
        return cached[1]
    body = _call("GET", BLOCKS_PATH.format(sub=urllib.parse.quote(sub, safe="")))
    # A malformed answer is no answer: reading it as "no blocks" would hide that the two sides disagree.
    if not (isinstance(body, dict) and body.get("subject") == sub and isinstance(body.get("blocked"), list)
            and all(isinstance(item, str) for item in body["blocked"])):
        raise BlocksUnreachable("Social answered the block lookup in an unexpected shape")
    answer = frozenset(body["blocked"]) - {sub}
    with _lock:
        if len(_cache) >= _MAX_CACHED:
            for key in [k for k, (at, _) in _cache.items() if now - at >= CACHE_TTL_S]:
                del _cache[key]
        _cache[sub] = (now, answer)
    return answer


def block(blocker: str, blocked: str) -> None:
    """Block `blocked` for `blocker` in Social, exactly as the app's Block button does. Safe to repeat.
    Raises BlocksUnreachable when Social did not confirm it; nothing is kept here either way."""
    body = _call("POST", IMPORT_PATH, {"blocks": [{"blocker": blocker, "blocked": blocked}]})
    if not isinstance(body, dict) or not any(body.get(key) == 1 for key in ("imported", "already")):
        raise BlocksUnreachable("Social did not confirm the block")
    forget(blocker, blocked)


def forget(*subs: str) -> None:
    """Drop cached answers, so a block made here applies to both people on their next request."""
    with _lock:
        for sub in subs:
            _cache.pop(sub, None)


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def _call(method: str, path: str, payload: dict | None = None) -> object:
    target = social_publish.configured()
    if target is None:
        log.error("blocks cannot be checked: SOCIAL_API_URL and SOCIAL_INTERNAL_TOKEN must both be set; "
                  "Partner Hunt and activity matching stay closed until they are")
        raise BlocksUnreachable("Social is not configured")
    url, token = target
    request = urllib.request.Request(
        url + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json",
                 **({"Content-Type": "application/json"} if payload is not None else {})},
    )
    try:
        with _urlopen(request, timeout=TIMEOUT_S) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        log.warning("Social refused a block %s: HTTP %s", "lookup" if method == "GET" else "write", exc.code)
        raise BlocksUnreachable(f"Social answered HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        log.warning("Social blocks unreachable: %s", exc)
        raise BlocksUnreachable("Social is unreachable") from exc
    except (ValueError, UnicodeDecodeError) as exc:
        raise BlocksUnreachable("Social returned invalid JSON") from exc
