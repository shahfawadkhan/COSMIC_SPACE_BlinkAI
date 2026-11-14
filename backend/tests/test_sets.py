import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import config, irsa, main, sets
from app.errors import BadRequest
from app.jobs import Job, JobManager
from tests.fakes import FakeStreamResponse, make_cutout_fits, parse_center

RA, DEC = 133.758, -7.242


def fake_observations():
    out = []
    for p, base in enumerate((60800.0, 60990.0, 61170.0)):
        for d in range(1, 7):
            for k in range(3):
                obs_id = f"2025W{19 + p}_1B_{100 + k:04d}_1"
                url = (f"https://irsa/level2/p/{d}/level2_2025W{19 + p}_1B_{100 + k:04d}_1D{d}"
                       f"_spx_l2b-v27-2026-197.fits")
                out.append({"url": url, "mjd": base + k + d * 0.01, "detector": d, "obs_id": obs_id,
                            "planning_period": f"2025W{19 + p}_1B", "file_name": url.rsplit("/", 1)[-1],
                            "contains_target": True})
    return out


@pytest.fixture
def fake_irsa(cache, monkeypatch):
    monkeypatch.setattr(config.settings, "cpu_workers", 0)
    monkeypatch.setattr(config.settings, "http_workers", 4)
    monkeypatch.setattr(irsa.time, "sleep", lambda s: None)
    obs = fake_observations()
    calls = {"search": 0, "get": []}

    def search(ra, dec, radius_deg, collections=None, use_cache=True):
        calls["search"] += 1
        return {"count": len(obs), "observations": obs}

    def get(url, stream=False, timeout=None):
        calls["get"].append(url)
        if "_1D5" in url and "2025W20" in url:
            return FakeStreamResponse(b"", 500)               # epoch 1, detector 5: always fails
        ra, dec, size = parse_center(url)
        n = int(round(size / (6.2 / 3600)))
        return FakeStreamResponse(make_cutout_fits(ra, dec, n=n, star=(ra, dec, 5.0), epsf_rows=20,
                                                   seed=len(calls["get"])))

    monkeypatch.setattr(irsa, "search", search)
    monkeypatch.setattr(irsa.session, "get", get)
    monkeypatch.setattr(sets, "jobs", JobManager())
    return calls


