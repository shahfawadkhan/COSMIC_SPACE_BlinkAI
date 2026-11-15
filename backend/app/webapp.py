"""Serve the built React frontend from the backend: one service, one URL (used in deployment).

The frontend is built with `npm run build` into frontend/dist. When that folder exists (or
STATIC_DIR points to one), every non-API path returns the matching file, or index.html so that
client-side routes such as /explorer?ra=...&dec=... work when opened directly. API routes,
/docs and /openapi.json are untouched, and unknown /api/... paths still return a JSON 404.
In development nothing changes: Vite serves the frontend on port 3000.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response

from .errors import NotFound

log = logging.getLogger("cosmic.webapp")

RESERVED = ("api/", "docs", "redoc", "openapi.json")
DEFAULT_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


def static_dir() -> Path | None:
    """STATIC_DIR if set (empty = disabled), else frontend/dist next to the backend if built."""
    env = os.environ.get("STATIC_DIR")
    path = Path(env) if env else DEFAULT_DIST
    if env == "" or not (path / "index.html").is_file():
        return None
    return path.resolve()


def mount_frontend(app: FastAPI, dist: Path | None = None) -> Path | None:
    """Register the catch-all route that serves the frontend. Call after all API routes."""
    dist = dist if dist is not None else static_dir()
    if dist is None:
        log.info("No built frontend found (frontend/dist); serving the API only")
        return None
    index = dist / "index.html"
    log.info("Serving the frontend from %s", dist)

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str, request: Request) -> Response:
        if path.startswith(RESERVED):
            raise NotFound(f"Unknown path /{path}")
        target = (dist / path).resolve()
        if path and target.is_file() and dist in target.parents:  # a real file, never outside dist
            immutable = path.startswith("assets/")  # Vite gives these hashed names
            headers = {"Cache-Control": "public, max-age=31536000, immutable" if immutable else "public, max-age=3600"}
            return FileResponse(target, headers=headers)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})

    return dist
