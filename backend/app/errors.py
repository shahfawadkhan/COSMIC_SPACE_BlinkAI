"""API errors rendered as JSON {code, message}."""
from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError

from .jsonutil import SafeJSONResponse

log = logging.getLogger(__name__)


class AppError(Exception):
    status_code = 500
    code = "internal_error"

    def __init__(self, message: str, *, code: str | None = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message}


class BadRequest(AppError):
    status_code = 400
    code = "bad_request"


class NotFound(AppError):
    status_code = 404
    code = "not_found"


class UpstreamError(AppError):
    """An external service (IRSA, SIMBAD, Gaia...) failed or is unreachable."""
    status_code = 502
    code = "upstream_error"


def install_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError):
        return SafeJSONResponse(exc.to_dict(), status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        parts = []
        for err in exc.errors():
            loc = ".".join(str(p) for p in err.get("loc", []) if p not in ("query", "body"))
            parts.append(f"{loc}: {err.get('msg')}" if loc else str(err.get("msg")))
        return SafeJSONResponse(
            {"code": "bad_request", "message": "; ".join(parts) or "Invalid request"},
            status_code=400,
        )

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception):
        log.exception("Unhandled error")
        return SafeJSONResponse(
            {"code": "internal_error", "message": f"Internal error: {type(exc).__name__}"},
            status_code=500,
        )
