"""In-memory proximity engine: rotating BLE ids, sightings, nearby relationships, notification outbox.

Everything here is ephemeral by design. Ids stop resolving shortly after their window, sightings are
dropped once they can no longer affect a relationship, relationships expire RELATIONSHIP_TTL after
the last qualifying sighting, and notification cooldowns vanish when they lapse. A restart forgets
all of it; phones simply open a new device session.

The engine assumes a single process (the Dockerfile runs one uvicorn worker). Scaling out means
moving this state to a shared TTL store (e.g. Redis) behind the same methods.
"""

from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Iterable

from backend.nearby import protocol as P
from backend.nearby import proximity as X
from backend.nearby import store
from backend.nearby.notifications import (
    CTA,
    NEARBY_DEEP_LINK,
    PAIR_NOTIFY_COOLDOWN_SECONDS,
    USER_NOTIFY_COOLDOWN_SECONDS,
    LogPushSender,
    PushSender,
    nearby_copy,
)

MAX_SESSIONS_PER_USER    = 3                # phones/tablets; the oldest session is evicted beyond this
NOTIFICATION_TTL_SECONDS = 30 * 60          # an undelivered nearby notification goes stale
_PURGE_INTERVAL_SECONDS  = 10


class SessionError(Exception):
    """The device session is unknown, expired, or belongs to someone else."""


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


@dataclass
class DeviceSession:
    session_id: str
    user_id: str
    platform: str
    created_at: float
    expires_at: float
    windows: dict[int, str] = field(default_factory=dict)   # rotation window index → ble id hex


@dataclass(frozen=True)
class BleIdEntry:
    ble_id: str
    user_id: str
    session_id: str
    valid_from: float
    valid_until: float


@dataclass
class Relationship:
    nearby_id: str
    user_a: str
    user_b: str
    proximity: X.Proximity
    confidence: float
    mutual: bool
    first_detected: float
    last_detected: float
    expires_at: float

    def other(self, user_id: str) -> str:
        return self.user_b if user_id == self.user_a else self.user_a

    def involves(self, user_id: str) -> bool:
        return user_id in (self.user_a, self.user_b)


@dataclass(frozen=True)
class Detection:
    ble_id: str      # lowercase hex
    at: float        # epoch seconds, observer clock
    rssi: int


