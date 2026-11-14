import math
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import catalog, config, irsa, main, sets
from app import spectrum as sp
from app.errors import BadRequest
from tests.fakes import cutout_wcs

RA, DEC = 150.0, 20.0
PIX = 6.2 / 3600.0
OMEGA = (PIX * math.pi / 180) ** 2  # sr per pixel


def star_image(n=31, x=15.3, y=14.8, total_mjy=2.0, sigma=0.9, noise=1e-4, sky=0.05, seed=0):
    """Gaussian star whose total flux is `total_mjy`, on a flat sky, in MJy/sr."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:n, 0:n]
    peak_sb = total_mjy / 1e9 / OMEGA / (2 * math.pi * sigma**2)   # MJy/sr
    img = sky + peak_sb * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma**2)) + rng.normal(0, noise, (n, n))
    return img.astype(np.float32), np.full((n, n), noise**2, np.float32), np.zeros((n, n), np.uint32)


def header_at(ra, dec, n=31, rot=20.0):
    return cutout_wcs(ra, dec, n, rot).to_header().tostring()


def test_measure_recovers_flux_and_position():
    w = cutout_wcs(RA, DEC, 31, 20.0)
    sra, sdec = (float(v) for v in w.pixel_to_world_values(15.3, 14.8))
    img, var, flags = star_image()
    m = sp.measure(img, var, flags, header_at(RA, DEC), sra, sdec, 18.0)
    assert m["status"] == "ok"
    assert m["flux_mjy"] == pytest.approx(2.0, rel=0.03)          # wide aperture: nearly all the flux
    assert m["snr"] > 50
    assert m["centroid_x"] == pytest.approx(15.3, abs=0.1) and m["centroid_y"] == pytest.approx(14.8, abs=0.1)
    assert m["pixel_arcsec"] == pytest.approx(6.2, rel=1e-3)


def test_saturated_core_reported():
    w = cutout_wcs(RA, DEC, 31, 20.0)
    sra, sdec = (float(v) for v in w.pixel_to_world_values(15.0, 15.0))
    img, var, flags = star_image(x=15.0, y=15.0, total_mjy=500)
    img[14:17, 14:17] = np.nan
    flags[14:17, 14:17] |= 1 << config.FLAG_BITS["OVERFLOW"]
    m = sp.measure(img, var, flags, header_at(RA, DEC), sra, sdec, 12.0)
    assert m["status"] == "saturated"
    assert m["reason"] == "no usable measurement – star saturated"


def test_outside_and_masked_sky():
    img, var, flags = star_image()
    far = sp.measure(img, var, flags, header_at(RA, DEC), RA + 0.05, DEC, 12.0)
    assert far["status"] == "outside"


def test_propagate_and_fit_motion():
    ra, dec = sp.propagate(RA, DEC, 3600.0, -1800.0, 2000.0, 2010.0)
    assert (dec - DEC) * 3600 == pytest.approx(-18.0)
    assert (ra - RA) * math.cos(math.radians(DEC)) * 3600 == pytest.approx(36.0, rel=1e-6)
    rows = []
    for k, t in enumerate(np.linspace(2025.3, 2026.4, 8)):
        cra, cdec = sp.propagate(RA, DEC, -5000.0, 1000.0, 2025.0, t)
        rows.append({"jyear": t, "centroid_ra": cra, "centroid_dec": cdec + (0.1 if k % 2 else -0.1) / 3600})
    fit = sp.fit_motion(rows, RA, DEC)
    assert fit["pmra_mas_yr"] == pytest.approx(-5000, abs=5) and fit["pmdec_mas_yr"] == pytest.approx(1000, abs=300)
    assert sp.fit_motion(rows[:2], RA, DEC) is None


def test_normalize():
    p = sp.normalize({"ra": 361.0, "dec": 10, "set_id": "sabc"})
    assert p["ra"] == 1.0 and p["aperture_arcsec"] == 12.0 and p["max_frames"] == 40
    assert sp.job_id_for(p) == sp.job_id_for(dict(p))
    for bad in ({"ra": 1}, {"ra": 1, "dec": 99}, {"ra": 1, "dec": 0, "aperture_arcsec": 100}):
        with pytest.raises(BadRequest):
            sp.normalize(bad)


@pytest.fixture
def fake_set(cache, monkeypatch):
    """A built set whose cutouts are on disk: 3 epochs, the star brightening, plus a Gaia neighbour."""
    set_id = "sphot0000000001"
    size = 4 / 60 * 1.2
    frames = []
    for k, mjd in enumerate((60800.0, 60990.0, 61170.0)):
        url = f"https://irsa/level2/x/level2_2025W1{k}_1A_0001_1D3_spx_l2b-v27-2026-197.fits"
        img, var, flags = star_image(total_mjy=1.0 + k, seed=k)
        hdr = header_at(RA, DEC)
        w = cutout_wcs(RA, DEC, 31, 20.0)
        sx, sy = (float(v) for v in w.world_to_pixel_values(RA, DEC))
        img2, _, _ = star_image(x=sx, y=sy, total_mjy=1.0 + k, seed=k)
        meta = {"url": url, "detector": 3, "mjd": mjd, "header": hdr, "obs_id": f"o{k}", "pipeline_version": "v27"}
        cache.save_arrays(irsa.cutout_key(url, RA, DEC, size), {"image": img2, "variance": var, "flags": flags}, meta=meta)
        frames.append({"url": url, "detector": 3, "mjd": mjd, "obs_id": f"o{k}", "epoch": k})
    manifest = {"set_id": set_id, "request": {"ra": RA, "dec": DEC, "fov_arcmin": 4.0}, "cutout_size_deg": size,
                "frames": frames, "complete": True}
    cache.set_json(sets.manifest_key(set_id), manifest, ttl=3600)
    gaia_rows = [{"id": "Gaia DR3 1", "ra": RA + 10 / 3600 / math.cos(math.radians(DEC)), "dec": DEC,
                  "pmra": 0.0, "pmdec": 0.0, "mag": 15.0, "epoch": 2016.0}]
    monkeypatch.setattr(catalog, "cone", lambda *a, **k: {"provider": "fake Gaia", "sources": gaia_rows})
    monkeypatch.setattr(sp, "jobs", __import__("app.jobs", fromlist=["JobManager"]).JobManager())
    return set_id


def test_endpoint_uses_set_cutouts_and_csv(fake_set, monkeypatch):
    def no_download(*a, **k):
        raise AssertionError("must not download")

    monkeypatch.setattr(irsa, "fetch_cutout_with_retry", no_download)
    c = TestClient(main.app)
    params = {"ra": RA, "dec": DEC, "set_id": fake_set, "aperture_arcsec": 12}
    t0 = time.time()
    while True:
        r = c.get("/api/spectrum", params=params).json()
        if r["state"] in ("done", "error") or time.time() - t0 > 30:
            break
        time.sleep(0.05)
    assert r["state"] == "done", r
    res = r["result"]
    assert res["source"] == "NASA IRSA DATA" and "on disk" in res["frames_from"]
    fl = [x["flux_mjy"] for x in res["rows"]]
    assert fl[0] < fl[1] < fl[2]                                # brightening is measured
    assert all(x["status"] == "ok" for x in res["rows"])
    assert res["summary"]["n_blended"] == 3                     # Gaia star 10" away overlaps a 12" aperture
    assert "Gaia star" in res["summary"]["blend_message"]
    csv_r = c.get("/api/spectrum.csv", params=params)
    assert csv_r.status_code == 200 and csv_r.headers["content-type"].startswith("text/csv")
    lines = csv_r.text.strip().splitlines()
    assert lines[0].startswith("# COSMIC") and lines[1].startswith("date,mjd,detector")
    assert len(lines) == 2 + 3
    # same request again: served from cache instantly
    assert c.get("/api/spectrum", params=params).json()["state"] == "done"


def test_csv_before_ready(cache):
    c = TestClient(main.app)
    assert c.get("/api/spectrum.csv", params={"ra": 10, "dec": 10}).status_code == 404
