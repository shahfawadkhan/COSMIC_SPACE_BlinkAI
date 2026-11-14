import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import catalog, main, targets
from app.errors import UpstreamError

# Synthetic catalogue: a Barnard-like fast star whose J2000 / 2016 positions are far from today's,
# its planet, a static star, and a two-component system.
BARNARD = targets.get_target("barnard")


def simbad_rows():
    return [
        {"main_id": "NAME Barnard's star", "ra": str(BARNARD.ra), "dec": str(BARNARD.dec),
         "pmra": str(BARNARD.pmra), "pmdec": str(BARNARD.pmdec), "otype": "BY*"},
        {"main_id": "NAME Barnard's Star b", "ra": str(BARNARD.ra), "dec": str(BARNARD.dec),
         "pmra": str(BARNARD.pmra), "pmdec": str(BARNARD.pmdec), "otype": "Pl"},
        {"main_id": "TYC 425-2502-1", "ra": "269.45", "dec": "4.77", "pmra": "1.0", "pmdec": "-2.0", "otype": "*"},
        {"main_id": "RW Aur B", "ra": "76.95654", "dec": "30.40144", "pmra": "", "pmdec": "", "otype": "Or*"},
        {"main_id": "RW Aur", "ra": "76.95654", "dec": "30.40144", "pmra": "", "pmdec": "", "otype": "Or*"},
    ]


def gaia_rows():
    # Gaia positions are at 2016.0
    ra16, dec16 = targets.propagate(BARNARD.ra, BARNARD.dec, BARNARD.pmra, BARNARD.pmdec, 2000.0, 2016.0)
    return [
        {"source_id": "4472832130942575872", "ra": str(ra16), "dec": str(dec16), "pmra": str(BARNARD.pmra),
         "pmdec": str(BARNARD.pmdec), "parallax": "546.9", "gmag": "8.19"},
        {"source_id": "111", "ra": "150.001", "dec": "30.0", "pmra": "", "pmdec": "", "parallax": "", "gmag": "18.0"},
    ]


def _in_cone(row, adql):
    import re
    m = re.search(r"CIRCLE\('ICRS', ([-\d.]+), ([-\d.]+), ([-\d.]+)\)", adql)
    ra0, dec0, r = (float(x) for x in m.groups())
    from app.coords import angular_sep_deg
    return angular_sep_deg(ra0, dec0, float(row["ra"]), float(row["dec"])) <= r


@pytest.fixture
def fake_tap(monkeypatch, cache):
    calls = []
    state = {"fail": set()}

    def tap(service, urls, adql, timeout=30):
        calls.append((service, adql))
        if service in state["fail"]:
            raise UpstreamError(f"{service} unavailable: HTTP 503")
        rows = simbad_rows() if "FROM basic" in adql else gaia_rows()
        rows = [r for r in rows if _in_cone(r, adql)]
        if "pmra*pmra" in adql or "pmRA*pmRA" in adql:
            rows = [r for r in rows if r["pmra"] and math.hypot(float(r["pmra"]), float(r["pmdec"])) > 500]
        return rows, "fake.host"

    monkeypatch.setattr(catalog, "_tap", tap)
    return calls, state


def test_names_and_planets():
    assert catalog.clean_name("NAME Barnard's star") == "Barnard's star"
    assert catalog.clean_name("V* R Dra") == "R Dra"
    assert catalog.is_planet({"main_id": "NAME Barnard's Star b", "otype": "Pl"})
    assert not catalog.is_planet({"main_id": "eps Ind B", "otype": "BD*"})   # capital B: a component


def test_position_at_moves_with_proper_motion():
    row = {"ra": BARNARD.ra, "dec": BARNARD.dec, "pmra": BARNARD.pmra, "pmdec": BARNARD.pmdec, "epoch": 2000.0}
    ra, dec = catalog.position_at(row, 2026.0)
    assert (dec - BARNARD.dec) * 3600 == pytest.approx(26 * 10.32812, rel=1e-4)
    assert ra < BARNARD.ra


def test_high_pm_star_found_at_todays_position(fake_tap):
    calls, _ = fake_tap
    ra, dec = targets.position_at(BARNARD, None, rounded=False)
    # today's position is ~280" from the J2000 catalogue position: a plain 30" cone misses it
    r = catalog.identify(ra, dec, 30.0)
    assert r["nearest"]["name"] == "Barnard's star"              # star, not its planet
    assert r["nearest"]["distance_arcsec"] < 1.0
    assert r["use_as_name"] is True
    assert r["label"].startswith("Nearest known object: Barnard's star (")
    assert r["label"].endswith("BY*)")
    assert r["gaia_nearest"]["id"].startswith("Gaia DR3 4472832")
    assert any("pmra*pmra" in q for _, q in calls)               # the high-PM supplement ran


def test_identify_reports_star_that_moved_away(fake_tap):
    # The J2000 catalogue position of Barnard's Star: today the star is ~280" north
    r = catalog.identify(BARNARD.ra, BARNARD.dec, 30.0)
    assert r["moved_away"]["name"] == "Barnard's star"
    assert r["moved_away"]["distance_now_arcsec"] > 250
    assert r["moved_away"]["year"] == pytest.approx(2000.0, abs=0.5)
    assert "Barnard's star was here around 2000 and has since moved" in r["label"]
    # a point on its track in 2010 (not a catalogue epoch) is recognised too
    ra10, dec10 = targets.propagate(BARNARD.ra, BARNARD.dec, BARNARD.pmra, BARNARD.pmdec, 2000.0, 2010.0)
    r = catalog.identify(ra10, dec10, 30.0)
    assert r["moved_away"]["name"] == "Barnard's star" and r["moved_away"]["year"] == pytest.approx(2010.0, abs=0.5)


