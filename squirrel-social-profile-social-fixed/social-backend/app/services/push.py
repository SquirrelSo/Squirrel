"""Push delivery through Expo's push service (https://docs.expo.dev/push-notifications/sending-notifications/).

The app registers its Expo push token (POST /v1/me/push-tokens); a notification (services/notify.py)
queues one message per live token on the database session, and they are sent once that session
commits, so a rolled-back request never pushes. Sending happens on a small thread pool: a slow Expo
never slows the request. A token Expo reports as `DeviceNotRegistered` (app uninstalled) is
disabled.

Expo's answer to a send is only a ticket; whether Apple / Google took the message comes in a
receipt, ready about 15 minutes later. Each ticket id is stored (`push_tickets`) and
`check_receipts` fetches the receipts of tickets at least `RECEIPT_DELAY` old: a failed one is
logged with its reason, and a `DeviceNotRegistered` one disables the token. It runs every
`RECEIPT_INTERVAL_S` in `ReceiptLoop` and on POST /internal/v1/tasks/push-receipts (for a cron while
the host sleeps). A ticket whose receipt never comes is dropped after `RECEIPT_GIVE_UP`.
"""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Protocol

import httpx
from sqlalchemy import delete, event, select, update
from sqlalchemy.orm import Session

from app.db import Database, utcnow
from app.models import PushTicket, PushToken

log = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts"
_BATCH = 100  # Expo accepts up to 100 messages per request
_RECEIPT_BATCH = 1000  # and up to 1000 receipt ids
_RECEIPTS_PER_RUN = 10_000
RECEIPT_DELAY = timedelta(minutes=15)
RECEIPT_GIVE_UP = timedelta(hours=24)  # Expo keeps receipts for a day
RECEIPT_INTERVAL_S = 300


class PushSender(Protocol):
    def send(self, messages: list[dict]) -> None: ...


class ExpoPush:
    def __init__(self, database: Database, *, enabled: bool = True, access_token: str | None = None,
                 client: httpx.Client | None = None):
        self.database = database
        self.enabled = enabled
        self._headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if access_token:
            self._headers["Authorization"] = f"Bearer {access_token}"
        self._client = client or httpx.Client(timeout=10.0)
        self._pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="expo-push")

    def send(self, messages: list[dict]) -> None:
        if self.enabled and messages:
            self._pool.submit(self.deliver, list(messages))

    def deliver(self, messages: list[dict]) -> None:
        dead: list[str] = []
        tickets_sent: dict[str, str] = {}
        for start in range(0, len(messages), _BATCH):
            chunk = messages[start:start + _BATCH]
            try:
                res = self._client.post(EXPO_PUSH_URL, json=chunk, headers=self._headers)
                tickets = res.json().get("data", []) if res.status_code < 500 else []
            except (httpx.HTTPError, ValueError) as e:
                log.warning("expo push failed: %s", e)
                continue
            if res.status_code >= 400:
                log.warning("expo push answered %s: %s", res.status_code, res.text[:300])
                continue
            for message, ticket in zip(chunk, tickets if isinstance(tickets, list) else []):
                if not isinstance(ticket, dict):
                    continue
                if ticket.get("status") == "ok" and isinstance(ticket.get("id"), str) and len(ticket["id"]) <= 64:
                    tickets_sent[ticket["id"]] = message["to"]
                    continue
                if ticket.get("status") != "error":
                    continue
                details = ticket.get("details") if isinstance(ticket.get("details"), dict) else {}
                log.warning("expo push rejected: %s (%s) token=%s", details.get("error") or "unknown",
                            str(ticket.get("message", ""))[:200], _short(message["to"]))
                if details.get("error") == "DeviceNotRegistered":
                    dead.append(message["to"])
        if dead or tickets_sent:
            with self.database.SessionLocal() as db:
                if tickets_sent:
                    now = utcnow()
                    db.add_all(PushTicket(id=i, token=t, created_at=now) for i, t in tickets_sent.items())
                _disable(db, dead)
                db.commit()

    def check_receipts(self, now: datetime | None = None) -> int:
        """Read the receipts of tickets at least RECEIPT_DELAY old. Returns how many were read."""
        if not self.enabled:
            return 0
        now = now or utcnow()
        read: list[str] = []
        dead: list[str] = []
        with self.database.SessionLocal() as db:
            db.execute(delete(PushTicket).where(PushTicket.created_at < now - RECEIPT_GIVE_UP))
            due = dict(db.execute(
                select(PushTicket.id, PushTicket.token).where(PushTicket.created_at <= now - RECEIPT_DELAY)
                .order_by(PushTicket.created_at).limit(_RECEIPTS_PER_RUN)
            ).all())
            ids = list(due)
            for start in range(0, len(ids), _RECEIPT_BATCH):
                chunk = ids[start:start + _RECEIPT_BATCH]
                try:
                    res = self._client.post(EXPO_RECEIPTS_URL, json={"ids": chunk}, headers=self._headers)
                    receipts = res.json().get("data") if res.status_code < 400 else None
                except (httpx.HTTPError, ValueError) as e:
                    log.warning("expo receipts failed: %s", e)
                    continue  # kept: the next run asks again
                if not isinstance(receipts, dict):
                    log.warning("expo receipts answered %s: %s", res.status_code, res.text[:300])
                    continue
                for ticket_id in chunk:
                    receipt = receipts.get(ticket_id)
                    if not isinstance(receipt, dict):
                        continue  # not ready yet
                    read.append(ticket_id)
                    if receipt.get("status") != "error":
                        continue
                    details = receipt.get("details") if isinstance(receipt.get("details"), dict) else {}
                    reason = details.get("error") or "unknown"
                    log.warning("expo push receipt %s failed: %s (%s) token=%s", ticket_id, reason,
                                str(receipt.get("message", ""))[:200], _short(due[ticket_id]))
                    if reason == "DeviceNotRegistered":
                        dead.append(due[ticket_id])
            if read:
                db.execute(delete(PushTicket).where(PushTicket.id.in_(read)))
            _disable(db, dead)
            db.commit()
        return len(read)


