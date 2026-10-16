"""Password hashing and token primitives.

Access tokens are standard JWTs carrying the user id (`sub`), expiry and, for an account that
verified its email at sign-up, `ev`; short-lived and stateless. One sign-in works on every backend:

  RS256  when JWT_PRIVATE_KEY / JWT_PRIVATE_KEY_FILE is set: signed with that private key; the Run
         Module and the Social service verify with the public key (also at /api/auth/jwks.json).
  HS256  otherwise: signed with the shared secret the others verify with (JWT_SECRET).

Exactly one algorithm is issued and accepted at a time, so "alg": "none" and algorithm swaps are
rejected. Refresh tokens are opaque random strings; only their SHA-256 is stored server-side (see
store.py) and each refresh rotates them, which is also how clients move over after a switch: their
old access token fails once (401) and the refresh returns a token in the new algorithm.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from backend import config

_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2 ** 14, 8, 1


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


# --- passwords ---------------------------------------------------------------

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${_b64e(salt)}${_b64e(digest)}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, n, r, p, salt, digest = encoded.split("$")
        if scheme != "scrypt":
            return False
        actual = hashlib.scrypt(password.encode(), salt=_b64d(salt), n=int(n), r=int(r), p=int(p))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, _b64d(digest))


# A precomputed hash so a login for an unknown email still spends one scrypt — the response time
# does not reveal whether the account exists.
_DUMMY_HASH = hash_password("squirrel-dummy-password")


def burn_password_check(password: str) -> None:
    verify_password(password, _DUMMY_HASH)


# --- signing key -------------------------------------------------------------

def _secret() -> bytes:
    # SQUIRREL_AUTH_SECRET, else the Run Module's JWT_SECRET: sharing it is what lets the Run
    # Module accept these tokens.
    for name in (config.AUTH_SECRET_ENV, config.SHARED_JWT_SECRET_ENV):
        env = os.environ.get(name)
        if env:
            return env.encode()
    # Development fallback: one random key persisted with 0600 permissions.
    path = config.AUTH_DIR / "secret.key"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "w") as f:
                f.write(secrets.token_urlsafe(48))
    return path.read_text().strip().encode()


@dataclass(frozen=True)
class _RsaKey:
    private: object
    public: object
    kid: str
    header: str  # the fixed, encoded JWT header issued and accepted


def _private_key_pem() -> str | None:
    pem = os.environ.get(config.JWT_PRIVATE_KEY_ENV)
    if not pem and os.environ.get(config.JWT_PRIVATE_KEY_FILE_ENV):
        pem = Path(os.environ[config.JWT_PRIVATE_KEY_FILE_ENV]).read_text()
    return pem.replace("\\n", "\n").strip() if pem else None


@lru_cache(maxsize=4)
def _load_rsa(pem: str) -> _RsaKey:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    private = serialization.load_pem_private_key(pem.encode(), password=None)
    if not isinstance(private, rsa.RSAPrivateKey) or private.key_size < 2048:
        raise ValueError("JWT_PRIVATE_KEY must be an RSA private key of at least 2048 bits")
    public = private.public_key()
    der = public.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    digest = hashes.Hash(hashes.SHA256())
    digest.update(der)
    kid = digest.finalize().hex()[:16]
    header = _b64e(json.dumps({"alg": "RS256", "typ": "JWT", "kid": kid}, separators=(",", ":")).encode())
    return _RsaKey(private, public, kid, header)


def _rsa() -> _RsaKey | None:
    pem = _private_key_pem()
    return _load_rsa(pem) if pem else None


def algorithm() -> str:
    """The one algorithm tokens are issued and accepted with right now."""
    return "RS256" if _rsa() else "HS256"


def public_key_pem() -> str | None:
    """The RS256 public key (PEM) the other services verify with; None under HS256."""
    key = _rsa()
    if key is None:
        return None
    from cryptography.hazmat.primitives import serialization

    return key.public.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()


def public_jwks() -> dict:
    """{"keys": [...]}: the RS256 public key as a JWK set (empty under HS256)."""
    key = _rsa()
    if key is None:
        return {"keys": []}
    numbers = key.public.public_numbers()

    def b64_int(n: int) -> str:
        return _b64e(n.to_bytes((n.bit_length() + 7) // 8, "big"))

    return {"keys": [{"kty": "RSA", "use": "sig", "alg": "RS256", "kid": key.kid, "n": b64_int(numbers.n), "e": b64_int(numbers.e)}]}


# --- access tokens -----------------------------------------------------------

# Fixed header per algorithm: the only one issued or accepted, so "alg": "none" and algorithm swaps
# are rejected outright.
_HS256_HEADER = _b64e(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())


def signing_secret() -> bytes:
    """The HMAC key of stored email codes (and of HS256 tokens). Under RS256, JWT_SECRET holds the
    public key, so it is never used here: SQUIRREL_AUTH_SECRET if set, else a key derived from the
    private key."""
    rsa_key_pem = _private_key_pem()
    if rsa_key_pem and not os.environ.get(config.AUTH_SECRET_ENV):
        return hashlib.sha256(b"squirrel-hmac-key:" + rsa_key_pem.encode()).digest()
    return _secret()


def _header() -> str:
    key = _rsa()
    return key.header if key else _HS256_HEADER


def _sign(signing_input: str) -> str:
    key = _rsa()
    if key is None:
        return _b64e(hmac.new(_secret(), signing_input.encode(), hashlib.sha256).digest())
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    return _b64e(key.private.sign(signing_input.encode(), padding.PKCS1v15(), hashes.SHA256()))


def _signature_ok(signing_input: str, sig: str) -> bool:
    key = _rsa()
    if key is None:
        return hmac.compare_digest(sig, _sign(signing_input))
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    try:
        key.public.verify(_b64d(sig), signing_input.encode(), padding.PKCS1v15(), hashes.SHA256())
    except (InvalidSignature, ValueError):
        return False
    return True


def issue_access_token(user_id: str, now: float | None = None, *, email_verified: bool = False) -> tuple[str, int]:
    """Return (token, expires_at_epoch_seconds). An account that proved its email address at sign-up
    (auth/email_codes.py) carries `"ev": true`, for the Social service's founding-member badges."""
    iat = int(now if now is not None else time.time())
    exp = iat + config.ACCESS_TOKEN_TTL_SECONDS
    claims = {"sub": user_id, "iat": iat, "exp": exp, "typ": "access"}
    if email_verified:
        claims["ev"] = True
    payload = _b64e(json.dumps(claims, separators=(",", ":")).encode())
    signing_input = f"{_header()}.{payload}"
    return f"{signing_input}.{_sign(signing_input)}", exp


