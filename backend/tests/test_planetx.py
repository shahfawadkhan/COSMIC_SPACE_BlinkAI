import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import main, planetx, sets
from app.errors import BadRequest


def test_auto_rate():
    assert planetx.auto_rate(500) == pytest.approx(2.5 * 206265 / 500 / 365)
    assert 2.7 < planetx.auto_rate(500) < 2.9


def test_add_gaussian_flux_and_place():
    img = np.zeros((40, 40), np.float32)
    planetx.add_gaussian(img, 15.3, 22.7, 5.0, 1.2)
    y, x = np.unravel_index(np.argmax(img), img.shape)
    assert (x, y) == (15, 23)
    assert img.sum() == pytest.approx(5.0 * 2 * math.pi * 1.2**2, rel=0.01)


def test_injection_puts_right_flux_at_right_place():
    p = planetx.normalize({"mode": "synthetic", "peak_snr": 10, "seed": 3})
    arrays, manifest = planetx._synthetic(p)
    p = planetx._defaults_from_set(p, manifest)
    cube, truth = planetx.inject(arrays, manifest, p)
    t = next(t for t in truth if t["injected"])
    i = t["frame"]
    added = cube[i] - arrays["frames"][i]
    y, x = np.unravel_index(np.argmax(added), added.shape)
    assert abs(x - t["x"]) <= 0.6 and abs(y - t["y"]) <= 0.6
    expected = 10 * planetx.robust_sigma(arrays["frames"][i])          # peak = S/N x local noise
    assert added.max() == pytest.approx(expected, rel=0.08)
    assert all(not t["injected"] for t in truth if t["detector"] not in (4, 5, 6))   # dark at short wavelengths


def test_recovery_succeeds_at_snr_20():
    r = planetx.run({"mode": "synthetic", "peak_snr": 20, "seed": 2}, store=False)
    s = r["summary"]
    assert r["simulated"] is True and r["label"].startswith("SIMULATED")
    assert s["n_tested"] >= 2 and s["n_recovered"] == s["n_tested"]
    assert s["mean_position_error_arcsec"] < 6.0
    rec = [p for p in r["pairs"] if p["recovered"]][0]
    assert rec["measured_shift_arcsec"] == pytest.approx(rec["expected_shift_arcsec"], abs=6.0)
    assert any("leaves the field" in (p.get("reason") or "") for p in r["pairs"])   # pass-to-pass jump


def test_recovery_fails_at_snr_1():
    r = planetx.run({"mode": "synthetic", "peak_snr": 1, "seed": 2}, store=False)
    assert r["summary"]["n_tested"] >= 2 and r["summary"]["n_recovered"] == 0
    assert r["summary"]["message"].startswith("Not recovered")


def test_validation():
    with pytest.raises(BadRequest):
        planetx.normalize({"mode": "real"})
    with pytest.raises(BadRequest):
        planetx.normalize({"mode": "real", "set_id": "simabc"})
    with pytest.raises(BadRequest):
        planetx.normalize({"mode": "synthetic", "distance_au": 50})


def test_real_set_untouched_and_sim_set_viewable(cache):
    from tests.test_views import SET_ID, make_set
    make_set(cache)
    before, _ = sets.load_stack(SET_ID)
    before = before["frames"].copy()
    c = TestClient(main.app)
    r = c.post("/api/inject", json={"set_id": SET_ID, "peak_snr": 15, "detectors": [1, 2, 3]}).json()
    sid = r["sim_set_id"]
    assert sid.startswith("sim") and r["simulated"] and r["parent_set_id"] == SET_ID
    after, _ = sets.load_stack(SET_ID)
    np.testing.assert_array_equal(after["frames"], before)                     # real set never changed
    m = sets.load_manifest(sid)
    assert m["simulated"] is True and m["source"] == "SIMULATED" and len(m["truth"]) == len(m["frames"])
    assert sets.stack_key(sid).startswith("cosmic:sim:")
    v = c.get(f"/api/sets/{sid}/view", params={"band": "1,2,3", "group_by": "visit"})
    assert v.status_code == 200 and v.json()["count"] >= 1
    img = c.get(v.json()["epochs"][0]["image_url"])
    assert img.status_code == 200 and img.headers["x-data-source"] == "SIMULATED"


def test_sweep_table():
    r = TestClient(main.app).post("/api/inject/sweep", json={"mode": "synthetic", "seed": 2}).json()
    assert len(r["rows"]) == 12 and r["simulated"]
    hi = [x for x in r["rows"] if x["peak_snr"] == 12 and x["distance_au"] == 500][0]
    lo = [x for x in r["rows"] if x["peak_snr"] == 3 and x["distance_au"] == 500][0]
    assert hi["n_recovered"] >= lo["n_recovered"]
