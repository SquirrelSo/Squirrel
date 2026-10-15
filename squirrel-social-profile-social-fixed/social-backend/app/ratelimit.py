"""Per-user sliding-window rate limits on writes. 429 responses carry Retry-After, which the
app's `withRetry` already honours.

In-process by design: the service runs one worker per container (same as the Exercise
backend's Dockerfile). Running several workers or replicas multiplies the effective limit; move
the window to Redis before scaling out.
"""

from __future__ import annotations

import math
import threading
import time
from collections import defaultdict, deque

from app.errors import ApiError

# action → (max events, window seconds)
LIMITS: dict[str, tuple[int, int]] = {
    "post:create": (10, 60),
    "post:create:day": (100, 86_400),
    "comment:create": (30, 60),
    "like": (120, 60),
    "save": (120, 60),
    "follow": (60, 60),
    "profile:update": (20, 60),
    "username:check": (60, 60),
    "media:create": (20, 60),
    "referral:claim": (10, 3600),
    "crew:create": (5, 3600),
    "crew:join": (30, 60),
    "vouch": (60, 60),
    "event:create": (10, 3600),
    "rsvp": (60, 60),
    "checkin": (20, 3600),
    "challenge:create": (20, 86_400),
    "push:register": (20, 60),
    "dates:settings": (20, 3600),
    "dates:dismiss": (60, 3600),
    "block": (30, 3600),
    "ambassador": (3, 86400),
    "ambassador:submit": (10, 3600),
    "ambassador:admin": (120, 60),
    "announcement": (5, 3600),
    "notifications:prefs": (30, 60),
}


class RateLimiter:
    def __init__(self, limits: dict[str, tuple[int, int]] | None = None, enabled: bool = True):
        self.limits = dict(limits or LIMITS)
        self.enabled = enabled
        self._events: dict[tuple[str, str], deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, action: str, subject: str) -> None:
        if not self.enabled or action not in self.limits:
            return
        limit, window = self.limits[action]
        now = time.monotonic()
        with self._lock:
            q = self._events[(action, subject)]
            while q and q[0] <= now - window:
                q.popleft()
            if len(q) >= limit:
                retry = max(1, math.ceil(q[0] + window - now))
                raise ApiError(429, "rate_limited", "Slow down a little and try again shortly.", {"Retry-After": str(retry)})
            q.append(now)

    def reset(self) -> None:
        with self._lock:
            self._events.clear()
