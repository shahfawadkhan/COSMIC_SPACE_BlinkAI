"""Catalogues: SIMBAD and Gaia DR3 cones, name lookup, identification, named movers.

Services (tried in order, each host with its own 2-minute circuit breaker):
  SIMBAD TAP: CDS, then Harvard mirror.            Positions at J2000.
  Gaia DR3:   ESA TAP, then VizieR I/355/gaiadr3, then IRSA TAP gaia_dr3_source.  Epoch 2016.0.
Results are cached 30 days (Redis + disk).

High proper motion: catalogue positions are at J2000/2016, so a nearby star such as Barnard's
(10.4"/yr) can be minutes of arc from its catalogue position today. Every lookup therefore adds
a wide cone restricted to fast movers, and every row is moved to the epoch being compared
before distances are measured.
"""
from __future__ import annotations

import csv
import io
import logging
import math
import re
from concurrent.futures import ThreadPoolExecutor

from astropy.time import Time

from . import cache as cache_mod
from . import config
from .coords import angular_sep_deg, coord_info
from .errors import UpstreamError
from .net import request_with_mirrors

log = logging.getLogger(__name__)

SIMBAD_EPOCH = 2000.0
GAIA_EPOCH = 2016.0
HIGH_PM_MAS = 500.0          # "fast mover" threshold for the wide cone
HIGH_PM_RADIUS_ARCSEC = 420  # covers Barnard's Star (10.4"/yr) over 40 years
MATCH_SIMBAD_ARCSEC = 8.0
MATCH_GAIA_ARCSEC = 6.0
AGREE_ARCSEC = 3.0
IDENTIFY_NAME_ARCSEC = 10.0
IDENTIFY_GAIA_NAME_ARCSEC = 3.0
_PLANET_RE = re.compile(r"\s[b-f]$")
_COMPONENT_RE = re.compile(r"\s[A-D]{1,2}$")


# ------------------------------------------------------------------ TAP
def _tap(service: str, urls: list[str], adql: str, timeout: float = 30.0) -> tuple[list[dict], str]:
    resp = request_with_mirrors(service, urls, "POST", timeout=timeout,
                                data={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql})
    text = resp.content.decode("utf-8", "replace")
    if text.lstrip().startswith("<"):  # VOTable error document instead of CSV
        raise UpstreamError(f"{service}: query rejected")
    rows = list(csv.DictReader(io.StringIO(text)))
    host = resp.url.split("/")[2] if getattr(resp, "url", None) else ""
    return rows, host


def _f(v) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def clean_name(main_id: str) -> str:
    """SIMBAD prefixes common names with 'NAME ' and stars with '* '."""
    n = (main_id or "").strip()
    for p in ("NAME ", "* ", "V* "):
        if n.startswith(p):
            return n[len(p):].strip()
    return n


def is_planet(row: dict) -> bool:
    return row.get("otype") in ("Pl", "Pl?") or bool(_PLANET_RE.search(row.get("main_id", "")))


# ------------------------------------------------------------------ cones
def _simbad_adql(ra: float, dec: float, r_deg: float, limit: int, high_pm: bool) -> str:
    where = f"1=CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra:.7f}, {dec:.7f}, {r_deg:.7f}))"
    if high_pm:
        where += f" AND pmra*pmra + pmdec*pmdec > {HIGH_PM_MAS ** 2:.0f}"
    return (f"SELECT TOP {int(limit)} main_id, ra, dec, pmra, pmdec, otype, "
            f"DISTANCE(POINT('ICRS', ra, dec), POINT('ICRS', {ra:.7f}, {dec:.7f})) AS dist "
            f"FROM basic WHERE {where} ORDER BY 7")


