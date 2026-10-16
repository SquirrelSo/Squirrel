"""Local development only: mint RS256 tokens so you can sign in to the app without the
(not yet built) account service.

    python scripts/dev_token.py init              # writes dev-keys/{private,public}.pem
    python scripts/dev_token.py token aanya       # prints a 30-day token with sub=<stable uuid for "aanya">

Point the service at the public key (SOCIAL_JWT_PUBLIC_KEY_FILE=dev-keys/public.pem), then paste
the token into the app's sign-in screen → "Developer: paste a backend token".

Production never uses this: tokens come from the account service and the service verifies them
against that service's public key / JWKS.
"""

from __future__ import annotations

import sys
import time
import uuid
from pathlib import Path

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

KEYS = Path(__file__).resolve().parent.parent / "dev-keys"
NAMESPACE = uuid.UUID("5f0c4b8e-7d1e-4c4a-9d61-3a8a4b7f2e10")


def init() -> None:
    KEYS.mkdir(exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    (KEYS / "private.pem").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    (KEYS / "public.pem").write_bytes(key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
    print(f"wrote {KEYS}/private.pem and public.pem")


def token(name: str, days: int = 30) -> None:
    private = (KEYS / "private.pem").read_text()
    sub = str(uuid.uuid5(NAMESPACE, name))
    now = int(time.time())
    print(jwt.encode({"sub": sub, "iat": now, "exp": now + days * 86400}, private, algorithm="RS256"))


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "init":
        init()
    elif len(sys.argv) >= 3 and sys.argv[1] == "token":
        token(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(1)
