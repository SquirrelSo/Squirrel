"""FastAPI dependencies. Everything stateful hangs off `app.state` so tests can build an app
with their own database, keys, Run Module double and storage double."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Header, Request
from sqlalchemy.orm import Session

from app.auth import Viewer, bearer_token, get_or_create_user
from app.config import Settings
from app.ratelimit import RateLimiter
from app.services import ambassador, push, xp_cache
from app.services.media import MediaStorage
from app.services.membership import ensure_member
from app.services.run_module import RunModule


def get_db(request: Request) -> Iterator[Session]:
    # Pushes queued while handling the request go out once it commits (services/push.py); lists
    # refresh other people's cached XP from the Run Module (services/xp_cache.py).
    db = push.attach(request.app.state.db.SessionLocal(), request.app.state.push)
    xp_cache.attach(db, request.app.state.run_module, request.app.state.settings, read_request=request.method == "GET")
    # Ambassador XP rewards due in this request go to the Run Module after it commits.
    ambassador.attach(db, request.app.state.run_module, request.app.state.settings)
    try:
        yield db
    finally:
        db.close()


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


def get_limiter(request: Request) -> RateLimiter:
    return request.app.state.limiter


def get_run_module(request: Request) -> RunModule:
    return request.app.state.run_module


def get_storage(request: Request) -> MediaStorage:
    return request.app.state.storage


def get_viewer(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    authorization: Annotated[str | None, Header()] = None,
) -> Viewer:
    token = bearer_token(authorization)
    claims = request.app.state.verifier.verify(token)
    user = get_or_create_user(db, str(claims["sub"]))
    # Everyone joins the waitlist on first sight; `ev` (email verified at sign-up) sets the
    # founding order (services/membership.py).
    ensure_member(db, user, claims.get("ev") is True, request.app.state.settings)
    return Viewer(user=user, token=token)


DB = Annotated[Session, Depends(get_db)]
CurrentViewer = Annotated[Viewer, Depends(get_viewer)]
AppSettings = Annotated[Settings, Depends(get_settings_dep)]
Limiter = Annotated[RateLimiter, Depends(get_limiter)]
RunModuleDep = Annotated[RunModule, Depends(get_run_module)]
Storage = Annotated[MediaStorage, Depends(get_storage)]