def _gaia_adql(table: str, cols: tuple[str, ...], ra: float, dec: float, r_deg: float, limit: int,
               high_pm: bool) -> str:
    sid, cra, cdec, cpmra, cpmdec, cplx, cmag = cols
    where = f"1=CONTAINS(POINT('ICRS', {cra}, {cdec}), CIRCLE('ICRS', {ra:.7f}, {dec:.7f}, {r_deg:.7f}))"
    if high_pm:
        where += f" AND {cpmra}*{cpmra} + {cpmdec}*{cpmdec} > {HIGH_PM_MAS ** 2:.0f}"
    return (f"SELECT TOP {int(limit)} {sid} AS source_id, {cra} AS ra, {cdec} AS dec, {cpmra} AS pmra, "
            f"{cpmdec} AS pmdec, {cplx} AS parallax, {cmag} AS gmag, "
            f"DISTANCE(POINT('ICRS', {cra}, {cdec}), POINT('ICRS', {ra:.7f}, {dec:.7f})) AS dist "
            f"FROM {table} WHERE {where} ORDER BY 8")


_GAIA_PROVIDERS = [
    ("Gaia ESA", "gaia_tap_urls", "gaiadr3.gaia_source",
     ("source_id", "ra", "dec", "pmra", "pmdec", "parallax", "phot_g_mean_mag")),
    ("Gaia VizieR", "vizier_tap_urls", '"I/355/gaiadr3"',
     ('"Source"', "RA_ICRS", "DE_ICRS", "pmRA", "pmDE", "Plx", "Gmag")),
    ("Gaia IRSA", "irsa_tap_urls", "gaia_dr3_source",
     ("source_id", "ra", "dec", "pmra", "pmdec", "parallax", "phot_g_mean_mag")),
]


def _simbad_rows(ra, dec, r_deg, limit, high_pm) -> tuple[list[dict], str]:
    rows, host = _tap("SIMBAD", config.settings.simbad_tap_urls, _simbad_adql(ra, dec, r_deg, limit, high_pm), 20)
    out = []
    for r in rows:
        ra_, dec_ = _f(r.get("ra")), _f(r.get("dec"))
        if ra_ is None or dec_ is None:
            continue
        out.append({"id": clean_name(r.get("main_id", "")), "main_id": r.get("main_id", "").strip(),
                    "ra": ra_, "dec": dec_, "pmra": _f(r.get("pmra")), "pmdec": _f(r.get("pmdec")),
                    "otype": (r.get("otype") or "").strip() or None, "epoch": SIMBAD_EPOCH})
    return out, f"SIMBAD ({host})"


def _gaia_rows(ra, dec, r_deg, limit, high_pm) -> tuple[list[dict], str]:
    errors = []
    for name, attr, table, cols in _GAIA_PROVIDERS:
        urls = getattr(config.settings, attr)
        try:
            rows, host = _tap(name, urls, _gaia_adql(table, cols, ra, dec, r_deg, limit, high_pm), 30)
        except UpstreamError as exc:
            errors.append(exc.message)
            continue
        out = []
        for r in rows:
            ra_, dec_ = _f(r.get("ra")), _f(r.get("dec"))
            if ra_ is None or dec_ is None:
                continue
            sid = (r.get("source_id") or "").strip()
            out.append({"id": f"Gaia DR3 {sid}", "source_id": sid, "ra": ra_, "dec": dec_,
                        "pmra": _f(r.get("pmra")), "pmdec": _f(r.get("pmdec")),
                        "parallax": _f(r.get("parallax")), "mag": _f(r.get("gmag")),
                        "otype": None, "epoch": GAIA_EPOCH})
        return out, f"{name} ({host})"
    raise UpstreamError("Gaia DR3 unavailable: " + " | ".join(errors))


def cone(source: str, ra: float, dec: float, radius_arcsec: float, limit: int = 500,
         include_high_pm: bool = True) -> dict:
    """Cone search with a high-proper-motion supplement. Cached 30 days."""
    if source not in ("gaia", "simbad"):
        raise ValueError("source must be gaia or simbad")
    radius_arcsec = float(min(max(radius_arcsec, 1.0), 3600.0))
    limit = int(min(max(limit, 1), 5000))
    key = cache_mod.make_key(cache_mod.NS_CATALOG, source, round(ra, 5), round(dec, 5),
                             round(radius_arcsec, 1), limit, include_high_pm, 2)
    cache = cache_mod.get_cache()
    hit = cache.get_json(key)
    if hit is not None:
        return hit
    fetch = _gaia_rows if source == "gaia" else _simbad_rows
    rows, provider = fetch(ra, dec, radius_arcsec / 3600.0, limit, False)
    if include_high_pm:
        try:
            fast, _ = fetch(ra, dec, (radius_arcsec + HIGH_PM_RADIUS_ARCSEC) / 3600.0, 50, True)
            seen = {r["id"] for r in rows}
            rows += [r for r in fast if r["id"] not in seen]
        except UpstreamError as exc:  # the main cone is still useful
            log.warning("high-PM cone failed: %s", exc)
    result = {"source": source, "provider": provider, "ra": ra, "dec": dec, "radius_arcsec": radius_arcsec,
              "epoch": GAIA_EPOCH if source == "gaia" else SIMBAD_EPOCH, "count": len(rows),
              "truncated": len(rows) >= limit, "sources": rows}
    cache.set_json(key, result, ttl=config.TTL_CATALOG)
    return result