def verify_access_token(token: str, now: float | None = None) -> str | None:
    """Return the user id for a valid, unexpired access token, else None."""
    try:
        header, payload, sig = token.split(".")
        if header != _header() or not _signature_ok(f"{header}.{payload}", sig):
            return None
        claims = json.loads(_b64d(payload))
    except (ValueError, TypeError):
        return None
    if not isinstance(claims, dict) or claims.get("typ") != "access" or not isinstance(claims.get("sub"), str):
        return None
    if int(claims.get("exp", 0)) <= (now if now is not None else time.time()):
        return None
    return claims["sub"]


# --- service tokens ----------------------------------------------------------

SERVICE_SUBJECT = "exercise_module"
SERVICE_TOKEN_TTL_SECONDS = 300


def issue_service_token(now: float | None = None) -> str:
    """A short-lived token this backend presents to the Run Module's service-only routes (Partner
    Hunt asking about OTHER users' XP; Run Module ADR-027). Signed with the same key as access
    tokens; `typ: "service"` and a non-UUID subject keep it from ever passing as a user's token,
    here (verify_access_token wants typ "access") or on the Run Module (it wants a UUID subject)."""
    iat = int(now if now is not None else time.time())
    payload = _b64e(json.dumps({"sub": SERVICE_SUBJECT, "iat": iat, "exp": iat + SERVICE_TOKEN_TTL_SECONDS,
                                "typ": "service"}, separators=(",", ":")).encode())
    signing_input = f"{_header()}.{payload}"
    return f"{signing_input}.{_sign(signing_input)}"


# --- refresh tokens ----------------------------------------------------------

def new_refresh_token() -> str:
    return secrets.token_urlsafe(32)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
