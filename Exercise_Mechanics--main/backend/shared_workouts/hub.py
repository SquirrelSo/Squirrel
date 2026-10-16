"""The per-session socket fan-out: who is listening to which session, and delivering to them.

Routes run on worker threads and sockets on the event loop, so each listener has its own queue on
its own loop and messages are handed over with call_soon_threadsafe. In-process: Exercise runs one
worker. A message is built per listener, because each one says who `you` are.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from dataclasses import dataclass, field

CLOSE = "_close"   # a queue item {CLOSE: code} tells the socket to close after what came before it


@dataclass(eq=False)
class Listener:
    session_id: str
    user_id: str
    loop: asyncio.AbstractEventLoop
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)

    def put(self, item: dict) -> None:
        self.loop.call_soon_threadsafe(self.queue.put_nowait, item)


_listeners: dict[str, set[Listener]] = {}
_lock = threading.Lock()


def add(listener: Listener) -> None:
    with _lock:
        _listeners.setdefault(listener.session_id, set()).add(listener)


def remove(listener: Listener) -> None:
    with _lock:
        group = _listeners.get(listener.session_id)
        if group is not None:
            group.discard(listener)
            if not group:
                del _listeners[listener.session_id]


def sessions() -> list[str]:
    with _lock:
        return list(_listeners)


def listeners(session_id: str) -> list[Listener]:
    with _lock:
        return list(_listeners.get(session_id, ()))


def publish(session_id: str, build: Callable[[str], list[dict]]) -> None:
    """Send each listener of the session the messages `build(their user id)` returns."""
    for listener in listeners(session_id):
        for item in build(listener.user_id):
            listener.put(item)


def reset() -> None:
    with _lock:
        _listeners.clear()
