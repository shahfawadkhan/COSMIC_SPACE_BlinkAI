import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import irsa, main
from app.cache import make_key
from app.errors import UpstreamError
from app.jsonutil import dumps, to_jsonable


@pytest.fixture
def client(cache):
    return TestClient(main.app)


def test_health(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["redis"] == "connected"


def test_health_redis_down(disk_cache):
    assert TestClient(main.app).get("/api/health").json()["redis"] == "down"


def test_config(client):
    body = client.get("/api/config").json()
    assert body["spherex_collections"] == ["spherex_dr1"]
    assert len(body["detectors"]) == 6
    assert body["flag_bits"]["SOURCE"] == 21
    assert not body["bad_flag_mask"] & (1 << 21)
    assert body["bad_flag_mask"] & (1 << 0) and body["bad_flag_mask"] & (1 << 19)


def test_observations_nan_safe(client, monkeypatch):
    def fake_search(ra, dec, radius_deg):
        return {"ra": ra, "radius_deg": radius_deg, "x": float("nan"), "y": np.float32("inf")}

    monkeypatch.setattr(irsa, "search", fake_search)
    r = client.get("/api/observations", params={"ra": 133.781, "dec": -7.241, "radius_arcsec": 36})
    assert r.status_code == 200
    body = r.json()
    assert body["x"] is None and body["y"] is None
    assert body["radius_deg"] == pytest.approx(0.01)


def test_observations_errors(client, monkeypatch):
    r = client.get("/api/observations", params={"ra": 400, "dec": 0})
    assert r.status_code == 400 and r.json()["code"] == "bad_request"
    assert client.get("/api/observations", params={"dec": 0}).status_code == 400

    def boom(*a, **k):
        raise UpstreamError("IRSA SIA unavailable: timed out")

    monkeypatch.setattr(irsa, "search", boom)
    r = client.get("/api/observations", params={"ra": 10, "dec": 0})
    assert r.status_code == 502
    assert r.json() == {"code": "upstream_error", "message": "IRSA SIA unavailable: timed out"}


def test_cache_endpoints(client, cache):
    cache.set_bytes(make_key("render", "a"), b"x", ttl=60)
    stats = client.get("/api/cache/stats").json()
    assert stats["redis"]["status"] == "connected"
    assert stats["disk"]["namespaces"]["render"]["files"] == 1
    r = client.post("/api/cache/clear", params={"scope": "renders"})
    assert r.status_code == 200 and r.json()["disk_files_deleted"] == 1
    assert client.post("/api/cache/clear", params={"scope": "nope"}).status_code == 400


def test_jsonutil():
    assert to_jsonable({"a": np.float64("nan"), "b": [np.int64(3), np.bool_(True)]}) == {
        "a": None, "b": [3, True]}
    assert dumps(float("-inf")) == "null"
