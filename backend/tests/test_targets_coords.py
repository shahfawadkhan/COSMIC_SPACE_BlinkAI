import datetime as dt
import math

import pytest

from app import coords, targets


def test_format_ra_dec_brief_example():
    label = coords.coord_label(133.795129, -7.245147)
    assert label == "RA 08h 55m 10.83s (133.79513°)  Dec −07° 14′ 42.5″ (−7.24515°)"


def test_format_carry_and_signs():
    assert coords.format_ra(359.99999999) == "00h 00m 00.00s"
    assert coords.format_dec(4.69336).startswith("+04° 41′")
    assert coords.format_dec(-0.5) == "−00° 30′ 00.0″"
    assert coords.format_dec(89.99999999) == "+90° 00′ 00.0″"


def test_propagate_wise0855():
    # 10 years of -8150 mas/yr in RA* and +670 mas/yr in Dec
    ra, dec = targets.propagate(133.795129, -7.245147, -8150, 670, 2010.5, 2020.5)
    d_ra_star = (ra - 133.795129) * math.cos(math.radians(-7.245147)) * 3600
    assert d_ra_star == pytest.approx(-81.5, abs=0.05)
    assert (dec + 7.245147) * 3600 == pytest.approx(6.7, abs=0.01)


def test_position_today_rounded_and_moves_north_for_barnard():
    b = targets.get_target("barnard")
    ra, dec = targets.position_at(b, dt.date(2026, 11, 14))
    assert ra == round(ra, 3) and dec == round(dec, 3)
    shift = (dec - b.dec) * 3600
    assert 270 < shift < 285          # ~10.33"/yr × 26.9 yr
    assert targets.position_at(b, dt.date(2026, 11, 14)) == targets.position_at(b, dt.date(2026, 11, 14))


def test_variable_targets_do_not_move():
    r = targets.get_target("rdra")
    assert targets.position_at(r, dt.date(2030, 1, 1)) == (round(r.ra, 3), round(r.dec, 3))


def test_all_targets_info():
    info = targets.all_targets(dt.date(2026, 11, 14))
    assert [t["id"] for t in info] == ["wise0855", "barnard", "epsindib", "rwaur", "rdra"]
    w = info[0]
    assert w["pm_total_arcsec_yr"] == pytest.approx(8.177, abs=0.01)
    assert "RA 08h 55m" in w["catalog"]["label"]
    assert w["today"]["ra"] < w["catalog"]["ra"]   # moving west
