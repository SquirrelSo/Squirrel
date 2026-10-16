"""How many people are training right now: open /ws/train connections, counted per person.

In-process, like the sockets themselves (one worker serves them). Read by GET /api/live for the
app's live counter; counts only, no names.
"""

from __future__ import annotations

import threading
from collections import Counter
from contextlib import contextmanager
from collections.abc import Iterator

_open: Counter[str] = Counter()
_lock = threading.Lock()


@contextmanager
def training(user_id: str) -> Iterator[None]:
    with _lock:
        _open[user_id] += 1
    try:
        yield
    finally:
        with _lock:
            _open[user_id] -= 1
            if _open[user_id] <= 0:
                del _open[user_id]


def working_out_now() -> int:
    with _lock:
        return len(_open)
