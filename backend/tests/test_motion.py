import math

import numpy as np
import pytest

from app import motion, reproject


def gauss(n, x, y, amp, s=1.2):
    yy, xx = np.mgrid[0:n, 0:n]
    return amp * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * s * s))


def epochs(n=101, move=(30.0, 40.0, 36.0, 48.0), static=(70.0, 70.0), variable=(80.0, 20.0)):
    rng = np.random.default_rng(3)
    a = rng.normal(0, 1, (n, n)) + gauss(n, *static, 80)
    b = rng.normal(0, 1, (n, n)) + gauss(n, *static, 80)
    a += gauss(n, move[0], move[1], 25)
    b += gauss(n, move[2], move[3], 25)
    b += gauss(n, *variable, 25)          # brightened source: no matching negative
    return a, b


def test_moving_dot_found_once():
    a, b = epochs()
    w, n, pix = reproject.make_grid_wcs(133.758, -7.242, 101 * 3.1 / 60, 2)
    res = motion.find_movers(b - a, pix_arcsec=3.1, wcs=w, dt_days=365.25, img_a=a, img_b=b)
    assert len(res["pairs"]) == 1
    p = res["pairs"][0]
    assert p["from"]["x"] == pytest.approx(30, abs=0.3) and p["from"]["y"] == pytest.approx(40, abs=0.3)
    assert p["to"]["x"] == pytest.approx(36, abs=0.3) and p["to"]["y"] == pytest.approx(48, abs=0.3)
    assert p["shift_arcsec"] == pytest.approx(10 * 3.1, rel=0.03)
    assert p["rate_arcsec_per_yr"] == pytest.approx(p["shift_arcsec"])
    # +x is west and +y north: moving to +x,+y is towards the north-west (PA between 270 and 360)
    expected = math.degrees(math.atan2(-6, 8)) % 360
    assert p["pa_deg"] == pytest.approx(expected, abs=2)
    assert p["significance"] > 5
    assert "Unidentified candidate" in p["label"]
    # the brightened source is reported unpaired, the static star cancels out
    assert any(abs(u["x"] - 80) < 1 and abs(u["y"] - 20) < 1 for u in res["unpaired_new"])
    assert not any(abs(u["x"] - 70) < 2 and abs(u["y"] - 70) < 2
                   for u in res["unpaired_new"] + res["unpaired_old"])
    assert p["from"]["ra"] is not None and p["to"]["dec"] > p["from"]["dec"]


def test_max_shift_and_min_shift():
    a, b = epochs()
    assert motion.find_movers(b - a, pix_arcsec=3.1, max_shift_arcsec=20)["pairs"] == []
    a2, b2 = epochs(move=(30, 40, 30.8, 40.3))     # true shift 0.85 px < 1.5 px
    # Lobes of the dipole alone sit ~3 px apart and would pass ...
    assert len(motion.find_movers(b2 - a2, pix_arcsec=3.1)["pairs"]) == 1
    # ... measuring the ends on the epoch images gives the real, too-small shift
    assert motion.find_movers(b2 - a2, pix_arcsec=3.1, img_a=a2, img_b=b2)["pairs"] == []


def test_refined_shift_is_accurate_for_small_moves():
    a, b = epochs(move=(30, 40, 32.5, 41.0))       # 2.69 px
    p = motion.find_movers(b - a, pix_arcsec=3.1, img_a=a, img_b=b)["pairs"][0]
    raw = motion.find_movers(b - a, pix_arcsec=3.1)["pairs"][0]
    assert p["shift_pix"] == pytest.approx(math.hypot(2.5, 1.0), abs=0.3)
    assert raw["shift_pix"] > p["shift_pix"]


def test_flux_ratio_rejects_unrelated_peaks():
    n = 81
    rng = np.random.default_rng(5)
    diff = rng.normal(0, 1, (n, n)) - gauss(n, 20, 20, 10) + gauss(n, 26, 20, 200)
    assert motion.find_movers(diff, pix_arcsec=3.1)["pairs"] == []
    assert len(motion.find_movers(diff, pix_arcsec=3.1, max_flux_ratio=100)["pairs"]) == 1


def test_static_star_residuals_rejected():
    """Two static stars that change brightness/PSF between epochs make +/- lobes of similar
    size a few pixels apart; they must not be paired as a mover."""
    n = 101
    rng = np.random.default_rng(11)
    a = rng.normal(0, 1, (n, n)) + gauss(n, 40, 40, 300, s=1.2) + gauss(n, 46, 44, 300, s=1.2)
    b = rng.normal(0, 1, (n, n)) + gauss(n, 40, 40, 240, s=1.2) + gauss(n, 46, 44, 360, s=1.2)
    raw = motion.find_movers(b - a, pix_arcsec=3.1)
    assert len(raw["pairs"]) == 1                     # lobes alone look like a mover
    res = motion.find_movers(b - a, pix_arcsec=3.1, img_a=a, img_b=b)
    assert res["pairs"] == [] and res["stats"]["rejected_as_static"] >= 1
    # a real mover next to them is still found
    a2 = a + gauss(n, 70, 20, 40)
    b2 = b + gauss(n, 74, 22, 40)
    p = motion.find_movers(b2 - a2, pix_arcsec=3.1, img_a=a2, img_b=b2)["pairs"]
    assert len(p) == 1 and p[0]["left_at_old_position"] < 0.2


def test_saturated_star_shift_from_halo():
    """Bright star with a masked (NaN) core moving 2 px north: the difference lobes sit on
    the halo edges far apart; the halo match must give the true 2 px."""
    n = 101
    rng = np.random.default_rng(4)

    def star(x, y):
        img = rng.normal(0, 1, (n, n)) + gauss(n, x, y, 3000, s=3.0)
        yy, xx = np.mgrid[0:n, 0:n]
        img[np.hypot(xx - x, yy - y) < 3.5] = np.nan         # saturated core masked
        return img

    a, b = star(50.0, 48.0), star(50.0, 50.0)
    res = motion.find_movers(b - a, pix_arcsec=3.1, img_a=a, img_b=b, max_residual_frac=0.9)
    assert len(res["pairs"]) == 1
    p = res["pairs"][0]
    assert p["saturated"] and "cross-correlation" in p["method"]
    assert p["shift_pix"] == pytest.approx(2.0, abs=0.25)
    # rings sit on the star (centre of its masked core), not on the halo edge
    assert p["from"]["x"] == pytest.approx(50.0, abs=0.5) and p["from"]["y"] == pytest.approx(48.0, abs=0.5)
    assert p["to"]["y"] == pytest.approx(50.0, abs=0.5)
    assert p["pa_deg"] == pytest.approx(0, abs=10) or p["pa_deg"] == pytest.approx(360, abs=10)


def test_position_angle():
    assert motion.position_angle_deg(10, 0, 10, 1) == pytest.approx(0)
    assert motion.position_angle_deg(10, 0, 11, 0) == pytest.approx(90)
    assert motion.position_angle_deg(10, 0, 9, 0) == pytest.approx(270)


def test_noise_only_has_no_pairs():
    rng = np.random.default_rng(9)
    res = motion.find_movers(rng.normal(0, 1, (120, 120)), pix_arcsec=3.1)
    assert res["pairs"] == []