# ------------------------------------------------------------------ epochs
def jyear_from_mjd(mjd: float) -> float:
    return float(Time(mjd, format="mjd").jyear)


def position_at(row: dict, jyear: float) -> tuple[float, float]:
    """Move a catalogue row to `jyear` with its proper motion (pmra = pmra*cos dec)."""
    pmra, pmdec = row.get("pmra") or 0.0, row.get("pmdec") or 0.0
    dt = jyear - row.get("epoch", 2000.0)
    cosd = max(1e-9, math.cos(math.radians(row["dec"])))
    return (row["ra"] + pmra * dt / 3.6e6 / cosd) % 360.0, row["dec"] + pmdec * dt / 3.6e6


def nearest(rows: list[dict], ra: float, dec: float, jyear: float, max_arcsec: float,
            prefer_non_planet: bool = True) -> list[dict]:
    """Rows within max_arcsec of (ra, dec) at jyear, nearest first (stars before their planets)."""
    out = []
    for r in rows:
        pra, pdec = position_at(r, jyear)
        d = angular_sep_deg(ra, dec, pra, pdec) * 3600.0
        if d <= max_arcsec:
            out.append({**r, "ra_at": pra, "dec_at": pdec, "distance_arcsec": d})
    # ties (same position to 0.1"): stars before their planets, systems ("RW Aur") before components ("RW Aur B")
    out.sort(key=lambda r: (round(r["distance_arcsec"], 1), prefer_non_planet and is_planet(r),
                            bool(_COMPONENT_RE.search(r.get("id") or "")), r["distance_arcsec"]))
    return out


