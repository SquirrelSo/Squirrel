"""API errors. Bodies are `{ "detail": "<message>", "code": "<machine code>" }`, which the app's
ApiError parser already understands (it reads `detail`)."""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(self, status: int, code: str, detail: str, headers: dict[str, str] | None = None):
        self.status = status
        self.code = code
        self.detail = detail
        self.headers = headers


def not_found(what: str = "Not found") -> ApiError:
    return ApiError(404, "not_found", what)


def forbidden(detail: str = "You can't do that.") -> ApiError:
    return ApiError(403, "forbidden", detail)


def invalid(detail: str, code: str = "invalid") -> ApiError:
    return ApiError(422, code, detail)


def conflict(detail: str, code: str = "conflict") -> ApiError:
    return ApiError(409, code, detail)


async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse({"detail": exc.detail, "code": exc.code}, status_code=exc.status, headers=exc.headers)
