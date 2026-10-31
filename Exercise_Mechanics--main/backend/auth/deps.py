"""FastAPI dependencies: `Authorization: Bearer <access token>` → user id, and the app-wide
guard that keeps every per-user route to its own user."""

from __future__ import annotations

from fastapi import Header, HTTPException, status
from starlette.requests import HTTPConnection

from backend import config
from backend.auth.tokens import verify_access_token
from backend.core.ids import is_valid_user_id


def current_user(authorization: str | None = Header(default=None)) -> str:
    scheme, _, token = (authorization or "").partition(" ")
    user_id = verify_access_token(token) if scheme.lower() == "bearer" and token else None
    if user_id is None or not is_valid_user_id(user_id):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or expired access token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user_id


def require_path_user(connection: HTTPConnection) -> None:
    """App-wide guard: a route whose path names a user (`/api/users/{user_id}/...`) serves only
    that user. Needs `Authorization: Bearer <access token>` for the same user: 401 without a valid
    token, 403 for anyone else's id. Routes that name no user (catalogs, auth, moderation behind
    its own token) are untouched. Off only when config.auth_required() is off (development)."""
    path_user = connection.path_params.get("user_id")
    if path_user is None or not config.auth_required():
        return
    if current_user(connection.headers.get("authorization")) != path_user:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="not your account")
