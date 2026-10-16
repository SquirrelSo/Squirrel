"""Cross-origin access for the web app (e.g. the Expo web build on Vercel), which runs on its own
domain and calls this API from the browser.

    CORS_ALLOWED_ORIGINS=https://squirrel.vercel.app,https://squirrel-*-team.vercel.app

Comma-separated origins. A `*` matches one run of letters, digits and dashes inside a host name (for
Vercel preview URLs), never a dot, so it cannot widen to another domain. Unset or empty: no
cross-origin browser access. The phone app and the browser coach this backend serves itself are
same-origin or not browsers, so they are unaffected either way.

No cookies are involved (requests carry a bearer token), so credentials stay off. The Run Module
reads the same variable with the same rules (run-module/backend/src/api/cors.ts). WebSockets are not
subject to CORS; the training sockets check the bearer token instead.
"""

from __future__ import annotations

import os
import re

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

ALLOWED_ORIGINS_ENV = "CORS_ALLOWED_ORIGINS"


def parse_allowed_origins(raw: str | None) -> tuple[list[str], str | None]:
    """(exact origins, one regex for the wildcard entries or None)."""
    exact: list[str] = []
    patterns: list[str] = []
    for entry in (raw or "").split(","):
        origin = entry.strip().rstrip("/")
        if not origin:
            continue
        if "*" in origin:
            patterns.append("[a-z0-9-]+".join(re.escape(part) for part in origin.split("*")))
        else:
            exact.append(origin)
    regex = f"(?i:{'|'.join(patterns)})" if patterns else None
    return exact, regex


def add_cors(app: FastAPI, raw: str | None = None) -> None:
    exact, regex = parse_allowed_origins(os.environ.get(ALLOWED_ORIGINS_ENV) if raw is None else raw)
    if not exact and regex is None:
        return
    app.add_middleware(
        CORSMiddleware,
        allow_origins=exact,
        allow_origin_regex=regex,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
        expose_headers=["Retry-After"],
        allow_credentials=False,
        max_age=600,
    )
