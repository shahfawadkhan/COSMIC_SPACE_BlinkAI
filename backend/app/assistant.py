"""Proxy to the SPHEREx AI chatbot service (https://spherex-chatbot.onrender.com).

The browser talks only to us; the service key (SPHEREX_AI_KEY, from backend/.env) never leaves
the server. The answer stream (Server-Sent Events) is relayed byte for byte without buffering;
when the browser disconnects, the upstream connection is closed, which cancels generation.

Endpoints
  GET    /api/assistant/status            is the AI configured / awake?
  POST   /api/assistant/chat/stream       {message, session_id?, context?} -> SSE (start/token/sources/done/error)
  DELETE /api/assistant/chat/{session_id} forget a conversation
"""
from __future__ import annotations

import re
import time

import httpx
from fastapi import APIRouter, Body
from fastapi.responses import StreamingResponse

from . import config
from .jsonutil import SafeJSONResponse

router = APIRouter(prefix="/api/assistant")

SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_MESSAGE = 4000
MAX_CONTEXT = 1500
TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=10.0)
_status_cache: dict = {"at": 0.0, "value": None}


def _error(status: int, code: str, message: str, retryable: bool = False) -> SafeJSONResponse:
    return SafeJSONResponse({"code": code, "message": message, "retryable": retryable}, status_code=status)


def _headers() -> dict:
    return {"X-API-Key": config.settings.ai_key} if config.settings.ai_key else {}


@router.get("/status")
async def status():
    """Also wakes the free-tier service (it sleeps after 15 min idle)."""
    configured = bool(config.settings.ai_key)
    now = time.monotonic()
    cached = _status_cache["value"]
    if cached and now - _status_cache["at"] < 30 and cached["service"] == "ok":
        return SafeJSONResponse({**cached, "configured": configured})
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(12.0, connect=8.0)) as client:
            r = await client.get(f"{config.settings.ai_url}/health")
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        value = {"service": "ok" if r.status_code == 200 else "down", "llm_configured": bool(body.get("llm_configured")),
                 "http_status": r.status_code}
    except httpx.TimeoutException:
        value = {"service": "waking", "llm_configured": None,
                 "message": "The AI service is waking up (free hosting sleeps after 15 min). Try again in a minute."}
    except httpx.HTTPError as exc:
        value = {"service": "down", "llm_configured": None, "message": f"AI service unreachable ({type(exc).__name__})"}
    _status_cache.update(at=now, value=value)
    return SafeJSONResponse({**value, "configured": configured})


def build_message(message: str, context: str | None) -> str:
    """Add what the user is looking at, clearly marked, AFTER the question.

    The service searches its documents with the whole message; a leading context block made
    that search find nothing (it then answered from memory, sometimes outdated)."""
    message = message.strip()
    if not context:
        return message[:MAX_MESSAGE]
    ctx = context.strip()[:MAX_CONTEXT]
    suffix = f"\n\n(Screen context from the COSMIC app, only if relevant: {ctx})"
    return message[: MAX_MESSAGE - len(suffix)] + suffix


_UPSTREAM_MAP = {
    401: (502, "ai_key_rejected", "The AI service rejected our service key. Check SPHEREX_AI_KEY in backend/.env.", False),
    422: (400, "bad_request", "The question could not be sent (too long or invalid).", False),
    429: (429, "ai_rate_limited", "The AI is busy (rate limit). Try again in a moment.", True),
    503: (503, "ai_unavailable", "The AI model is not available right now. Try again later.", True),
    504: (504, "ai_timeout", "The AI took too long. Try again.", True),
}


@router.post("/chat/stream")
async def chat_stream(body: dict = Body(...)):
    message = str(body.get("message") or "")
    session_id = body.get("session_id")
    if not message.strip():
        return _error(400, "bad_request", "Type a question first.")
    if len(message) > MAX_MESSAGE:
        return _error(400, "message_too_long", f"Questions are limited to {MAX_MESSAGE} characters.")
    if session_id is not None and not SESSION_RE.match(str(session_id)):
        return _error(400, "bad_request", "Invalid session id.")
    if not config.settings.ai_key:
        return _error(503, "ai_not_configured",
                      "The SPHEREx AI is not connected: put SPHEREX_AI_KEY in backend/.env and restart the backend.")
    payload = {"message": build_message(message, body.get("context"))}
    if session_id:
        payload["session_id"] = session_id

    client = httpx.AsyncClient(base_url=config.settings.ai_url, headers=_headers(), timeout=TIMEOUT)
    try:
        upstream = await client.send(client.build_request("POST", "/api/v1/chat/stream", json=payload), stream=True)
    except httpx.TimeoutException:
        await client.aclose()
        return _error(504, "ai_waking", "The AI service is waking up (free hosting). Ask again in about a minute.", True)
    except httpx.HTTPError as exc:
        await client.aclose()
        return _error(502, "ai_unreachable", f"Could not reach the AI service ({type(exc).__name__}).", True)

    if upstream.status_code != 200:
        raw = (await upstream.aread()).decode("utf-8", "replace")[:300]
        await upstream.aclose()
        await client.aclose()
        status, code, msg, retry = _UPSTREAM_MAP.get(
            upstream.status_code, (502, "ai_error", f"AI service error (HTTP {upstream.status_code}).", upstream.status_code >= 500))
        return _error(status, code, msg if code != "ai_error" else f"{msg} {raw}", retry)

    async def relay():
        try:
            async for chunk in upstream.aiter_raw():  # raw bytes in, raw bytes out: no buffering
                yield chunk
        finally:  # browser gone -> close upstream -> generation cancelled
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(relay(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


@router.post("/facts")
async def facts(body: dict = Body(...)):
    """Verified SPHEREx facts relevant to a question (and any that the answer contradicts)."""
    from .knowledge import match
    q = str(body.get("question") or "")[:MAX_MESSAGE]
    a = str(body.get("answer") or "")[:20000]
    return SafeJSONResponse({"facts": match(q, a or None)})


@router.delete("/chat/{session_id}")
async def chat_reset(session_id: str):
    if not SESSION_RE.match(session_id):
        return _error(400, "bad_request", "Invalid session id.")
    if not config.settings.ai_key:
        return SafeJSONResponse({"ok": True, "note": "AI not configured; nothing stored upstream"})
    try:
        async with httpx.AsyncClient(base_url=config.settings.ai_url, headers=_headers(), timeout=httpx.Timeout(15.0)) as c:
            r = await c.delete(f"/api/v1/chat/{session_id}")
        return SafeJSONResponse({"ok": r.status_code < 400})
    except httpx.HTTPError:
        return SafeJSONResponse({"ok": False})
