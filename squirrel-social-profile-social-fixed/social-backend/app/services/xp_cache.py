"""Other people's XP: a read cache of the Run Module's total (ADR-032 "XP reads").

`user_stats.xp` is written only from the Run Module's answer, never incremented here. A list that
shows people (summaries, the feed, comments, user lists, a profile, campus-service's lookups) calls
`fresh(db, ids)`: everyone whose figure is older than `xp_cache_ttl_s` is asked for in ONE batch call
(POST /internal/v1/xp/totals, service token), stored, and returned so the list shows it at once.

XP is display only, so this fails open: with the Run Module unreachable (or not configured, or no
service token) the cached figures are shown. A person's own profile keeps refreshing on every read
with their token (routers/profiles.py sync_xp).

The request's session carries what this needs (`attach`, done in deps.get_db), so list helpers
don't have to pass the Run Module around. Refreshing commits, so it happens only where that can't
commit someone else's half-done work: in GET requests, or when the caller says it has nothing
pending (`settled=True`). Elsewhere the cached figures are shown.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import timedelta

from sqlalchemy import or_, select, update
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import utcnow
from app.models import User, UserStats
from app.services.run_module import RunModule


def attach(db: Session, run_module: RunModule, settings: Settings, *, read_request: bool) -> Session:
    db.info["xp_cache"] = (run_module, settings, read_request)
    return db


def fresh(db: Session, user_ids: Iterable[uuid.UUID], *, settled: bool = False) -> dict[uuid.UUID, int]:
    """Refreshes the stale figures among `user_ids` and returns them ({user id: xp}); fresh ones and
    anyone the Run Module didn't answer for keep their cached figure (not in the result)."""
    attached = db.info.get("xp_cache")
    ids = set(user_ids)
    if not attached or not ids:
        return {}
    run_module, settings, read_request = attached
    if not (read_request or settled):
        return {}
    if not run_module.configured or not settings.internal_token:
        return {}
    cutoff = utcnow() - timedelta(seconds=settings.xp_cache_ttl_s)
    stale = dict(db.execute(
        select(User.auth_subject, User.id).join(UserStats, UserStats.user_id == User.id)
        .where(User.id.in_(ids), or_(UserStats.xp_synced_at.is_(None), UserStats.xp_synced_at < cutoff))
    ).all())
    if not stale:
        return {}
    totals = run_module.get_xp_totals(settings.internal_token, list(stale))
    if not totals:
        return {}
    now = utcnow()
    out = {}
    for subject, xp in totals.items():
        if subject in stale:
            out[stale[subject]] = xp
            db.execute(update(UserStats).where(UserStats.user_id == stale[subject]).values(xp=xp, xp_synced_at=now))
    db.commit()
    return out
