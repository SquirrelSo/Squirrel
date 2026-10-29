"""Event reminders: everyone going hears about an event `event_reminder_minutes` before it starts.

`send_due` claims each due event with one UPDATE … WHERE reminder_sent_at IS NULL, so however many
instances or callers run it, an event is reminded once. It runs every minute in a background
thread of the service (`ReminderLoop`) and on POST /internal/v1/tasks/event-reminders, for a cron
when the host puts the service to sleep (Render's free plan does, after 15 idle minutes).
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import Database, utcnow
from app.models import Event, EventRsvp
from app.services import community, push
from app.services import notify as notifications

log = logging.getLogger(__name__)

INTERVAL_S = 60


def send_due(db: Session, settings: Settings, now: datetime | None = None) -> int:
    now = now or utcnow()
    horizon = now + timedelta(minutes=settings.event_reminder_minutes)
    due = db.scalars(select(Event.id).where(
        Event.reminder_sent_at.is_(None), Event.cancelled_at.is_(None), Event.starts_at > now, Event.starts_at <= horizon,
    )).all()
    sent = 0
    for event_id in due:
        claimed = db.execute(
            update(Event).where(Event.id == event_id, Event.reminder_sent_at.is_(None))
            .values(reminder_sent_at=now).returning(Event.id)
        ).first()
        if claimed is None:
            continue
        event = db.get(Event, event_id)
        going = db.scalars(select(EventRsvp.user_id).where(EventRsvp.event_id == event_id, EventRsvp.status == "going")).all()
        minutes = max(1, round((event.starts_at - now).total_seconds() / 60))
        when = f"in {minutes} min" if minutes < 90 else f"at {event.starts_at.astimezone(community.zone(settings)):%H:%M}"
        where = "online" if event.online else event.venue
        notifications.notify(db, going, "event_reminder", f"{event.title} starts {when}",
                             where or "", data={"route": f"/event/{event.id}", "event_id": str(event.id)},
                             dedupe_key=f"event_reminder:{event.id}")
        db.commit()
        sent += 1
    return sent


class ReminderLoop:
    def __init__(self, database: Database, settings: Settings, sender: push.PushSender | None):
        self.database, self.settings, self.sender = database, settings, sender
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="event-reminders", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.wait(INTERVAL_S):
            try:
                with push.attach(self.database.SessionLocal(), self.sender) as db:
                    send_due(db, self.settings)
            except Exception:  # a database hiccup must not end the loop
                log.exception("event reminders failed")
