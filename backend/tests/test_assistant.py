import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import assistant, config, main

SSE = (b'event: start\ndata: {"session_id": "s1"}\n\n'
       b': keepalive\n\n'
       b'event: token\ndata: {"content": "SPHEREx maps "}\n\n'
       b'event: token\ndata: {"content": "the sky."}\n\n'
       b'event: sources\ndata: {"items": [{"id": "S1", "document": "Guide", "cited": true}]}\n\n'
       b'event: done\ndata: {"session_id": "s1", "metadata": {"answer_basis": "retrieved_documentation"}}\n\n')


@pytest.fixture
def upstream(monkeypatch):
    """Replace the network with a mock of the AI service; record what we sent."""
    seen = {"requests": [], "mode": "ok"}

    def handler(request: httpx.Request):
        seen["requests"].append(request)
        if request.url.path == "/health":
            if seen["mode"] == "timeout":
                raise httpx.ConnectTimeout("slow", request=request)
            return httpx.Response(200, json={"status": "healthy", "llm_configured": True})
        if request.url.path == "/api/v1/chat/stream":
            if seen["mode"] in (401, 429):
                return httpx.Response(seen["mode"], json={"error": {"code": "x", "message": "y"}})
            return httpx.Response(200, stream=httpx.ByteStream(SSE), headers={"content-type": "text/event-stream"})
        if request.method == "DELETE":
            return httpx.Response(204)
        return httpx.Response(404)

    real = httpx.AsyncClient

    def factory(*a, **k):
        k["transport"] = httpx.MockTransport(handler)
        return real(*a, **k)

    monkeypatch.setattr(assistant.httpx, "AsyncClient", factory)
    monkeypatch.setattr(config.settings, "ai_key", "secret-key")
    assistant._status_cache.update(at=0.0, value=None)
    return seen


def test_not_configured(monkeypatch):
    monkeypatch.setattr(config.settings, "ai_key", "")
    r = TestClient(main.app).post("/api/assistant/chat/stream", json={"message": "hi"})
    assert r.status_code == 503 and r.json()["code"] == "ai_not_configured"


def test_validation(upstream):
    c = TestClient(main.app)
    assert c.post("/api/assistant/chat/stream", json={"message": "  "}).status_code == 400
    assert c.post("/api/assistant/chat/stream", json={"message": "x" * 4001}).json()["code"] == "message_too_long"
    assert c.post("/api/assistant/chat/stream", json={"message": "hi", "session_id": "bad id!"}).status_code == 400


def test_stream_relayed_with_key_and_context(upstream):
    c = TestClient(main.app)
    r = c.post("/api/assistant/chat/stream", json={"message": "What is SPHEREx?", "session_id": "cosmic_abc", "context": "Target: WISE 0855"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    assert r.content == SSE                                       # byte for byte
    req = upstream["requests"][-1]
    assert req.headers["X-API-Key"] == "secret-key"               # key added server-side only
    sent = json.loads(req.content)
    assert sent["session_id"] == "cosmic_abc"
    # question first (the service searches its documents with it), context after
    assert sent["message"].startswith("What is SPHEREx?") and "Screen context from the COSMIC app" in sent["message"]
    assert set(sent) == {"message", "session_id"}                # the service rejects unknown fields


@pytest.mark.parametrize("code,status,ours", [(401, 502, "ai_key_rejected"), (429, 429, "ai_rate_limited")])
def test_upstream_errors_mapped(upstream, code, status, ours):
    upstream["mode"] = code
    r = TestClient(main.app).post("/api/assistant/chat/stream", json={"message": "hi"})
    assert r.status_code == status and r.json()["code"] == ours


def test_status_ok_and_waking(upstream):
    c = TestClient(main.app)
    s = c.get("/api/assistant/status").json()
    assert s == {**s, "service": "ok", "configured": True, "llm_configured": True}
    upstream["mode"] = "timeout"
    assistant._status_cache.update(at=0.0, value=None)
    assert c.get("/api/assistant/status").json()["service"] == "waking"


def test_reset(upstream):
    assert TestClient(main.app).delete("/api/assistant/chat/cosmic_abc").json() == {"ok": True}


def test_build_message_limits():
    m = assistant.build_message("q" * 3990, "c" * 5000)
    assert len(m) <= 4000
    assert assistant.build_message("  hello ", None) == "hello"


def test_facts_match_and_contradiction():
    from app.knowledge import match
    assert "class" in [f["id"] for f in match("What is SPHEREx?")]
    f = match("When did SPHEREx launch?", "SPHEREx is scheduled to launch in early 2025.")
    assert f[0]["id"] == "launch" and f[0]["contradicted"] is True
    assert match("When did SPHEREx launch?", "It launched in March 2025.")[0]["contradicted"] is False
    assert any(x["id"] == "bands" for x in match("how many spectral channels"))
    assert match("hello there") == []
    r = TestClient(main.app).post("/api/assistant/facts", json={"question": "is it a small explorer?", "answer": "a NASA Small Explorer (SMEX)"}).json()
    assert r["facts"][0]["id"] == "class" and r["facts"][0]["contradicted"]