def test_identify_nothing_and_cache(fake_tap):
    calls, _ = fake_tap
    r = catalog.identify(10.0, -40.0, 30.0)
    assert r["nearest"] is None and r["label"] == "No catalogued object within 30″ of this position"
    n = len(calls)
    catalog.identify(10.0, -40.0, 30.0)
    assert len(calls) == n                                         # cones cached


def test_identify_falls_back_to_gaia_and_prefers_system(fake_tap):
    r = catalog.identify(150.001, 30.0, 30.0)
    assert r["nearest"]["catalogue"] == "Gaia DR3" and r["nearest"]["name"] == "Gaia DR3 111"
    assert r["use_as_name"] is True                                # Gaia source within 3"
    r = catalog.identify(150.001 + 6 / 3600, 30.0, 30.0)
    assert r["nearest"]["catalogue"] == "Gaia DR3" and r["use_as_name"] is False   # 5" away: neighbour
    r = catalog.identify(76.95654, 30.40144, 30.0)
    assert r["nearest"]["name"] == "RW Aur"                       # system before component


def test_gaia_mirror_order(fake_tap):
    calls, state = fake_tap
    state["fail"] = {"Gaia ESA"}
    res = catalog.cone("gaia", 150.0, 30.0, 10.0, include_high_pm=False)
    assert res["provider"].startswith("Gaia VizieR")
    assert [c[0] for c in calls] == ["Gaia ESA", "Gaia VizieR"]
    state["fail"] = {"Gaia ESA", "Gaia VizieR", "Gaia IRSA"}
    with pytest.raises(UpstreamError):
        catalog.cone("gaia", 151.0, 30.0, 10.0, include_high_pm=False)


def test_vizier_query_uses_its_columns(fake_tap):
    calls, state = fake_tap
    state["fail"] = {"Gaia ESA"}
    catalog.cone("gaia", 152.0, 30.0, 10.0, include_high_pm=False)
    q = calls[-1][1]
    assert '"I/355/gaiadr3"' in q and "RA_ICRS" in q and "ORDER BY 8" in q


def test_name_pairs_matches_and_flags_motion(fake_tap):
    from astropy.time import Time
    mjd_a = Time(2025.6, format="jyear").mjd
    mjd_b = Time(2026.2, format="jyear").mjd
    row = {"ra": BARNARD.ra, "dec": BARNARD.dec, "pmra": BARNARD.pmra, "pmdec": BARNARD.pmdec, "epoch": 2000.0}
    ra_a, dec_a = catalog.position_at(row, 2025.6)
    ra_b, dec_b = catalog.position_at(row, 2026.2)
    good = {"from": {"ra": ra_a, "dec": dec_a}, "to": {"ra": ra_b, "dec": dec_b + 1.0 / 3600}, "shift_arcsec": 7.2}
    off = {"from": {"ra": ra_a, "dec": dec_a}, "to": {"ra": ra_b, "dec": dec_b + 9.0 / 3600}, "shift_arcsec": 15.0}
    nobody = {"from": {"ra": 269.40, "dec": 4.80}, "to": {"ra": 269.40, "dec": 4.801}, "shift_arcsec": 3.6}
    field = catalog.field_sources(BARNARD.ra, BARNARD.dec + 0.07, 4.0)
    catalog.name_pairs([good, off, nobody], field, mjd_a, mjd_b)
    assert good["name"] == "Barnard's star" and good["identified"]
    assert good["expected_shift_arcsec"] == pytest.approx(0.6 * 10.36, rel=0.01)
    assert good["matches_catalogue"] and "matches catalogue motion" in good["label"]
    assert "measured 7.2″, catalogue 6.2″" in good["label"]
    assert off["identified"] and not off["matches_catalogue"]
    assert nobody["name"] == "Unidentified candidate" and not nobody["identified"]


def test_endpoints(fake_tap):
    c = TestClient(main.app)
    ra, dec = targets.position_at(BARNARD)
    r = c.get("/api/identify", params={"ra": ra, "dec": dec}).json()
    assert r["nearest"]["name"] == "Barnard's star"
    cone = c.get("/api/cone", params={"ra": 269.45, "dec": 4.77, "radius_arcsec": 60, "source": "simbad"}).json()
    assert any(s["id"] == "TYC 425-2502-1" for s in cone["sources"])
    assert c.get("/api/cone", params={"ra": 1, "dec": 1, "source": "2mass"}).status_code == 400
    res = c.get("/api/resolve", params={"name": "Barnard's Star"}).json()
    assert res["main_id"] == "Barnard's Star" and res["pmdec"] == pytest.approx(10328.12)
    assert c.get("/api/resolve").status_code == 400


def test_set_overlay_and_named_movers(fake_tap, cache):
    from tests.test_views import SET_ID, make_set
    make_set(cache)
    c = TestClient(main.app)
    ov = c.get(f"/api/sets/{SET_ID}/overlay", params={"source": "simbad"}).json()
    assert ov["epochs"] == [0, 1, 2]
    for s in ov["sources"]:
        assert len(s["pix"]) == 3 and "Barnard's Star b" not in s["id"]
    m = c.get(f"/api/sets/{SET_ID}/movers", params={"a": 0, "b": 2, "band": 1}).json()
    assert len(m["pairs"]) == 1
    p = m["pairs"][0]
    assert p["name"].startswith("Unidentified") and p["identified"] is False
    assert np.isfinite(p["shift_arcsec"])
