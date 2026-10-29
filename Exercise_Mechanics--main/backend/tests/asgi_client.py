"""Minimal in-process ASGI client (the project does not depend on httpx)."""

from __future__ import annotations

import asyncio
import json as _json
from dataclasses import dataclass


@dataclass
class Result:
    status: int
    headers: dict[str, str]
    body: bytes

    def json(self):
        return _json.loads(self.body)

    @property
    def text(self) -> str:
        return self.body.decode()


def call(app, method: str, path: str, *, json=None, headers: dict[str, str] | None = None,
         client: str = "127.0.0.1") -> Result:
    path, _, query = path.partition("?")
    body = b"" if json is None else _json.dumps(json).encode()
    raw_headers = [(b"host", b"test")]
    if json is not None:
        raw_headers.append((b"content-type", b"application/json"))
    raw_headers += [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    messages: list[dict] = []
    sent = False

    async def receive() -> dict:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        messages.append(message)

    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
        "method": method, "scheme": "http", "path": path, "raw_path": path.encode(),
        "query_string": query.encode(), "root_path": "", "headers": raw_headers,
        "client": (client, 12345), "server": ("test", 80),
    }
    asyncio.run(app(scope, receive, send))
    start = next(m for m in messages if m["type"] == "http.response.start")
    return Result(
        status=start["status"],
        headers={k.decode(): v.decode() for k, v in start.get("headers", [])},
        body=b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body"),
    )
