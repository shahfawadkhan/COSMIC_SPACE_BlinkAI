import io
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import main, reproject, sets, views
from app.errors import BadRequest, NotFound

RA, DEC = 133.758, -7.242
SET_ID = "stestset00000001"


def gauss(n, x, y, amp, s=1.5):
    yy, xx = np.mgrid[0:n, 0:n]
    return amp * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * s * s))


def make_set(cache, *, epochs=(60800.0, 60990.0, 61170.0), dets=(1, 2, 3, 4, 5, 6),
             per=2, skip=()):
    """Synthetic set: a static star at the centre, a mover stepping 4 px east->west per epoch.
    Detector d scales the flux by d (bands have different brightness)."""
    w, n, pix = reproject.make_grid_wcs(RA, DEC, 3.0, 2)
    rng = np.random.default_rng(0)
    frames, imgs, vars_ = [], [], []
    for e, mjd0 in enumerate(epochs):
        for d in dets:
            if (e, d) in skip:
                continue
            for k in range(per):
                img = rng.normal(0, 0.01, (n, n)) + gauss(n, n // 2, n // 2, 0.5 * d) \
                    + gauss(n, 20 + 4 * e, 10, 0.3 * d)
                imgs.append(img.astype(np.float32))
                vars_.append(np.full((n, n), 1e-4 * d, np.float32))
                frames.append({"index": len(frames), "epoch": e, "detector": d, "obs_id": f"o{e}{d}{k}",
                               "mjd": mjd0 + k + d * 0.1, "wavelength_um": 0.8 * d + 0.01 * k,
                               "flags_at_target": ["SOURCE"] if k == 0 else []})
    manifest = {"set_id": SET_ID, "source": "NASA IRSA DATA", "frames": frames,
                "center": {"label": "x"}, "units": "MJy/sr",
                "grid": {"n": n, "pix_arcsec": pix, "fov_arcmin": 3.0, "upsample": 2,
                         "wcs": dict(w.to_header())}}
    cache.save_arrays(sets.stack_key(SET_ID), {"frames": np.stack(imgs), "variance": np.stack(vars_)},
                      meta=manifest)
    cache.set_json(sets.manifest_key(SET_ID), manifest, ttl=3600)
    views._views.clear()
    return manifest


def test_group_frames_by_gap():
    frames = [{"mjd": m} for m in (100, 101, 140, 300, 129.5)]
    assert views.group_frames(frames) == [[0, 1, 4, 2], [3]]


def test_stored_epochs_win_over_gap_rule():
    # One survey pass whose SELECTED frames happen to be 40 days apart stays one epoch.
    frames = [{"mjd": 100, "epoch": 0}, {"mjd": 140, "epoch": 0}, {"mjd": 300, "epoch": 1}]
    assert views.epoch_groups(frames) == [[0, 1], [2]]
    assert views.epoch_groups([{"mjd": 100}, {"mjd": 140}]) == [[0], [1]]


def test_background_mesh_removes_gradient_keeps_star():
    n = 79
    yy, xx = np.mgrid[0:n, 0:n]
    img = (0.5 + 0.01 * xx + 0.005 * yy + gauss(n, 40, 40, 3.0)).astype(np.float32)
    img[5:8, 5:8] = np.nan
    out = views.subtract_background(img[None], "mesh")[0]
    assert abs(np.nanmedian(out)) < 0.01
    assert np.nanpercentile(np.abs(out[gauss(n, 40, 40, 1.0) < 1e-3]), 95) < 0.03
    assert out[40, 40] == pytest.approx(3.0, abs=0.1)
    assert np.isnan(out[6, 6])


def test_all_band_strict_coverage(cache):
    make_set(cache)
    arrays, manifest = sets.load_stack(SET_ID)
    arrays = dict(arrays)
    cube = arrays["frames"].copy()
    for i, f in enumerate(manifest["frames"]):
        if f["detector"] == 2:
            cube[i, 3:6, 3:6] = np.nan          # detector 2 has a hole
    arrays["frames"] = cube
    v = views.build_view(arrays, manifest, "all", "epoch")
    assert np.isfinite(v.images[0][4, 4])       # one small detector missing: still shown
    for i, f in enumerate(manifest["frames"]):
        if f["detector"] in (1, 3):             # weights ∝ 1/d: 1, 2, 3 hold 75 % of the weight
            cube[i, 3:6, 3:6] = np.nan
    v = views.build_view(arrays, manifest, "all", "epoch")
    assert np.isnan(v.images[0][4, 4])          # most of the weight missing: hole
    assert np.isfinite(v.images[0][10, 10])


def test_band_view(cache):
    make_set(cache)
    v = views.get_view(SET_ID, 3)
    assert len(v.groups) == 3 and v.detectors_used == [3]
    g = v.groups[1]
    assert g["n_frames"] == 2 and g["detectors"] == [3]
    assert g["wavelength_um"] == [pytest.approx(2.4), pytest.approx(2.41)]
    assert g["flags_at_target"] == ["SOURCE"]
    n = v.images[0].shape[0]
    assert v.images[0][n // 2, n // 2] == pytest.approx(1.5, abs=0.02)   # 0.5 × detector 3
    assert np.nanmedian(v.variances[0]) == pytest.approx(1.5e-4, rel=1e-3)   # two frames combined


def test_all_band_fixed_weights_like_with_like(cache):
    # epoch 2 has an extra-bright detector-6 frame count doubled; and detector 4 missing in epoch 1
    make_set(cache, skip={(1, 4)})
    v = views.get_view(SET_ID, "all")
    assert v.detectors_used == [1, 2, 3, 5, 6] and v.detectors_excluded == [4]
    n = v.images[0].shape[0]
    c = [im[n // 2, n // 2] for im in v.images]
    assert max(c) - min(c) < 0.02                      # static star: same brightness every epoch
    assert all(4 not in g["detectors"] for g in v.groups)


def test_view_summary_and_limits(cache):
    make_set(cache)
    v = views.get_view(SET_ID, "all")
    s = views.view_summary(v)
    assert s["source"] == "NASA IRSA DATA" and s["count"] == 3
    e = s["epochs"][0]
    assert e["image_url"] == (f"/api/sets/{SET_ID}/image.png?band=all&group_by=epoch"
                              f"&background=mesh&index=0")
    assert e["date"].startswith("2025-") and e["mjd"] > 60800
    assert s["display"]["vmax"] > s["display"]["vmin"]


def test_frame_grouping_and_errors(cache):
    make_set(cache)
    v = views.get_view(SET_ID, 2, "frame")
    assert len(v.groups) == 6 and all(g["n_frames"] == 1 for g in v.groups)
    with pytest.raises(BadRequest):
        views.get_view(SET_ID, 7)
    with pytest.raises(NotFound):
        views.get_view("snope", "all")
    with pytest.raises(NotFound):
        v.group(99)


def test_combine_difference_and_sum(cache):
    make_set(cache)
    v = views.get_view(SET_ID, 1)
    diff, var = views.combine(v, [2], [0])
    n = diff.shape[0]
    assert abs(diff[n // 2, n // 2]) < 0.05            # static star cancels
    assert diff[10, 28] > 0.2 and diff[10, 20] < -0.2   # mover: new position +, old −
    s, _ = views.combine(v, [0, 1, 2], [])
    assert s.shape == (n, n)


def test_endpoints(cache):
    make_set(cache)
    c = TestClient(main.app)
    body = c.get(f"/api/sets/{SET_ID}/view", params={"band": "all"}).json()
    assert body["count"] == 3
    r = c.get(body["epochs"][0]["image_url"] + "&stretch=sqrt&cmap=inferno&upscale=2")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert r.headers["x-data-source"] == "NASA IRSA DATA"
    im = Image.open(io.BytesIO(r.content))
    assert im.size == (2 * body["grid"]["n"],) * 2
    again = c.get(body["epochs"][0]["image_url"] + "&stretch=sqrt&cmap=inferno&upscale=2")
    assert again.content == r.content
    assert cache.stats()["counters"]["redis_hits"] >= 1          # PNG served from the cache

    d = c.get(f"/api/sets/{SET_ID}/combine.png", params={"plus": "2", "minus": "0", "tail": 3})
    assert d.status_code == 200
    st = json.loads(d.headers["x-render-stats"])
    assert st["tail_k"] == 3 and st["minus"] == [0]
    assert c.get(f"/api/sets/{SET_ID}/combine.png", params={"plus": "0,1,2"}).status_code == 200
    assert c.get(f"/api/sets/{SET_ID}/combine.png", params={"plus": "2", "minus": "0",
                                                            "cmap": "inferno"}).status_code == 400
    assert c.get(f"/api/sets/{SET_ID}/image.png", params={"index": 9}).status_code == 404

    m = c.get(f"/api/sets/{SET_ID}/movers", params={"a": 0, "b": 2, "band": 1}).json()
    assert m["note"].startswith("Candidates")
    assert len(m["pairs"]) == 1
    p = m["pairs"][0]
    assert p["shift_arcsec"] == pytest.approx(8 * 3.1, rel=0.05)
    assert p["from"]["coords"]["label"].startswith("RA 08h 55m")
    assert m["dt_days"] == pytest.approx(370, abs=1)
