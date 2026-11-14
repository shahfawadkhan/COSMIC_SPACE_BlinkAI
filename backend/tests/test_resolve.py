import pytest

from app import resolve
from app.errors import BadRequest, NotFound


@pytest.mark.parametrize("text", [
    "133.795129 -7.245147",
    "133.795129, -7.245147",
    "08h55m10.831s -07d14m42.53s",
    "08:55:10.831 -07:14:42.53",
    "08 55 10.831 -07 14 42.53",
    "08h55m10.831s −07d14m42.53s",
])
def test_parse_coordinates(text):
    ra, dec = resolve.parse_coordinates(text)
    assert ra == pytest.approx(133.795129, abs=2e-5) and dec == pytest.approx(-7.245147, abs=2e-5)


def test_not_coordinates_and_out_of_range():
    assert resolve.parse_coordinates("Barnard's Star") is None
    assert resolve.parse_coordinates("R Dra") is None
    with pytest.raises(BadRequest):
        resolve.parse_coordinates("400 10")


@pytest.mark.parametrize("q,tid", [("barnard's star", "barnard"), ("WISE 0855-0714", "wise0855"),
                                   ("eps Ind B", "epsindib"), ("RW Aur", "rwaur"), ("r draconis", "rdra")])
def test_builtin_targets(cache, q, tid):
    r = resolve.resolve(q)
    assert r["target_id"] == tid and "built-in" in r["source"]
    assert r["coords"]["label"].startswith("RA ")


def test_sesame_then_simbad_cached(cache, monkeypatch):
    from app import catalog
    calls = []
    monkeypatch.setattr(resolve, "_sesame", lambda q: calls.append(q) or (217.42894, -62.67948))
    monkeypatch.setattr(catalog, "simbad_at", lambda ra, dec, r=10.0: {
        "id": "Proxima Centauri", "pmra": -3781.741, "pmdec": 769.465, "otype": "BY*"})
    a = resolve.resolve("Proxima Cen")
    b = resolve.resolve("proxima cen")
    assert len(calls) == 1
    assert a["main_id"] == b["main_id"] == "Proxima Centauri" and a["source"] == "CDS Sesame + SIMBAD"
    assert a["catalog_ra"] == 217.42894
    # proper motion applied: today's position, rounded to 0.001 deg
    assert a["ra"] == round(a["ra"], 3) and a["ra"] < 217.42894 and a["kind"] == "moving"


def test_sesame_down_uses_simbad_identifier(cache, monkeypatch):
    from app import catalog
    from app.errors import UpstreamError

    def down(q):
        raise UpstreamError("Sesame down")

    monkeypatch.setattr(resolve, "_sesame", down)
    monkeypatch.setattr(resolve, "_simbad_ident", lambda q: (10.68471, 41.26875))
    monkeypatch.setattr(catalog, "simbad_at", lambda ra, dec, r=10.0: None)
    r = resolve.resolve("M 31")
    assert r["ra"] == 10.68471 and r["source"] == "SIMBAD" and r["main_id"] is None


def test_empty_and_not_found(cache, monkeypatch):
    with pytest.raises(BadRequest):
        resolve.resolve("  ")

    def nf(q):
        raise NotFound("No object called x")

    monkeypatch.setattr(resolve, "_sesame", nf)
    with pytest.raises(NotFound):
        resolve.resolve("zzzz not a star")