def wait_done(set_id, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = sets.get_set_status(set_id)
        if st["state"] in ("done", "error"):
            return st
        time.sleep(0.05)
    raise AssertionError("set did not finish")


def test_normalize_and_same_id():
    a = sets.normalize_request({"ra": 133.75801, "dec": -7.24199})
    b = sets.normalize_request({"ra": "133.758", "dec": -7.242, "fov_arcmin": 4, "upsample": 2,
                                "max_frames": 40, "collections": "spherex_dr1"})
    assert a == b and sets.set_id_for(a) == sets.set_id_for(b)
    assert sets.set_id_for({**a, "upsample": 4}) != sets.set_id_for(a)
    for bad in ({"ra": 1}, {"ra": 1, "dec": 95}, {"ra": 1, "dec": 0, "fov_arcmin": 60},
                {"ra": 1, "dec": 0, "upsample": 5}, {"ra": 1, "dec": 0, "max_frames": 2}):
        with pytest.raises(BadRequest):
            sets.normalize_request(bad)


def test_build_set_end_to_end(fake_irsa, cache):
    started = sets.start_set({"ra": RA, "dec": DEC, "fov_arcmin": 3, "max_frames": 24})
    sid = started["set_id"]
    st = wait_done(sid)
    assert st["state"] == "done", st
    m = st["set"]
    assert m["source"] == "NASA IRSA DATA"
    assert m["counts"]["selected"] == 24
    assert m["counts"]["full_files"] == 6         # one WCS-WAVE fetch per detector, not one per frame
    n_skip = m["counts"]["skipped"]
    assert n_skip in (1, 2) and all(s["reason"] == "HTTP 500" and s["detector"] == 5 for s in m["skipped"])
    assert m["complete"] is False                 # transient failure -> short TTL
    assert m["counts"]["kept"] == 24 - n_skip
    assert len(m["epochs"]) == 3
    assert m["epochs"][0]["detectors_used"] == [1, 2, 3, 4, 5, 6]
    assert m["epochs"][1]["missing_detectors"] == [5]
    assert set(m["timings_s"]) >= {"search", "download", "reproject_cpu", "stack", "total"}
    assert m["center"]["label"].startswith("RA 08h 55m")
    assert all(f["wavelength_um"] is not None for f in m["frames"])
    assert [f["mjd"] for f in m["frames"]] == sorted(f["mjd"] for f in m["frames"])

    arrays, meta = sets.load_stack(sid)
    n = m["grid"]["n"]
    assert arrays["frames"].shape == (24 - n_skip, n, n) and arrays["frames"].dtype == np.float32
    assert arrays["epoch_stack"].shape == (3, 6, n, n)
    assert arrays["epoch_count"].sum() == 24 - n_skip
    c = n // 2
    assert np.nanargmax(arrays["epoch_stack"][0, 0]) in {c * n + c + dx + dy * n
                                                         for dx in (-1, 0, 1) for dy in (-1, 0, 1)}

    # Each failed frame: initial try + one retry, then skipped
    assert sum("_1D5" in u and "2025W20" in u for u in fake_irsa["get"]) == 2 * n_skip

    # Same request again: no new downloads
    n_calls = len(fake_irsa["get"])
    again = sets.start_set({"ra": RA, "dec": DEC, "fov_arcmin": 3, "max_frames": 24})
    assert again["set_id"] == sid and again["state"] == "done"
    assert len(fake_irsa["get"]) == n_calls


def test_rebuild_uses_cached_cutouts(fake_irsa, cache):
    sid = sets.start_set({"ra": RA, "dec": DEC, "fov_arcmin": 3, "max_frames": 12})["set_id"]
    wait_done(sid)
    first = len(fake_irsa["get"])
    cache.delete(sets.manifest_key(sid))
    cache.delete(sets.stack_key(sid))
    sets.jobs._jobs.clear()
    sets.start_set({"ra": RA, "dec": DEC, "fov_arcmin": 3, "max_frames": 12})
    m = wait_done(sid)["set"]
    assert m["counts"]["from_cache"] == m["counts"]["selected"] - m["counts"]["skipped"]
    assert len(fake_irsa["get"]) - first <= 4     # only the failing frames are retried


def test_no_images(cache, monkeypatch):
    monkeypatch.setattr(irsa, "search", lambda *a, **k: {"count": 0, "observations": []})
    monkeypatch.setattr(sets, "jobs", JobManager())
    sid = sets.start_set({"ra": 10, "dec": 10})["set_id"]
    st = wait_done(sid)
    assert st["state"] == "error" and st["error"]["code"] == "not_found"


def test_api_endpoints(fake_irsa):
    client = TestClient(main.app)
    r = client.post("/api/sets", json={"ra": RA, "dec": DEC, "fov_arcmin": 3, "max_frames": 12})
    assert r.status_code == 202
    sid = r.json()["set_id"]
    wait_done(sid)
    body = client.get(f"/api/sets/{sid}").json()
    assert body["state"] == "done" and body["set"]["set_id"] == sid
    assert client.get("/api/sets/sdoesnotexist").status_code == 404
    assert client.post("/api/sets", json={"ra": 1}).status_code == 400
    t = client.get("/api/targets").json()["targets"]
    assert len(t) == 5 and t[0]["today"]["label"].startswith("RA ")


def test_job_progress_eta():
    j = Job("x", "set", {})
    j.set_stage("downloading", total=10)
    j.progress(5)
    d = j.to_dict()
    assert d["stage"] == "downloading" and d["progress"] == {"done": 5, "total": 10}
    assert d["eta_s"] is not None and d["eta_s"] >= 0
