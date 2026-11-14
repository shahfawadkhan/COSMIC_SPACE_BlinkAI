"""Turn user input into a sky position.

Order: coordinates typed by the user -> the five built-in targets -> CDS Sesame
(astropy SkyCoord.from_name, 6 s timeout). Name lookups are cached 30 days.
Moving built-in targets come back at TODAY's position (proper motion applied).
"""
from __future__ import annotations

import math
import re
import threading

from . import cache as cache_mod
from . import config, targets
from .coords import coord_info
from .errors import BadRequest, NotFound, UpstreamError
from .net import breaker

SESAME_TIMEOUT_S = 6.0
_sesame_lock = threading.Lock()
_NUM = r"[+-]?\d+(?:\.\d*)?"


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower().replace("−", "-"))


def parse_coordinates(text: str) -> tuple[float, float] | None:
    """'133.795 -7.245', '08h55m10.83s -07d14m42.5s', '08:55:10.83 -07:14:42.5',
    '08 55 10.83 -07 14 42.5'. Returns (ra, dec) degrees or None if it is not coordinates."""
    t = text.strip().replace("−", "-").replace(",", " ")
    if not t or re.search(r"[abcefgijklnopqrtuvwxyz]", t.lower()):  # letters other than d h m s
        return None
    nums = re.findall(_NUM, t)
    try:
        if len(nums) == 2 and not re.search(r"[hms:d]", t.lower()):
            ra, dec = float(nums[0]), float(nums[1])
        else:
            from astropy import units as u
            from astropy.coordinates import SkyCoord
            if len(nums) == 6 and not re.search(r"[hms:d]", t.lower()):
                t = f"{nums[0]}h{nums[1]}m{nums[2]}s {nums[3]}d{nums[4]}m{nums[5]}s"
            c = SkyCoord(t, unit=(u.hourangle, u.deg), frame="icrs")
            ra, dec = float(c.ra.deg), float(c.dec.deg)
    except Exception:  # noqa: BLE001
        return None
    if not (0 <= ra < 360 and -90 <= dec <= 90):
        raise BadRequest("Coordinates out of range: RA 0-360°, Dec −90…+90°")
    return ra, dec


def _builtin(q: str) -> targets.Target | None:
    n = _norm(q)
    for t in targets.TARGETS:
        if n in {_norm(t.id), _norm(t.name), _norm(t.simbad_name)}:
            return t
    aliases = {"wise0855": "wise0855", "wise08550714": "wise0855", "barnards": "barnard",
               "barnardsstar": "barnard", "epsindb": "epsindib", "epsilonindib": "epsindib",
               "rwaurigae": "rwaur", "rdraconis": "rdra"}
    return targets.get_target(aliases[n]) if n in aliases else None


def _sesame(q: str) -> tuple[float, float]:
    name = "CDS Sesame"
    if breaker.is_open(name):
        raise UpstreamError("Name service (CDS Sesame) is down; try coordinates instead")
    from astropy.coordinates import SkyCoord
    from astropy.coordinates.name_resolve import NameResolveError
    from astropy.utils.data import conf
    try:
        with _sesame_lock, conf.set_temp("remote_timeout", SESAME_TIMEOUT_S):
            c = SkyCoord.from_name(q)
    except NameResolveError as exc:
        msg = str(exc)
        if "Unable to find coordinates" in msg:
            raise NotFound(f"No object called “{q}” was found") from exc
        breaker.record_failure(name, msg[:120])
        raise UpstreamError("Name service (CDS Sesame) did not answer; try coordinates instead") from exc
    except Exception as exc:  # noqa: BLE001
        breaker.record_failure(name, type(exc).__name__)
        raise UpstreamError("Name service (CDS Sesame) failed; try coordinates instead") from exc
    breaker.record_success(name)
    return float(c.ra.deg), float(c.dec.deg)