# ------------------------------------------------------------------ identify / resolve
def identify(ra: float, dec: float, radius_arcsec: float = 30.0, jyear: float | None = None) -> dict:
    """Name a position: nearest SIMBAD objects and nearest Gaia source (moved to jyear, default now)."""
    jyear = float(Time.now().jyear) if jyear is None else jyear
    results: dict = {}

    def run(src):
        try:
            return src, cone(src, ra, dec, radius_arcsec + 5, limit=200 if src == "simbad" else 300), None
        except UpstreamError as exc:
            return src, None, exc.message

    with ThreadPoolExecutor(2) as ex:
        for src, res, err in ex.map(run, ("simbad", "gaia")):
            results[src] = (res, err)
    s_res, s_err = results["simbad"]
    g_res, g_err = results["gaia"]
    simbad = [r for r in nearest(s_res["sources"], ra, dec, jyear, radius_arcsec) if not is_planet(r)] if s_res else []
    gaia = nearest(g_res["sources"], ra, dec, jyear, radius_arcsec) if g_res else []
    best = None
    if simbad:
        s = simbad[0]
        best = {"name": s["id"], "main_id": s["main_id"], "otype": s["otype"], "catalogue": "SIMBAD",
                "distance_arcsec": s["distance_arcsec"], "pmra": s["pmra"], "pmdec": s["pmdec"]}
    elif gaia:
        g = gaia[0]
        best = {"name": g["id"], "main_id": g["id"], "otype": "Gaia source", "catalogue": "Gaia DR3",
                "distance_arcsec": g["distance_arcsec"], "pmra": g["pmra"], "pmdec": g["pmdec"]}
    # Typed coordinates are often a catalogue position from years ago. A fast mover whose
    # catalogue position matches but which has since moved off is worth saying out loud.
    moved_away = None
    if s_res:
        here_now = {r["id"] for r in simbad}
        for r in s_res["sources"]:
            pm = math.hypot(r.get("pmra") or 0.0, r.get("pmdec") or 0.0)
            if r["id"] in here_now or is_planet(r) or pm < 100.0:
                continue
            # closest approach of the object's track (1990 -> now) to the typed position
            best_d, best_y = min((angular_sep_deg(ra, dec, *position_at(r, y)) * 3600.0, y)
                                 for y in (1990.0 + 0.25 * k for k in range(int((jyear - 1990.0) / 0.25) + 1)))
            if best_d > max(radius_arcsec, 10.0):
                continue
            pra, pdec = position_at(r, jyear)
            d_now = angular_sep_deg(ra, dec, pra, pdec) * 3600.0
            if d_now > radius_arcsec and (moved_away is None or best_d < moved_away["closest_arcsec"]):
                moved_away = {"name": r["id"], "otype": r.get("otype"), "year": round(best_y, 1),
                              "closest_arcsec": best_d, "distance_now_arcsec": d_now, "ra_now": pra, "dec_now": pdec}
    if best:
        label = (f"Nearest known object: {best['name']} ({best['distance_arcsec']:.1f}″ away"
                 f"{', ' + best['otype'] if best['otype'] else ''})")
    elif s_res is None and g_res is None:
        label = "Catalogues are not answering right now"
    else:
        label = f"No catalogued object within {radius_arcsec:g}″ of this position"
    if moved_away:
        label += (f" · {moved_away['name']} was here around {moved_away['year']:.0f}"
                  f" and has since moved: now {moved_away['distance_now_arcsec']:.0f}″ away")
    trim = lambda r: {k: r.get(k) for k in ("id", "main_id", "otype", "ra", "dec", "pmra", "pmdec",
                                              "mag", "distance_arcsec")}
    return {
        "query": {"ra": ra, "dec": dec, "radius_arcsec": radius_arcsec, "epoch": round(jyear, 3),
                  "coords": coord_info(ra, dec)},
        "nearest": best,
        "moved_away": moved_away,
        # SIMBAD object within 10": that is what the user pointed at. A bare Gaia source must be
        # within 3": Gaia is dense, so a 10" Gaia match is usually just a neighbour.
        "use_as_name": bool(best and best["distance_arcsec"] <= (IDENTIFY_NAME_ARCSEC if best["catalogue"] == "SIMBAD" else IDENTIFY_GAIA_NAME_ARCSEC)),
        "label": label,
        "simbad": [trim(r) for r in simbad[:10]],
        "gaia_nearest": trim(gaia[0]) if gaia else None,
        "errors": {k: v for k, v in (("simbad", s_err), ("gaia", g_err)) if v},
        "providers": {"simbad": s_res["provider"] if s_res else None, "gaia": g_res["provider"] if g_res else None},
    }


def simbad_at(ra: float, dec: float, radius_arcsec: float = 10.0) -> dict | None:
    """Best SIMBAD row at a J2000 position (name lookup: main_id and proper motion)."""
    res = cone("simbad", ra, dec, radius_arcsec, limit=10, include_high_pm=False)
    rows = nearest(res["sources"], ra, dec, SIMBAD_EPOCH, radius_arcsec)
    return rows[0] if rows else None


# ------------------------------------------------------------------ named movers
def field_centre(manifest: dict) -> tuple[float, float, float]:
    """(ra, dec, fov_arcmin) of a set: from the request, else from the grid WCS."""
    req = manifest.get("request")
    if req:
        return req["ra"], req["dec"], req["fov_arcmin"]
    w = manifest["grid"]["wcs"]
    return float(w["CRVAL1"]), float(w["CRVAL2"]), float(manifest["grid"]["fov_arcmin"])


def field_sources(ra: float, dec: float, fov_arcmin: float) -> dict:
    """SIMBAD + Gaia for a whole set field (one cached cone each)."""
    r = fov_arcmin * 60.0 / math.sqrt(2) + 15.0
    out = {}
    for src, limit in (("simbad", 500), ("gaia", 3000)):
        try:
            out[src] = cone(src, ra, dec, r, limit=limit)
        except UpstreamError as exc:
            out[src] = {"error": exc.message, "sources": []}
    return out


