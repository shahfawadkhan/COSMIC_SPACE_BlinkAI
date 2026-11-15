import io

import numpy as np
import pytest
from astropy.io.votable import from_table, writeto
from astropy.table import Table

from app import irsa, net
from app.errors import BadRequest, UpstreamError

RA, DEC = 133.781, -7.241
BASE = "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1"
L2_D3 = f"{BASE}/level2/2025W45_1A/l2b/3/level2_2025W45_1A_0012_1D3_spx_l2b-v20-2025-300.fits"
L2_D1 = f"{BASE}/level2/2025W19_2B/l2b/1/level2_2025W19_2B_0182_2D1_spx_l2b-v20-2025-162.fits"


def square(ra, dec, half=0.5):
    pts = [(ra - half, dec - half), (ra + half, dec - half),
           (ra + half, dec + half), (ra - half, dec + half)]
    return "POLYGON ICRS " + " ".join(f"{a % 360:.6f} {b:.6f}" for a, b in pts)


def fake_votable() -> bytes:
    rows = [
        (L2_D3, 60990.0, 60990.2, square(RA, DEC)),            # later, contains target
        (L2_D1, 60800.0, 60800.1, square(RA + 3, DEC)),        # earlier, misses target
        (f"{BASE}/level1/x/level1_2025W19_2B_0182_2D1.fits", 60800.0, 60800.1, square(RA, DEC)),
        (f"{BASE}/level2/x/level2_2025W19_2B_0182_2D1_spx.png", 60800.0, 60800.1, square(RA, DEC)),
        (L2_D3, 60990.0, 60990.2, square(RA, DEC)),            # duplicate
    ]
    t = Table(rows=rows, names=("access_url", "t_min", "t_max", "s_region"),
              dtype=(str, np.float64, np.float64, str))
    buf = io.BytesIO()
    writeto(from_table(t), buf)
    return buf.getvalue()


class FakeResp:
    def __init__(self, content=b"", status=200):
        self.content = content
        self.status_code = status


@pytest.fixture
def fake_http(monkeypatch):
    calls = []
    payload = {"content": fake_votable(), "status": 200}

    def request(method, url, timeout=None, **kw):
        calls.append((method, url, kw.get("params")))
        return FakeResp(payload["content"], payload["status"])

    monkeypatch.setattr(net.session, "request", request)
    return calls, payload


def test_parse_filename():
    info = irsa.parse_filename(L2_D1 + "?center=1,2")
    assert info["detector"] == 1
    assert info["planning_period"] == "2025W19_2B"
    assert info["obs_id"] == "2025W19_2B_0182_2"


def test_s_region_and_contains():
    poly = irsa.parse_s_region(square(RA, DEC))
    assert len(poly) == 4
    assert irsa.footprint_contains(poly, RA, DEC)
    assert not irsa.footprint_contains(poly, RA + 2, DEC)
    wrap = irsa.parse_s_region("POLYGON 359.5 10 0.5 10 0.5 11 359.5 11")  # across RA = 0
    assert irsa.footprint_contains(wrap, 0.1, 10.5)
    assert irsa.footprint_contains(wrap, 359.9, 10.5)
    assert not irsa.footprint_contains(wrap, 1.0, 10.5)
    assert irsa.parse_s_region("CIRCLE 1 2 3") is None


def test_search_parses_filters_sorts_and_caches(cache, fake_http):
    calls, _ = fake_http
    out = irsa.search(RA, DEC, 0.05)
    assert calls[0][2] == {"COLLECTION": "spherex_dr1",
                           "POS": "circle 133.7810000 -7.2410000 0.0500000"}
    assert out["count"] == 2
    assert out["source"] == "NASA IRSA DATA"
    obs = out["observations"]
    assert [o["detector"] for o in obs] == [1, 3]  # sorted by date
    assert obs[0]["mjd"] == pytest.approx(60800.05)
    assert obs[0]["contains_target"] is False
    assert obs[1]["contains_target"] is True
    assert out["count_containing_target"] == 1
    assert out["cached"] is False

    again = irsa.search(RA, DEC, 0.05)
    assert again["cached"] is True
    assert len(calls) == 1


def test_search_upstream_error_and_breaker(cache, fake_http, monkeypatch):
    monkeypatch.setattr(net.time, "sleep", lambda s: None)
    calls, payload = fake_http
    payload["status"] = 502
    with pytest.raises(UpstreamError) as e:
        irsa.search(RA, DEC, 0.05)
    assert "HTTP 502" in e.value.message
    with pytest.raises(UpstreamError) as e2:
        irsa.search(RA, DEC, 0.06)
    assert "skipped" in e2.value.message
    assert len(calls) == 3  # 1 try + 2 retries on 502; second search skipped by the breaker


def test_search_falls_back_to_saved_list_when_irsa_down(cache, fake_http, monkeypatch):
    monkeypatch.setattr(net.time, "sleep", lambda s: None)
    first = irsa.search(RA, DEC, 0.05)  # IRSA up: saved to disk
    assert first["count"] > 0 and not first.get("stale")
    _, payload = fake_http
    payload["status"] = 502
    net.breaker.reset()
    later = irsa.search(RA + 0.002, DEC, 0.05, use_cache=False)  # 7″ away, IRSA down
    assert later["stale"] is True and later["count"] == first["count"]
    assert later["query"]["ra"] == pytest.approx(RA)
    with pytest.raises(UpstreamError) as e:  # nothing saved this far away
        irsa.search(RA + 1.0, DEC, 0.05, use_cache=False)
    assert "NASA" in e.value.message


def test_busy_reply_waits_and_retries_once(cache, fake_http, monkeypatch):
    waits = []
    monkeypatch.setattr(net.time, "sleep", waits.append)
    calls, payload = fake_http
    payload["status"] = 503
    with pytest.raises(UpstreamError):
        irsa.search(RA, DEC, 0.05)
    assert len(calls) == 2 and waits == [2.0]


def test_bad_votable(cache, fake_http):
    _, payload = fake_http
    payload["content"] = b"<html>oops</html>"
    with pytest.raises(UpstreamError):
        irsa.search(RA, DEC, 0.05)


@pytest.mark.parametrize("ra,dec,r", [(-1, 0, 0.1), (360, 0, 0.1), (10, 91, 0.1), (10, 0, 0), (10, 0, 2)])
def test_validation(cache, ra, dec, r):
    with pytest.raises(BadRequest):
        irsa.search(ra, dec, r)