def resolve(q: str) -> dict:
    q = (q or "").strip()
    if not q:
        raise BadRequest("Type a name or coordinates")
    if len(q) > 120:
        raise BadRequest("Input is too long")
    pos = parse_coordinates(q)
    if pos is not None:
        ra, dec = pos
        return {"query": q, "name": None, "ra": ra, "dec": dec, "pmra": 0.0, "pmdec": 0.0,
                "epoch": None, "kind": "position", "source": "coordinates",
                "coords": coord_info(ra, dec)}
    t = _builtin(q)
    if t is not None:
        info = targets.target_info(t)
        ra, dec = info["today"]["ra"], info["today"]["dec"]
        return {"query": q, "name": t.name, "main_id": t.simbad_name, "target_id": t.id, "ra": ra, "dec": dec,
                "catalog_ra": t.ra, "catalog_dec": t.dec,
                "pmra": t.pmra, "pmdec": t.pmdec, "epoch": t.epoch, "kind": t.kind,
                "fov_arcmin": t.fov_arcmin, "source": "built-in target (proper motion applied to today)",
                "coords": coord_info(ra, dec)}
    return _named(q)


def _named(q: str) -> dict:
    """Sesame position (J2000), then a SIMBAD cone of 10 rows for main_id and proper motion.
    If Sesame is down, ask SIMBAD's identifier table directly."""
    from . import catalog
    cache = cache_mod.get_cache()
    key = cache_mod.make_key(cache_mod.NS_NAME, "named", 2, _norm(q))
    hit = cache.get_json(key)
    if hit is None:
        try:
            ra0, dec0 = _sesame(q)
            via = "CDS Sesame + SIMBAD"
        except UpstreamError:
            ra0, dec0 = _simbad_ident(q)  # raises NotFound / UpstreamError
            via = "SIMBAD"
        row = None
        try:
            row = catalog.simbad_at(ra0, dec0, 10.0)
        except UpstreamError:
            pass  # position is still good; name and proper motion unknown
        hit = {"ra": ra0, "dec": dec0, "via": via,
               "main_id": row["id"] if row else None,
               "pmra": row.get("pmra") if row else None, "pmdec": row.get("pmdec") if row else None,
               "otype": row.get("otype") if row else None}
        cache.set_json(key, hit, ttl=config.TTL_CATALOG)
    ra0, dec0 = hit["ra"], hit["dec"]
    pmra, pmdec = hit.get("pmra"), hit.get("pmdec")
    ra, dec, note = ra0, dec0, "Catalogue position (J2000); no proper motion known."
    if pmra or pmdec:
        ra, dec = targets.propagate(ra0, dec0, pmra or 0.0, pmdec or 0.0, 2000.0, targets.julian_year())
        ra, dec = round(ra, targets.ROUND_DEG) % 360.0, round(dec, targets.ROUND_DEG)
        note = "Proper motion applied: position is for today."
    return {"query": q, "name": hit.get("main_id") or q, "main_id": hit.get("main_id"),
            "ra": ra, "dec": dec, "catalog_ra": ra0, "catalog_dec": dec0,
            "pmra": pmra, "pmdec": pmdec, "epoch": 2000.0, "otype": hit.get("otype"),
            "kind": "moving" if (pmra or pmdec) and math.hypot(pmra or 0, pmdec or 0) > 200 else "named",
            "source": hit.get("via", "CDS Sesame"), "note": note, "coords": coord_info(ra, dec)}


def _simbad_ident(q: str) -> tuple[float, float]:
    from .net import request_with_mirrors
    safe = q.replace("'", "''")
    adql = ("SELECT TOP 1 b.ra, b.dec FROM basic AS b JOIN ident AS i ON i.oidref = b.oid "
            f"WHERE i.id = '{safe}'")
    resp = request_with_mirrors("SIMBAD", config.settings.simbad_tap_urls, "POST", timeout=20,
                                data={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql})
    lines = [ln for ln in resp.content.decode("utf-8", "replace").splitlines() if ln.strip()]
    if len(lines) < 2:
        raise NotFound(f"No object called “{q}” was found")
    ra, dec = (float(v) for v in lines[1].split(",")[:2])
    return ra, dec
