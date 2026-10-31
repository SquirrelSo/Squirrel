"""The GPS points of one finished run, for Squirrel Dates' zone visits.

The Run Module owns runs and their points. Social reads `run_points` for one run it has just been
told about (POST /internal/v1/activities, source run_module, source_ref = the run id), in the shared
database, read-only, and keeps only which named zone the run passed and at which local hour
(services/dates.py). It never writes the Run Module's tables and never stores a point.

Reading happens inside a savepoint: if the table is missing (Social on its own database) or the
query fails, the caller gets no points and the activity is recorded anyway.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Protocol

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

log = logging.getLogger("social.route_points")

Point = tuple[float, float, datetime]


class RoutePoints(Protocol):
    def points(self, db: Session, run_id: str) -> list[Point]: ...


class SqlRoutePoints:
    """Reads the Run Module's `run_points` (run_id, seq, lat, lng, recorded_at) in the shared database."""

    def points(self, db: Session, run_id: str) -> list[Point]:
        try:
            rid = uuid.UUID(str(run_id))
        except ValueError:
            return []
        param = rid if db.get_bind().dialect.name == "postgresql" else str(rid)
        try:
            with db.begin_nested():
                rows = db.execute(
                    text("SELECT lat, lng, recorded_at FROM run_points WHERE run_id = :rid ORDER BY seq"), {"rid": param}
                ).all()
        except SQLAlchemyError as exc:
            log.warning("run_points unreadable for run %s: %s", rid, exc.__class__.__name__)
            return []
        return [(float(lat), float(lng), _utc(at)) for lat, lng, at in rows if at is not None]


def _utc(value) -> datetime:
    at = datetime.fromisoformat(value) if isinstance(value, str) else value
    return at.replace(tzinfo=timezone.utc) if at.tzinfo is None else at