def _short(token: str) -> str:
    """Enough of a token to find it in the table, not the whole thing in the logs."""
    return token[:26] + "…" if len(token) > 26 else token


def _disable(db: Session, tokens: list[str]) -> None:
    if tokens:
        db.execute(update(PushToken).where(PushToken.token.in_(tokens), PushToken.disabled_at.is_(None))
                   .values(disabled_at=utcnow()))


class ReceiptLoop:
    """Runs `check_receipts` every RECEIPT_INTERVAL_S in a background thread of the service."""

    def __init__(self, sender: ExpoPush):
        self.sender = sender
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="expo-receipts", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.wait(RECEIPT_INTERVAL_S):
            try:
                self.sender.check_receipts()
            except Exception:  # a database or network hiccup must not end the loop
                log.exception("expo receipts failed")


class RecordingPush:
    """Test double: keeps what would have been sent."""

    def __init__(self):
        self.sent: list[dict] = []

    def send(self, messages: list[dict]) -> None:
        self.sent.extend(messages)


# --------------------------------------------------------------------------- session hooks


def attach(db: Session, sender: PushSender | None) -> Session:
    db.info["push"] = sender
    return db


def queue(db: Session, messages: list[dict]) -> None:
    db.info.setdefault("pending_push", []).extend(messages)


@event.listens_for(Session, "after_commit")
def _send_after_commit(session: Session) -> None:
    if session.in_nested_transaction():  # a SAVEPOINT released (badges.after_activity): not committed yet
        return
    messages = session.info.pop("pending_push", None)
    sender = session.info.get("push")
    if messages and sender is not None:
        try:
            sender.send(messages)
        except Exception:  # never fail a committed request over a push
            log.exception("queueing push failed")


@event.listens_for(Session, "after_rollback")
def _drop_after_rollback(session: Session) -> None:
    session.info.pop("pending_push", None)
