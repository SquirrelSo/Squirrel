"""FitSync backend — restructured app.

The previous monolith is preserved as backend_old/ (reference only). The one-time A-pose
calibration has been dropped in favour of a per-set pre-check baseline (built in the engine/
and training/ layers). Today this serves the built SPA, user/session REST surfaces and the current
setup/training sockets; scoring, reporting and exercise breadth migrate in their own stages.

Layout:
    config.py    settings + per-user storage paths
    core/        generic primitives (landmarks, ids, keypoint helpers)
    engine/      exercise-agnostic infra (loader, scoring) — no rules, no FSM
    sessions/    minimal atomic session identity + plan persistence
    workouts/    validated lifecycle catalog + per-exercise config/FSM/rules
    training/    live setup-flow WS (/ws/setup) + baseline capture orchestration
    users/       user REST (create · profile · skill)
    profiles/    sign-up details: age, gender, activities, measurements/BMI, physique, habits, consent
    partners/    Partner Hunt: preferences, matching, blocks, behind the Run Module's XP gate
    shared_workouts/  Workout with Partner: invite, ready, shared countdown, a timed rep race (+ its socket)
    activity_matching/  workout partners suggested by shared activities (opt-in, no XP gate)
    activity_rating/    the member's own rating of a session (user-generated; never feeds the Workout Score)
    moderation/         reports on members or sessions, and the moderators' review queue
    db/                 optional PostgreSQL mirror of exercise sessions (DATABASE_URL)
    auth/               Squirrel Social accounts (register · login · refresh) + bearer-token dependency
    nearby/             BLE nearby discovery: rotating ids, proximity scoring, nearby list, notifications
    deeplinks/          /join + /invite/{token} store routing, download QR, Universal/App Link files

Run from the project root:
    uvicorn backend.main:app --reload
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.staticfiles import StaticFiles

from backend.activity_matching.router import router as activity_matching_router
from backend.activity_rating.router import router as activity_rating_router
from backend import live
from backend.auth.deps import current_user, require_path_user
from backend.auth.router import router as auth_router
from backend.cors import add_cors
from backend.db import connection as db_connection
from backend.db.migrate import migrate
from backend.auth import tokens as auth_tokens
from backend.deeplinks.router import router as deeplinks_router
from backend.engine.loader import validate_enabled_exercises
from backend.moderation.router import router as moderation_router
from backend.nearby.router import router as nearby_router
from backend.partners.router import router as partners_router
from backend.profiles.router import router as profiles_router
from backend.reports.router import router as reports_router
from backend.sessions.router import router as sessions_router
from backend.shared_workouts.router import completion_sweeper as shared_workouts_completion_sweeper
from backend.shared_workouts.router import router as shared_workouts_router
from backend.training.builders import validate_training_builders
from backend.training.router import router as setup_ws_router
from backend.users.router import router as users_router
from backend.workouts.catalog import load_catalog
from backend.workouts.router import router as workouts_router

# Planned entries validate lightweight metadata only. Enabled entries fully validate all four
# exercise config files before the application accepts traffic.
load_catalog()
validate_enabled_exercises()
validate_training_builders()

log = logging.getLogger(__name__)


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    """With DATABASE_URL set, bring the schema up to date before serving. A database that is down
    is logged, not fatal: sessions keep being stored on disk and can be backfilled later, and sign-in
    and profiles (which live in the database) answer with errors until it is back. A signing key
    that doesn't load stops the start: every sign-in would fail with it."""
    print(f"[auth] tokens are signed with {auth_tokens.algorithm()}")
    if db_connection.enabled():
        try:
            applied = migrate()
            print(f"[db] migrations {'applied: ' + ', '.join(applied) if applied else 'up to date'}")
        except Exception:  # noqa: BLE001
            log.exception("[db] could not run migrations; sign-in and profiles are unavailable until "
                          "the database is reachable")
    completion_sweep = asyncio.get_running_loop().create_task(shared_workouts_completion_sweeper())
    yield
    completion_sweep.cancel()
    db_connection.close_pools()


# Every route whose path names a user (/api/users/{user_id}/...) serves only that signed-in user.
app = FastAPI(title="Exercise Mechanics", lifespan=_lifespan, dependencies=[Depends(require_path_user)])

# The UI is the Vite-built SPA in frontend-dist (run `npm run build` in frontend-react/).
_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIST = _ROOT / "frontend-dist"


@app.middleware("http")
async def _no_cache_html(request, call_next):
    """Never let the browser serve a STALE index.html — its inline CSS + hashed JS reference
    change every build, so the HTML entry point must revalidate (the /assets/* files, being
    content-hashed, stay cacheable). Same guard as the reference backend."""
    response = await call_next(request)
    if response.headers.get("content-type", "").startswith("text/html"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


# The web app on its own domain (CORS_ALLOWED_ORIGINS; off when unset). Added last, so it runs first.
add_cors(app)

# API + WS routes are registered BEFORE the catch-all static mount so /api and /ws win.
app.include_router(users_router)
app.include_router(profiles_router)
app.include_router(workouts_router)
app.include_router(sessions_router)
app.include_router(reports_router)
app.include_router(activity_rating_router)
app.include_router(partners_router)
app.include_router(activity_matching_router)
app.include_router(moderation_router)
app.include_router(auth_router)
app.include_router(nearby_router)
app.include_router(shared_workouts_router)  # /api/workout-sessions/*, /ws/workout-sessions/{id}
app.include_router(deeplinks_router)   # /join, /invite/*, /.well-known/* — must precede the SPA mount
app.include_router(setup_ws_router)


@app.get("/api/live")
def live_counts(_user: str = Depends(current_user)) -> dict:
    """How many people are in a coached workout right now (the app's live counter; counts only)."""
    return {"working_out_now": live.working_out_now()}


# Mounted last so /ws + /api take precedence. html=True serves index.html at /.
app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
