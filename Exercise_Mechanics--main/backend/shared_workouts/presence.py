"""Who is connected to a shared session: a socket open, or a request within CONNECTED_WINDOW_S.

In-process, like the sockets themselves (Exercise runs one worker). After a restart nobody is known;
the first time a player is looked at they are counted as seen then, so a restart never ends a race.
"""

from __future__ import annotations

import threading
from collections import Counter
from datetime import datetime, timedelta

from backend.shared_workouts.policy import CONNECTED_WINDOW_S, DISCONNECT_AFTER_S

_last_seen: dict[tuple[str, str], datetime] = {}
_sockets: Counter[tuple[str, str]] = Counter()
_lock = threading.Lock()


def touch(session_id: str, user_id: str, now: datetime) -> None:
    with _lock:
        _last_seen[(session_id, user_id)] = now


def socket_opened(session_id: str, user_id: str, now: datetime) -> None:
    with _lock:
        _sockets[(session_id, user_id)] += 1
        _last_seen[(session_id, user_id)] = now


def socket_closed(session_id: str, user_id: str, now: datetime) -> None:
    with _lock:
        key = (session_id, user_id)
        _sockets[key] -= 1
        if _sockets[key] <= 0:
            del _sockets[key]
        _last_seen[key] = now


def connected(session_id: str, user_id: str, now: datetime) -> bool:
    with _lock:
        key = (session_id, user_id)
        if _sockets.get(key):
            return True
        seen = _last_seen.get(key)
    return seen is not None and now - seen <= timedelta(seconds=CONNECTED_WINDOW_S)


def gone(session_id: str, user_id: str, now: datetime) -> bool:
    """No socket and nothing heard for DISCONNECT_AFTER_S."""
    with _lock:
        key = (session_id, user_id)
        if _sockets.get(key):
            return False
        seen = _last_seen.setdefault(key, now)
    return now - seen > timedelta(seconds=DISCONNECT_AFTER_S)


def forget(session_id: str) -> None:
    with _lock:
        for key in [k for k in _last_seen if k[0] == session_id]:
            del _last_seen[key]


def reset() -> None:
    with _lock:
        _last_seen.clear()
        _sockets.clear()