def _pair(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a < b else (b, a)


class ProximityEngine:
    def __init__(
        self,
        *,
        is_enabled: Callable[[str], bool] = store.is_enabled,
        push: PushSender | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._is_enabled = is_enabled
        self._push = push or LogPushSender()
        self._clock = clock
        self._lock = threading.RLock()
        self._sessions: dict[str, DeviceSession] = {}
        self._ble_ids: dict[str, BleIdEntry] = {}
        self._evidence: dict[tuple[str, str], list[X.Sample]] = {}
        self._relationships: dict[str, Relationship] = {}
        self._pair_rel: dict[tuple[str, str], str] = {}
        self._outbox: dict[str, dict] = {}
        self._outbox_expiry: dict[str, float] = {}
        self._pair_notified: dict[tuple[str, str], float] = {}   # (recipient, other) → cooldown end
        self._user_notified: dict[str, float] = {}               # recipient → cooldown end
        self._last_purge = 0.0

    # ------------------------------------------------------------------ sessions / rotating ids

    def open_session(self, user_id: str, platform: str, session_id: str | None = None) -> dict:
        """Create (or extend) a device session and pre-issue rotating BLE ids for it."""
        now = self._clock()
        with self._lock:
            self._purge(now)
            session = self._sessions.get(session_id or "")
            if session is None or session.user_id != user_id or session.expires_at <= now:
                session = self._new_session(user_id, platform, now)
            session.expires_at = now + P.SESSION_TTL_SECONDS

            current = int(now // P.ROTATION_SECONDS)
            for window in range(current, current + P.IDS_PER_ISSUE):
                if window not in session.windows:
                    ble_id = secrets.token_bytes(P.BLE_ID_BYTES).hex()
                    start = window * P.ROTATION_SECONDS
                    self._ble_ids[ble_id] = BleIdEntry(
                        ble_id, user_id, session.session_id, start, start + P.ROTATION_SECONDS)
                    session.windows[window] = ble_id

            ids = [self._ble_ids[session.windows[w]] for w in sorted(session.windows) if w >= current]
            return {
                "device_session": session.session_id,
                "expires_at": iso(session.expires_at),
                "service_uuid": P.SERVICE_UUID,
                "characteristic_uuid": P.BLE_ID_CHARACTERISTIC_UUID,
                "payload_version": P.PAYLOAD_VERSION,
                "rotation_seconds": P.ROTATION_SECONDS,
                "ble_ids": [
                    {"ble_id": e.ble_id, "valid_from": iso(e.valid_from), "valid_until": iso(e.valid_until)}
                    for e in ids
                ],
            }

    def _new_session(self, user_id: str, platform: str, now: float) -> DeviceSession:
        mine = sorted((s for s in self._sessions.values() if s.user_id == user_id), key=lambda s: s.created_at)
        for old in mine[: max(0, len(mine) - MAX_SESSIONS_PER_USER + 1)]:
            self._drop_session(old)
        session = DeviceSession(secrets.token_urlsafe(18), user_id, platform, now, now + P.SESSION_TTL_SECONDS)
        self._sessions[session.session_id] = session
        return session

    def _drop_session(self, session: DeviceSession) -> None:
        for ble_id in session.windows.values():
            self._ble_ids.pop(ble_id, None)
        self._sessions.pop(session.session_id, None)

    def _require_session(self, user_id: str, session_id: str, now: float) -> DeviceSession:
        session = self._sessions.get(session_id)
        if session is None or session.user_id != user_id or session.expires_at <= now:
            raise SessionError(session_id)
        return session

    def _resolve(self, ble_id: str, at: float) -> BleIdEntry | None:
        entry = self._ble_ids.get(ble_id)
        if entry is None:
            return None
        if not (entry.valid_from - P.CLOCK_SKEW_SECONDS <= at <= entry.valid_until + P.CLOCK_SKEW_SECONDS):
            return None
        return entry

    # ------------------------------------------------------------------ sightings

    def ingest(self, user_id: str, session_id: str, detections: Iterable[Detection]) -> dict:
        """Record sightings made by `user_id`'s phone; confirm and refresh relationships."""
        now = self._clock()
        ignored: dict[str, int] = {}
        accepted = 0
        touched: set[tuple[str, str]] = set()

        def ignore(reason: str) -> None:
            ignored[reason] = ignored.get(reason, 0) + 1

        with self._lock:
            self._purge(now)
            self._require_session(user_id, session_id, now)
            enabled_cache: dict[str, bool] = {}
            for det in detections:
                if det.at > now + P.CLOCK_SKEW_SECONDS:
                    ignore("future")
                    continue
                at = min(det.at, now)
                if at < now - P.MAX_DETECTION_AGE_SECONDS:
                    ignore("stale")
                    continue
                entry = self._resolve(det.ble_id, at)
                if entry is not None and entry.user_id == user_id:
                    ignore("self")
                    continue
                if entry is not None and entry.user_id not in enabled_cache:
                    enabled_cache[entry.user_id] = self._is_enabled(entry.user_id)
                if entry is None or not enabled_cache[entry.user_id]:
                    ignore("unknown")   # unknown, expired, replayed outside its window, or opted out
                    continue
                pair = _pair(user_id, entry.user_id)
                samples = self._evidence.setdefault(pair, [])
                if any(s.observer == user_id and abs(s.at - at) < X.MIN_SAMPLE_SPACING_SEC for s in samples):
                    ignore("duplicate")
                    continue
                samples.append(X.Sample(at=at, rssi=det.rssi, observer=user_id))
                accepted += 1
                touched.add(pair)

            newly_confirmed = sum(1 for pair in touched if self._update_pair(pair, now))
            return {"accepted": accepted, "ignored": ignored, "newly_confirmed": newly_confirmed}

    def _update_pair(self, pair: tuple[str, str], now: float) -> bool:
        """Re-score a pair. Returns True when this creates a new nearby relationship."""
        recent = X.window(self._evidence.get(pair, []))[-X.MAX_SAMPLES_PER_PAIR:]
        self._evidence[pair] = recent
        assessment = X.assess(recent)
        if assessment is None:
            return False

        rel = self._active_relationship(pair, now)
        if rel is not None:
            rel.confidence = assessment.confidence
            rel.mutual = rel.mutual or assessment.mutual
            if assessment.proximity != "far":   # a weak median means they drifted apart: let it lapse
                rel.proximity = assessment.proximity
                rel.last_detected = max(rel.last_detected, assessment.last_at)
                rel.expires_at = rel.last_detected + X.RELATIONSHIP_TTL_SECONDS
            return False

        if not assessment.confirmed or assessment.last_at + X.RELATIONSHIP_TTL_SECONDS <= now:
            return False
        rel = Relationship(
            nearby_id=secrets.token_urlsafe(12),
            user_a=pair[0],
            user_b=pair[1],
            proximity=assessment.proximity,
            confidence=assessment.confidence,
            mutual=assessment.mutual,
            first_detected=assessment.first_at,
            last_detected=assessment.last_at,
            expires_at=assessment.last_at + X.RELATIONSHIP_TTL_SECONDS,
        )
        self._relationships[rel.nearby_id] = rel
        self._pair_rel[pair] = rel.nearby_id
        self._maybe_notify(pair[0], pair[1], now)
        self._maybe_notify(pair[1], pair[0], now)
        return True

    def _active_relationship(self, pair: tuple[str, str], now: float) -> Relationship | None:
        rel = self._relationships.get(self._pair_rel.get(pair, ""))
        if rel is None:
            return None
        if rel.expires_at <= now:
            self._drop_relationship(rel)
            return None
        return rel

    def _drop_relationship(self, rel: Relationship) -> None:
        self._relationships.pop(rel.nearby_id, None)
        self._pair_rel.pop(_pair(rel.user_a, rel.user_b), None)

    def confirm(self, user_id: str, session_id: str, ble_id: str) -> dict:
        """Where does the caller stand with the owner of `ble_id`? Never reveals who that is."""
        now = self._clock()
        with self._lock:
            self._purge(now)
            self._require_session(user_id, session_id, now)
            entry = self._resolve(ble_id, now)
            if entry is None or entry.user_id == user_id or not self._is_enabled(entry.user_id):
                return {"status": "unknown"}
            pair = _pair(user_id, entry.user_id)
            rel = self._active_relationship(pair, now)
            if rel is not None:
                return {"status": "confirmed", "nearby_id": rel.nearby_id, "proximity": rel.proximity,
                        "confidence": rel.confidence, "expires_at": iso(rel.expires_at)}
            assessment = X.assess(self._evidence.get(pair, []))
            return {
                "status": "pending",
                "detections": assessment.count if assessment else 0,
                "required_detections": X.MIN_DETECTIONS,
                "required_dwell_seconds": X.MIN_DWELL_SECONDS,
            }

    # ------------------------------------------------------------------ nearby list

    def nearby_for(self, user_id: str) -> list[Relationship]:
        now = self._clock()
        with self._lock:
            self._purge(now)
            rels = [r for r in self._relationships.values() if r.involves(user_id) and r.expires_at > now]
        order = {"very_close": 0, "nearby": 1, "far": 2}
        return sorted(rels, key=lambda r: (order[r.proximity], -r.last_detected))

    def relationship(self, nearby_id: str, user_id: str) -> Relationship | None:
        now = self._clock()
        with self._lock:
            rel = self._relationships.get(nearby_id)
            if rel is None or not rel.involves(user_id) or rel.expires_at <= now:
                return None
            return rel

    # ------------------------------------------------------------------ notifications

    def _maybe_notify(self, recipient: str, other: str, now: float) -> None:
        if not self._is_enabled(recipient):
            return
        if self._pair_notified.get((recipient, other), 0) > now or self._user_notified.get(recipient, 0) > now:
            return
        count = sum(1 for r in self._relationships.values() if r.involves(recipient) and r.expires_at > now)
        notification = {
            "id": secrets.token_urlsafe(9),
            "type": "nearby",
            **nearby_copy(count),
            "cta": CTA,
            "deep_link": NEARBY_DEEP_LINK,
            "nearby_count": count,
            "created_at": iso(now),
        }
        self._outbox[recipient] = notification        # coalesce: one pending nearby notification
        self._outbox_expiry[recipient] = now + NOTIFICATION_TTL_SECONDS
        self._pair_notified[(recipient, other)] = now + PAIR_NOTIFY_COOLDOWN_SECONDS
        self._user_notified[recipient] = now + USER_NOTIFY_COOLDOWN_SECONDS
        self._push.send(recipient, notification)

    def drain_notifications(self, user_id: str) -> list[dict]:
        now = self._clock()
        with self._lock:
            self._purge(now)
            expiry = self._outbox_expiry.pop(user_id, 0)
            notification = self._outbox.pop(user_id, None)
            if notification is None or expiry <= now or not self._is_enabled(user_id):
                return []
            return [notification]

    # ------------------------------------------------------------------ opt-out / housekeeping

    def forget_user(self, user_id: str) -> None:
        """Nearby Discovery turned OFF: revoke ids and erase every trace involving this user."""
        with self._lock:
            for session in [s for s in self._sessions.values() if s.user_id == user_id]:
                self._drop_session(session)
            for pair in [p for p in self._evidence if user_id in p]:
                del self._evidence[pair]
            for rel in [r for r in self._relationships.values() if r.involves(user_id)]:
                self._drop_relationship(rel)
            for key in [k for k in self._pair_notified if user_id in k]:
                del self._pair_notified[key]
            self._user_notified.pop(user_id, None)
            self._outbox.pop(user_id, None)
            self._outbox_expiry.pop(user_id, None)

    def _purge(self, now: float) -> None:
        if now - self._last_purge < _PURGE_INTERVAL_SECONDS:
            return
        self._last_purge = now
        for session in [s for s in self._sessions.values() if s.expires_at <= now]:
            self._drop_session(session)
        horizon = now - P.MAX_DETECTION_AGE_SECONDS - P.CLOCK_SKEW_SECONDS
        for entry in [e for e in self._ble_ids.values() if e.valid_until < horizon]:
            self._ble_ids.pop(entry.ble_id, None)
            session = self._sessions.get(entry.session_id)
            if session is not None:
                session.windows = {w: b for w, b in session.windows.items() if b != entry.ble_id}
        for pair in [p for p, s in self._evidence.items() if not s or max(x.at for x in s) < horizon]:
            del self._evidence[pair]
        for rel in [r for r in self._relationships.values() if r.expires_at <= now]:
            self._drop_relationship(rel)
        for key in [k for k, until in self._pair_notified.items() if until <= now]:
            del self._pair_notified[key]
        for key in [k for k, until in self._user_notified.items() if until <= now]:
            del self._user_notified[key]
        for key in [k for k, until in self._outbox_expiry.items() if until <= now]:
            self._outbox_expiry.pop(key, None)
            self._outbox.pop(key, None)

    def stats(self) -> dict:
        """Counts only — used by tests and health checks; never exposes ids or pairs."""
        with self._lock:
            return {"sessions": len(self._sessions), "ble_ids": len(self._ble_ids),
                    "pairs": len(self._evidence), "relationships": len(self._relationships)}


engine = ProximityEngine()


def get_engine() -> ProximityEngine:
    return engine
