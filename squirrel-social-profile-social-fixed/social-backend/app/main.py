"""Squirrel Social — Profile + Social service.

    uvicorn app.main:app --port 8100          (from social-backend/)

Routes live under /v1 alongside the Run Module's, so both can sit behind one gateway and the
app can use a single base URL. See README.md for the contract.
"""

from __future__ import annotations

import re
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth import TokenVerifier
from app.config import Settings, get_settings
from app.db import Database
from app.errors import ApiError, api_error_handler
from app.ratelimit import RateLimiter
from app.routers import ambassador, blocks, challenges, community, crews, dates, events, feed, follows, internal, media, notifications, posts, profiles
from app.services.media import MediaStorage, make_storage
from app.services.push import ExpoPush, PushSender, ReceiptLoop
from app.services.reminders import ReminderLoop
from app.services.route_points import RoutePoints, SqlRoutePoints
from app.services.run_module import HttpRunModule, RunModule


def create_app(
    settings: Settings | None = None,
    *,
    database: Database | None = None,
    run_module: RunModule | None = None,
    storage: MediaStorage | None = None,
    limiter: RateLimiter | None = None,
    push: PushSender | None = None,
    route_points: RoutePoints | None = None,
) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        loops = []
        if settings.reminders_enabled:
            loops.append(ReminderLoop(app.state.db, settings, app.state.push))
        if settings.push_receipts_enabled and isinstance(app.state.push, ExpoPush) and app.state.push.enabled:
            loops.append(ReceiptLoop(app.state.push))
        for loop in loops:
            loop.start()
        yield
        for loop in loops:
            loop.stop()

    app = FastAPI(title="Squirrel Social — Profile & Social API", version="1.0.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.verifier = TokenVerifier(settings)
    app.state.db = database or Database(settings.database_url)
    app.state.push = push or ExpoPush(app.state.db, enabled=settings.push_enabled, access_token=settings.expo_access_token)
    app.state.run_module = run_module or HttpRunModule(settings.run_module_url, settings.run_module_timeout_s)
    app.state.storage = storage or make_storage(settings)
    app.state.limiter = limiter or RateLimiter(enabled=settings.rate_limits_enabled)
    app.state.route_points = route_points or SqlRoutePoints()

    app.add_exception_handler(ApiError, api_error_handler)
    if settings.cors_origins:
        exact, pattern = split_cors_origins(settings.cors_origins)
        app.add_middleware(
            CORSMiddleware,
            allow_origins=exact,
            allow_origin_regex=pattern,
            allow_methods=["GET", "POST", "PATCH", "DELETE"],
            allow_headers=["Authorization", "Content-Type", "Accept"],
            expose_headers=["Retry-After"],
        )

    # profiles first: its literal /users/me/… and /users/search routes must win over /users/{id}/….
    for r in (profiles.router, follows.router, feed.router, posts.router, media.router, internal.router,
              community.router, crews.router, events.router, challenges.router, notifications.router, dates.router,
              blocks.router, ambassador.router):
        app.include_router(r)

    @app.get("/healthz", include_in_schema=False)
    def healthz() -> dict:
        return {"ok": True}

    return app


def split_cors_origins(origins: tuple[str, ...]) -> tuple[list[str], str | None]:
    """Exact origins, plus one regex for entries with a `*` (preview deploys, e.g.
    https://squirrel-*.vercel.app). A `*` matches letters, digits and hyphens only, never a dot,
    so it cannot reach another domain. Same rules as the Exercise backend's cors.py."""
    exact = [o.rstrip("/") for o in origins if "*" not in o]
    wild = [
        "".join("[a-z0-9-]+" if part == "*" else re.escape(part) for part in re.split(r"(\*)", o.rstrip("/")))
        for o in origins
        if "*" in o
    ]
    return exact, ("^(?:" + "|".join(wild) + ")$" if wild else None)


def __getattr__(name: str):
    # `uvicorn app.main:app` builds the app lazily so importing this module (tests, alembic)
    # doesn't require production settings.
    if name == "app":
        return create_app()
    raise AttributeError(name)
