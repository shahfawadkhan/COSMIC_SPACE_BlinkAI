import numpy as np
import pytest

from app import fitsstream, irsa
from app.net import AdaptiveGate
from tests.fakes import FakeStreamResponse, make_cutout_fits

RA, DEC = 133.758, -7.242
URL = "https://irsa/level2/p/level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits"
OBS = {"url": URL, "detector": 3, "obs_id": "2025W19_1B_0116_1", "mjd": 60800.5}


def test_stream_prefix_stops_before_epsf():
    data = make_cutout_fits(RA, DEC, epsf_rows=300)
    chunks = (data[i:i + 4096] for i in range(0, len(data), 4096))
    prefix, names = fitsstream.read_hdus_prefix(chunks, {"IMAGE", "FLAGS", "VARIANCE", "ZODI"})
    assert names == ["PRIMARY", "IMAGE", "FLAGS", "VARIANCE", "ZODI"]
    assert len(prefix) < 0.05 * len(data)
    full, names_full = fitsstream.read_hdus_prefix([data], None)
    assert full == data and names_full[-2:] == ["EPSF", "WCS-WAVE"]
    with pytest.raises(fitsstream.FitsStreamError):
        fitsstream.read_hdus_prefix([data[:5000]], {"ZODI"})


@pytest.fixture
def fake_get(monkeypatch):
    state = {"responses": [], "calls": []}

    def get(url, stream=False, timeout=None):
        state["calls"].append(url)
        resp = state["responses"].pop(0) if state["responses"] else state["default"]()
        state.setdefault("served", []).append(resp)
        return resp

    monkeypatch.setattr(irsa.session, "get", get)
    monkeypatch.setattr(irsa.time, "sleep", lambda s: None)
    return state


def test_fetch_cutout_processing_and_cache(cache, fake_get):
    data = make_cutout_fits(RA, DEC, bad_pixel=(10, 12), source_pixel=(23, 23))
    fake_get["default"] = lambda: FakeStreamResponse(data)
    res = irsa.fetch_cutout(OBS, RA, DEC, 0.08)
    assert not res["cached"]
    assert "center=133.758000,-7.242000&size=0.08000" in fake_get["calls"][0]
    m = res["meta"]
    assert m["full_file"] is True                        # first frame of detector 3: get WCS-WAVE
    assert m["wavelength_um"] == pytest.approx(2.0 + 0.0002 * (24 + 100), abs=0.02)
    assert m["target_inside"] and m["target_pix"][0] == pytest.approx(23, abs=0.01)
    assert m["mjd"] == 60800.5

    arrays, _ = cache.load_arrays(res["key"])
    img = arrays["image"]
    assert img.dtype == np.float32
    assert np.isnan(img[12, 10]) and np.isnan(arrays["variance"][12, 10])   # HOT masked
    assert np.isfinite(img[23, 23])                                          # SOURCE not masked
    assert abs(np.nanmedian(img)) < 0.01                                     # zodi removed
    assert arrays["flags"].dtype == np.uint32 and arrays["flags"][0, 0] == 2**31
    assert "SOURCE" in m["flags_at_target"]

    again = irsa.fetch_cutout(OBS, RA, DEC, 0.08)
    assert again["cached"] and len(fake_get["calls"]) == 1

    # second detector-3 frame: wave table cached -> stream stops early
    obs2 = {**OBS, "url": URL.replace("0116", "0117")}
    res2 = irsa.fetch_cutout(obs2, RA, DEC, 0.08)
    assert res2["meta"]["full_file"] is False
    assert fake_get["served"][-1].bytes_sent < len(data) * 0.2
    assert fake_get["served"][-1].closed
    assert res2["meta"]["wavelength_um"] is not None


def test_retry_policy(cache, fake_get):
    data = make_cutout_fits(RA, DEC, wave=False)
    gate = AdaptiveGate(4)
    fake_get["responses"] = [FakeStreamResponse(b"busy", 503, {"Retry-After": "0"}),
                             FakeStreamResponse(b"", 500)]
    fake_get["default"] = lambda: FakeStreamResponse(data)
    res = irsa.fetch_cutout_with_retry(OBS, RA, DEC, 0.08, gate=gate)
    assert "error" not in res
    assert gate.status()["busy_replies"] == 1 and gate.limit < 4

    fake_get["responses"] = []
    fake_get["default"] = lambda: FakeStreamResponse(b"", 404)
    bad = irsa.fetch_cutout_with_retry({**OBS, "url": URL.replace("0116", "0999")}, RA, DEC, 0.08, gate=gate)
    assert bad["error"] == "HTTP 404"
    assert len([c for c in fake_get["calls"] if "0999" in c]) == 2       # retried once


def test_gate_backs_off_and_recovers():
    g = AdaptiveGate(8)
    assert g.acquire()
    g.release("busy", 0.0)
    assert g.limit == 4
    for _ in range(40):
        g.acquire()
        g.release("ok")
    assert g.limit == 8
