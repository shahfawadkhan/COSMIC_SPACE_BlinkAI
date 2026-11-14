import numpy as np
import pytest

from app import reproject
from tests.fakes import cutout_wcs


def gaussian_cutout(ra0, dec0, star_ra, star_dec, n=47, rot=30.0):
    w = cutout_wcs(ra0, dec0, n, rot)
    sx, sy = w.world_to_pixel_values(star_ra, star_dec)
    yy, xx = np.mgrid[0:n, 0:n]
    img = np.exp(-((xx - sx) ** 2 + (yy - sy) ** 2) / (2 * 1.0 ** 2)).astype(np.float32)
    return img, w.to_header()


def test_grid_shape_and_centre():
    w, n, pix = reproject.make_grid_wcs(133.758, -7.242, 4.0, 2)
    assert pix == pytest.approx(3.1)
    assert n % 2 == 1 and n == 79
    ra, dec = reproject.grid_world(w, n)
    c = n // 2
    assert ra[c, c] == pytest.approx(133.758) and dec[c, c] == pytest.approx(-7.242)
    assert ra[c, 0] > ra[c, -1]          # east is left
    assert ra.dtype == np.float64


def test_star_lands_at_correct_grid_pixel():
    ra0, dec0 = 133.758, -7.242
    star = (ra0 + 20 / 3600 / np.cos(np.radians(dec0)), dec0 - 15 / 3600)   # 20" E, 15" S
    img, hdr = gaussian_cutout(ra0, dec0, *star)
    w, n, pix = reproject.make_grid_wcs(ra0, dec0, 4.0, 2)
    ra_g, dec_g = reproject.grid_world(w, n)
    out, var = reproject.reproject_arrays(img, img * 0 + 1, hdr.tostring(), ra_g, dec_g)
    assert out.dtype == np.float32 and var.dtype == np.float32
    py, px = np.unravel_index(np.nanargmax(out), out.shape)
    ex, ey = w.world_to_pixel_values(*star)
    assert abs(px - ex) <= 1 and abs(py - ey) <= 1
    yy, xx = np.mgrid[0:n, 0:n]
    wts = np.nan_to_num(out)
    cx, cy = (wts * xx).sum() / wts.sum(), (wts * yy).sum() / wts.sum()
    assert cx == pytest.approx(ex, abs=0.15) and cy == pytest.approx(ey, abs=0.15)


def test_outside_is_nan_and_frame_task(tmp_path):
    ra0, dec0 = 10.0, 20.0
    img, hdr = gaussian_cutout(ra0, dec0, ra0, dec0, n=21, rot=45)
    w, n, _ = reproject.make_grid_wcs(ra0, dec0, 4.0, 2)
    ra_g, dec_g = reproject.grid_world(w, n)
    grid = tmp_path / "grid.npz"
    np.savez(grid, ra=ra_g, dec=dec_g)
    cut = tmp_path / "cut.npz"
    import json
    meta = {"header": hdr.tostring(), "target_inside": True}
    np.savez(cut, image=img, variance=np.ones_like(img), __meta__=np.array(json.dumps(meta)))
    r = reproject.reproject_frame({"index": 3, "cutout_path": str(cut), "grid_path": str(grid)})
    assert r["index"] == 3
    assert np.isnan(r["image"][0, 0])
    assert r["finite_fraction"] < 0.5 and not r["keep"] and "covered" in r["reason"]


def test_submit_inline(monkeypatch, tmp_path):
    monkeypatch.setattr(reproject.config.settings, "cpu_workers", 0)
    fut = reproject.submit({"index": 0, "cutout_path": str(tmp_path / "missing.npz"),
                            "grid_path": str(tmp_path / "g.npz")})
    with pytest.raises(FileNotFoundError):
        fut.result()
