"""Bearer-token authentication.

Tokens are the account service's RS256 JWTs — the same ones the Run Module verifies — so the
app keeps one sign-in and one `Authorization: Bearer` header for every service. The `sub`
claim identifies the account; the first authenticated request provisions its profile.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass

import jwt
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings
from app.errors import ApiError
from app.models import User, UserStats


def unauthorized(detail: str = "Sign in to continue.") -> ApiError:
    return ApiError(401, "unauthorized", detail, {"WWW-Authenticate": "Bearer"})


class TokenVerifier:
    def __init__(self, settings: Settings):
        self.algorithms = list(settings.jwt_algorithms)
        self.issuer = settings.jwt_issuer
        self.audience = settings.jwt_audience
        self._jwks = jwt.PyJWKClient(settings.jwks_url, cache_keys=True) if settings.jwks_url else None
        self._key = settings.jwt_public_key
        if not self._jwks and not self._key:
            raise RuntimeError("Set SOCIAL_JWT_PUBLIC_KEY(_FILE) or SOCIAL_JWKS_URL: the service will not run without token verification.")

    def verify(self, token: str) -> dict:
        try:
            key = self._jwks.get_signing_key_from_jwt(token).key if self._jwks else self._key
            claims = jwt.decode(
                token,
                key,
                algorithms=self.algorithms,
                audience=self.audience,
                issuer=self.issuer,
                leeway=30,
                options={"require": ["exp", "sub"], "verify_aud": self.audience is not None},
            )
        except jwt.ExpiredSignatureError:
            raise unauthorized("Your session expired. Sign in again.") from None
        except (jwt.PyJWTError, ValueError):
            raise unauthorized("Invalid token.") from None
        # Exercise's service tokens (typ "service", sub "exercise_module") are never a person.
        if claims.get("typ", "access") != "access":
            raise unauthorized("Invalid token.")
        return claims


@dataclass
class Viewer:
    user: User
    token: str

    @property
    def id(self):
        return self.user.id


def bearer_token(authorization: str | None) -> str:
    if not authorization:
        raise unauthorized()
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise unauthorized()
    return token.strip()


def _generated_username(subject: str, attempt: int) -> str:
    digest = hashlib.sha256(subject.encode()).hexdigest()
    return f"user_{digest[:8]}" if attempt == 0 else f"user_{secrets.token_hex(5)}"


def get_or_create_user(db: Session, subject: str) -> User:
    """Find the profile for an account, creating it on first sight. Safe under concurrent first
    requests: the unique constraint on auth_subject decides the winner."""
    if len(subject) > 255:
        raise unauthorized("Invalid token subject.")
    user = db.scalar(select(User).where(User.auth_subject == subject))
    if user:
        return user
    for attempt in range(5):
        username = _generated_username(subject, attempt)
        user = User(auth_subject=subject, username=username, display_name="New Squirrel", interests=[])
        user.stats = UserStats()
        db.add(user)
        try:
            db.commit()
            return user
        except IntegrityError:
            db.rollback()
            existing = db.scalar(select(User).where(User.auth_subject == subject))
            if existing:
                return existing
            # otherwise the generated username collided: try another
    raise ApiError(500, "provisioning_failed", "Couldn't create your profile. Try again.")