def name_pairs(pairs: list[dict], field: dict, mjd_a: float, mjd_b: float) -> list[dict]:
    """Attach catalogue names and expected motion to mover pairs (in place, returned)."""
    ja, jb = jyear_from_mjd(mjd_a), jyear_from_mjd(mjd_b)
    simbad = field.get("simbad", {}).get("sources", [])
    gaia = field.get("gaia", {}).get("sources", [])
    for p in pairs:
        f, t = p["from"], p["to"]
        match, cat = None, None
        if f.get("ra") is not None and t.get("ra") is not None:
            for rows, lim, catname in ((simbad, MATCH_SIMBAD_ARCSEC, "SIMBAD"), (gaia, MATCH_GAIA_ARCSEC, "Gaia DR3")):
                cands = nearest(rows, f["ra"], f["dec"], ja, lim) + nearest(rows, t["ra"], t["dec"], jb, lim)
                cands = [c for c in cands if not is_planet(c)] or cands
                if cands:
                    match, cat = min(cands, key=lambda c: c["distance_arcsec"]), catname
                    break
        if match is None:
            p.update({"name": "Unidentified candidate", "identified": False,
                      "catalogue": None, "expected_shift_arcsec": None, "matches_catalogue": False,
                      "label": "Unidentified candidate – needs further scientific investigation"})
            continue
        ra_a, dec_a = position_at(match, ja)
        ra_b, dec_b = position_at(match, jb)
        expected = angular_sep_deg(ra_a, dec_a, ra_b, dec_b) * 3600.0
        # vector agreement: catalogue end position vs measured end position (both from the A position)
        cosd = math.cos(math.radians(dec_a))
        mdx = (t["ra"] - f["ra"]) * cosd * 3600.0
        mdy = (t["dec"] - f["dec"]) * 3600.0
        cdx = (ra_b - ra_a) * cosd * 3600.0
        cdy = (dec_b - dec_a) * 3600.0
        disagreement = math.hypot(mdx - cdx, mdy - cdy)
        agrees = disagreement <= AGREE_ARCSEC
        p.update({
            "name": match["id"], "identified": True, "catalogue": cat, "otype": match.get("otype"),
            "match_distance_arcsec": match["distance_arcsec"],
            "catalogue_pm": {"pmra": match.get("pmra"), "pmdec": match.get("pmdec")},
            "expected_shift_arcsec": expected, "motion_disagreement_arcsec": disagreement,
            "matches_catalogue": agrees,
            "label": (f"{match['id']} · measured {p['shift_arcsec']:.1f}″, catalogue {expected:.1f}″"
                      + (" · matches catalogue motion" if agrees else "")),
        })
    return pairs


def overlay_for_set(manifest: dict, source: str, epochs: list[dict]) -> dict:
    """Catalogue markers for a set, with grid pixel positions at every epoch (proper motion applied)."""
    from .views import grid_wcs
    ra0, dec0, fov = field_centre(manifest)
    res = cone(source, ra0, dec0, fov * 60.0 / math.sqrt(2) + 15.0, limit=3000 if source == "gaia" else 500)
    w = grid_wcs(manifest)
    n = manifest["grid"]["n"]
    jys = [jyear_from_mjd(e["mjd"]) for e in epochs]
    items = []
    for r in res["sources"]:
        if is_planet(r):  # exoplanets sit on their star: one marker is enough
            continue
        pix = []
        inside = False
        for jy in jys:
            pra, pdec = position_at(r, jy)
            x, y = (float(v) for v in w.world_to_pixel_values(pra, pdec))
            pix.append([round(x, 2), round(y, 2)])
            inside |= -1 <= x <= n and -1 <= y <= n
        if inside:
            items.append({**{k: r.get(k) for k in ("id", "otype", "ra", "dec", "pmra", "pmdec", "mag", "epoch")},
                          "pix": pix})
    return {"source": source, "provider": res["provider"], "epochs": [e["index"] for e in epochs],
            "count": len(items), "truncated": res.get("truncated", False), "sources": items}
