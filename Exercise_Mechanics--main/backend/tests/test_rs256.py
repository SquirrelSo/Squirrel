"""RS256 sign-in tokens (ADR-003): with JWT_PRIVATE_KEY set, tokens are signed with the private key,
only RS256 is accepted, and the public key is published at /api/auth/jwks.json."""

from __future__ import annotations

import base64
import json

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from fastapi import FastAPI

from backend import config
from backend.auth import tokens
from backend.auth.router import router as auth_router
from backend.tests.asgi_client import call

USER = "0b7f5c1e-3a52-4c8e-9f1d-6f0e2d8a4b11"


def _pem(key) -> str:
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption()).decode()


@pytest.fixture(scope="module")
def key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def rs256(monkeypatch, key):
    monkeypatch.delenv(config.JWT_PRIVATE_KEY_FILE_ENV, raising=False)
    monkeypatch.setenv(config.JWT_PRIVATE_KEY_ENV, _pem(key))
    return key


def _parts(token: str) -> tuple[dict, dict, bytes]:
    h, p, s = token.split(".")
    dec = lambda t: base64.urlsafe_b64decode(t + "=" * (-len(t) % 4))  # noqa: E731
    return json.loads(dec(h)), json.loads(dec(p)), dec(s)


def test_tokens_are_rs256_and_verify_with_the_public_key_alone(rs256):
    token, _ = tokens.issue_access_token(USER, email_verified=True)
    header, claims, sig = _parts(token)
    assert header["alg"] == "RS256" and header["kid"]
    assert claims["sub"] == USER and claims["ev"] is True
    # what the Run Module and the Social service do: verify with the public PEM only
    public = serialization.load_pem_public_key(tokens.public_key_pem().encode())
    public.verify(sig, token.rsplit(".", 1)[0].encode(), padding.PKCS1v15(), hashes.SHA256())
    assert tokens.verify_access_token(token) == USER
    assert tokens.algorithm() == "RS256"


def test_an_hs256_token_is_refused_once_rs256_is_on(monkeypatch, rs256):
    monkeypatch.delenv(config.JWT_PRIVATE_KEY_ENV)
    old, _ = tokens.issue_access_token(USER)
    assert tokens.verify_access_token(old) == USER
    monkeypatch.setenv(config.JWT_PRIVATE_KEY_ENV, _pem(rs256))
    assert tokens.verify_access_token(old) is None  # the app refreshes and gets an RS256 token
    new, _ = tokens.issue_access_token(USER)
    monkeypatch.delenv(config.JWT_PRIVATE_KEY_ENV)
    assert tokens.verify_access_token(new) is None  # and no way back without the key


def test_tampered_or_unsigned_tokens_are_refused(rs256):
    token, _ = tokens.issue_access_token(USER)
    h, p, s = token.split(".")
    other = base64.urlsafe_b64encode(json.dumps({"sub": "someone-else", "typ": "access", "exp": 9_999_999_999}).encode()).rstrip(b"=").decode()
    assert tokens.verify_access_token(f"{h}.{other}.{s}") is None
    none_header = base64.urlsafe_b64encode(b'{"alg":"none","typ":"JWT"}').rstrip(b"=").decode()
    assert tokens.verify_access_token(f"{none_header}.{p}.") is None
    assert tokens.verify_access_token(f"{h}.{p}.{s[:-4]}AAAA") is None


def test_a_token_signed_by_another_key_is_refused(rs256, monkeypatch):
    stranger = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setenv(config.JWT_PRIVATE_KEY_ENV, _pem(stranger))
    forged, _ = tokens.issue_access_token(USER)
    monkeypatch.setenv(config.JWT_PRIVATE_KEY_ENV, _pem(rs256))
    assert tokens.verify_access_token(forged) is None


def test_service_tokens_are_rs256_too(rs256):
    header, claims, _ = _parts(tokens.issue_service_token())
    assert header["alg"] == "RS256" and claims["typ"] == "service"


def test_jwks_publishes_the_public_key(rs256):
    app = FastAPI()
    app.include_router(auth_router)
    keys = call(app, "GET", "/api/auth/jwks.json").json()["keys"]
    assert len(keys) == 1 and keys[0]["alg"] == "RS256" and keys[0]["kid"] == _parts(tokens.issue_access_token(USER)[0])[0]["kid"]
    n = int.from_bytes(base64.urlsafe_b64decode(keys[0]["n"] + "=="), "big")
    assert n == rs256.public_key().public_numbers().n


def test_jwks_is_empty_under_hs256(monkeypatch):
    monkeypatch.delenv(config.JWT_PRIVATE_KEY_ENV, raising=False)
    monkeypatch.delenv(config.JWT_PRIVATE_KEY_FILE_ENV, raising=False)
    assert tokens.public_jwks() == {"keys": []} and tokens.public_key_pem() is None


def test_the_key_can_come_escaped_or_from_a_file(monkeypatch, key, tmp_path):
    monkeypatch.setenv(config.JWT_PRIVATE_KEY_ENV, _pem(key).replace("\n", "\\n"))
    assert tokens.verify_access_token(tokens.issue_access_token(USER)[0]) == USER
    monkeypatch.delenv(config.JWT_PRIVATE_KEY_ENV)
    path = tmp_path / "jwt-private.pem"
    path.write_text(_pem(key))
    monkeypatch.setenv(config.JWT_PRIVATE_KEY_FILE_ENV, str(path))
    assert tokens.algorithm() == "RS256"


def test_email_code_hmac_never_uses_the_public_jwt_secret(monkeypatch, rs256):
    # Under RS256 the shared JWT_SECRET holds the PUBLIC key: it must not key anything secret.
    monkeypatch.setenv(config.SHARED_JWT_SECRET_ENV, "-----BEGIN PUBLIC KEY-----")
    monkeypatch.delenv(config.AUTH_SECRET_ENV, raising=False)
    assert tokens.signing_secret() != b"-----BEGIN PUBLIC KEY-----"
    monkeypatch.setenv(config.AUTH_SECRET_ENV, "a-real-secret")
    assert tokens.signing_secret() == b"a-real-secret"


def test_a_weak_key_is_refused(monkeypatch):
    weak = rsa.generate_private_key(public_exponent=65537, key_size=1024)
    monkeypatch.setenv(config.JWT_PRIVATE_KEY_ENV, _pem(weak))
    with pytest.raises(ValueError):
        tokens.algorithm()
