"""SPHEREx image search via IRSA SIA2 (collection spherex_dr1).

GET <IRSA_SIA_URL>?COLLECTION=spherex_dr1&POS=circle <ra> <dec> <radius_deg>
returns a VOTable. We keep only Level-2 FITS images, read the date from
t_min/t_max (MJD) and the footprint from s_region, and parse detector,
observation id and planning period from the file name.
"""
from __future__ import annotations

import io
import json
import logging
import math
import re
import time
import warnings
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import requests
from astropy.io import fits
from astropy.io.votable import parse_single_table
from astropy.wcs import WCS, FITSFixedWarning

from . import cache as cache_mod
from . import config
from .errors import BadRequest, UpstreamError
from .fitsstream import FitsStreamError, read_hdus_prefix
from .net import AdaptiveGate, breaker, request_with_mirrors, retry_after_s, session

log = logging.getLogger(__name__)
try:  # astropy prints an INFO block for every WAVE-TAB WCS (SIP note); keep the log readable
    from astropy import log as _astropy_log
    _astropy_log.setLevel("WARNING")
except Exception:  # noqa: BLE001
    pass

SOURCE_LABEL = "NASA IRSA DATA"

# e.g. level2_2025W19_2B_0182_2D1_spx_l2b-v12-2025-162.fits
#      period=2025W19_2B  obs=0182  exposure=2  detector=1
_FILE_RE = re.compile(
    r"level2_(?P<period>\d{4}W\d{2}_\d+[A-Z]?)_(?P<obs>\d+)_(?P<exp>\d+)D(?P<det>[1-6])",
    re.IGNORECASE,
)
_DET_FALLBACK_RE = re.compile(r"D(?P<det>[1-6])(?:_|\.fits)", re.IGNORECASE)


def parse_filename(url: str) -> dict:
    """Extract planning period, observation id and detector from a Level-2 file name."""
    name = urlparse(url).path.rsplit("/", 1)[-1]
    m = _FILE_RE.search(name)
    if m:
        period, obs, exp, det = m.group("period", "obs", "exp", "det")
        return {
            "file_name": name,
            "planning_period": period.upper(),
            "obs_id": f"{period.upper()}_{obs}_{exp}",
            "detector": int(det),
        }
    m = _DET_FALLBACK_RE.search(name)
    return {
        "file_name": name,
        "planning_period": None,
        "obs_id": name.rsplit(".", 1)[0],
        "detector": int(m.group("det")) if m else None,
    }


def is_level2_fits(url: str) -> bool:
    path = urlparse(url).path
    return "/level2/" in path and path.lower().endswith(".fits")


# ---------------------------------------------------------------- footprints
def parse_s_region(s_region: str) -> list[tuple[float, float]] | None:
    """Parse 'POLYGON [ICRS] ra1 dec1 ra2 dec2 ...' into [(ra, dec), ...]."""
    if not s_region:
        return None
    tokens = s_region.replace(",", " ").split()
    if not tokens or tokens[0].upper() != "POLYGON":
        return None
    nums: list[float] = []
    for tok in tokens[1:]:
        try:
            nums.append(float(tok))
        except ValueError:
            if nums:  # a second shape keyword: stop at the first polygon
                break
            continue  # frame name such as ICRS / J2000
    if len(nums) < 6 or len(nums) % 2:
        return None
    return [(nums[i] % 360.0, nums[i + 1]) for i in range(0, len(nums), 2)]


def _gnomonic(ra, dec, ra0, dec0):
    ra, dec, ra0, dec0 = map(np.radians, (ra, dec, ra0, dec0))
    cosc = np.sin(dec0) * np.sin(dec) + np.cos(dec0) * np.cos(dec) * np.cos(ra - ra0)
    x = np.cos(dec) * np.sin(ra - ra0) / cosc
    y = (np.cos(dec0) * np.sin(dec) - np.sin(dec0) * np.cos(dec) * np.cos(ra - ra0)) / cosc
    return x, y, cosc


def footprint_contains(polygon: list[tuple[float, float]] | None, ra: float, dec: float) -> bool:
    """True if (ra, dec) lies inside the polygon. Safe across RA=0 and near the poles."""
    if not polygon or len(polygon) < 3:
        return False
    pra = np.array([p[0] for p in polygon])
    pdec = np.array([p[1] for p in polygon])
    x, y, cosc = _gnomonic(pra, pdec, ra, dec)
    if np.any(cosc <= 0):  # vertex more than 90 deg away: cannot contain the point
        return False
    # Ray casting from the origin (the target) along +x.
    inside = False
    n = len(x)
    for i in range(n):
        x1, y1, x2, y2 = x[i], y[i], x[(i + 1) % n], y[(i + 1) % n]
        if (y1 > 0) != (y2 > 0):
            x_cross = x1 + (0 - y1) * (x2 - x1) / (y2 - y1)
            if x_cross > 0:
                inside = not inside
    return bool(inside)


# ---------------------------------------------------------------- VOTable parsing
def _col(row, table, name):
    return row[name] if name in table.colnames else None


def _to_float(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _to_str(v) -> str:
    if v is None or np.ma.is_masked(v):
        return ""
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    return str(v)


def parse_votable(content: bytes, ra: float, dec: float, collection: str) -> list[dict]:
    try:
        table = parse_single_table(io.BytesIO(content)).to_table(use_names_over_ids=True)
    except Exception as exc:  # noqa: BLE001
        raise UpstreamError(f"IRSA returned an unreadable VOTable ({type(exc).__name__})") from exc
    if "access_url" not in table.colnames:
        raise UpstreamError("IRSA response has no access_url column")
    out: list[dict] = []
    for row in table:
        url = _to_str(row["access_url"]).strip()
        if not url or not is_level2_fits(url):
            continue
        t_min = _to_float(_col(row, table, "t_min"))
        t_max = _to_float(_col(row, table, "t_max"))
        if t_min is None and t_max is None:
            continue
        t_min = t_min if t_min is not None else t_max
        t_max = t_max if t_max is not None else t_min
        polygon = parse_s_region(_to_str(_col(row, table, "s_region")))
        info = parse_filename(url)
        out.append({
            "url": url,
            "collection": collection,
            "detector": info["detector"],
            "obs_id": info["obs_id"],
            "planning_period": info["planning_period"],
            "file_name": info["file_name"],
            "mjd": 0.5 * (t_min + t_max),
            "mjd_start": t_min,
            "mjd_end": t_max,
            "footprint": [[a, b] for a, b in polygon] if polygon else None,
            "contains_target": footprint_contains(polygon, ra, dec) if polygon else None,
        })
    return out


# ---------------------------------------------------------------- search
def _validate(ra: float, dec: float, radius_deg: float) -> None:
    if not (math.isfinite(ra) and 0.0 <= ra < 360.0):
        raise BadRequest("RA must be between 0 and 360 degrees")
    if not (math.isfinite(dec) and -90.0 <= dec <= 90.0):
        raise BadRequest("Dec must be between -90 and +90 degrees")
    if not (math.isfinite(radius_deg) and 0.0 < radius_deg <= 1.0):
        raise BadRequest("Search radius must be between 0 and 1 degree")


STALE_MATCH_DEG = 0.01  # 36″: a saved search this close is reused when IRSA is down


def _nearest_saved_search(ra: float, dec: float, radius_deg: float,
                          collections: list[str]) -> dict | None:
    """Closest earlier search result on disk (expired or not) within STALE_MATCH_DEG.

    Used only when IRSA fails. The caller re-centres the field on the saved position so
    the cutouts already on disk are reused instead of downloaded.
    """
    folder = Path(cache_mod.get_cache().dir) / "json" / cache_mod.NS_SEARCH
    best, best_sep = None, STALE_MATCH_DEG
    cos_dec = math.cos(math.radians(dec))
    for f in folder.glob("*.json") if folder.is_dir() else []:
        try:
            value = json.loads(f.read_text(encoding="utf-8")).get("value") or {}
            q = value["query"]
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if not value.get("count") or value.get("collections") != collections:
            continue
        if q.get("radius_deg", 0) < radius_deg:
            continue
        dra = ((q["ra"] - ra + 180.0) % 360.0 - 180.0) * cos_dec
        sep = math.hypot(dra, q["dec"] - dec)
        if sep <= best_sep:
            best, best_sep = value, sep
    return best


def search(ra: float, dec: float, radius_deg: float, *, use_cache: bool = True,
           collections: list[str] | None = None) -> dict:
    """Search SPHEREx Level-2 images overlapping a circle. Cached 30 min."""
    _validate(ra, dec, radius_deg)
    collections = list(collections or config.settings.spherex_collections)
    key = cache_mod.make_key(
        cache_mod.NS_SEARCH, "sia2", round(ra, 6), round(dec, 6), round(radius_deg, 6),
        collections, config.settings.irsa_sia_url, config.CODE_VERSION)
    cache = cache_mod.get_cache()
    if use_cache:
        hit = cache.get_json(key)
        if hit is not None:
            hit["cached"] = True
            return hit

    observations: list[dict] = []
    errors: list[str] = []
    for collection in collections:
        params = {"COLLECTION": collection, "POS": f"circle {ra:.7f} {dec:.7f} {radius_deg:.7f}"}
        try:
            resp = request_with_mirrors("IRSA SIA", [config.settings.irsa_sia_url], params=params)
        except UpstreamError as exc:
            errors.append(f"{collection}: {exc.message}")
            continue
        observations.extend(parse_votable(resp.content, ra, dec, collection))
    if errors and not observations and len(errors) == len(collections):
        # NASA's archive is down. Fall back to an image list saved earlier for this spot.
        stale = _nearest_saved_search(ra, dec, radius_deg, collections)
        if stale is not None:
            stale["cached"] = True
            stale["stale"] = True
            stale["warnings"] = list(stale.get("warnings") or []) + [
                "NASA IRSA is not responding; using the image list saved earlier for this field."]
            return stale
        raise UpstreamError(
            "NASA's IRSA archive is not responding right now (" + " | ".join(errors) + "). "
            "This is a problem on NASA's side, not in COSMIC. Fields opened earlier still work; "
            "please try this one again in a few minutes.")

    # De-duplicate (same file listed twice) and sort by date.
    unique = {o["url"]: o for o in observations}
    observations = sorted(unique.values(), key=lambda o: (o["mjd"], o["detector"] or 0, o["url"]))
    result = {
        "source": SOURCE_LABEL,
        "collections": collections,
        "query": {"ra": ra, "dec": dec, "radius_deg": radius_deg},
        "count": len(observations),
        "count_containing_target": sum(1 for o in observations if o["contains_target"]),
        "detectors": sorted({o["detector"] for o in observations if o["detector"]}),
        "mjd_range": ([observations[0]["mjd"], observations[-1]["mjd"]] if observations else None),
        "observations": observations,
        "warnings": errors,
        "cached": False,
    }
    # Do not cache a partial result from a failed collection for the full 30 min.
    cache.set_json(key, result, ttl=config.TTL_IRSA_SEARCH if not errors else 120)
    return result


# ================================================================= frame selection
N_DETECTORS = 6
PASS_GAP_DAYS = 30.0  # a gap longer than this starts a new survey pass (epoch)


def group_passes(observations: list[dict], gap_days: float = PASS_GAP_DAYS) -> list[list[dict]]:
    """Split date-sorted observations into survey passes separated by > gap_days."""
    obs = sorted(observations, key=lambda o: o["mjd"])
    passes: list[list[dict]] = []
    for o in obs:
        if passes and o["mjd"] - passes[-1][-1]["mjd"] <= gap_days:
            passes[-1].append(o)
        else:
            passes.append([o])
    return passes


def _spread(items: list[dict], k: int) -> list[dict]:
    """Pick k items spread evenly in time (items sorted by mjd)."""
    n = len(items)
    if k >= n:
        return list(items)
    if k <= 0:
        return []
    if k == 1:
        return [items[n // 2]]
    idx = np.round(np.linspace(0, n - 1, k)).astype(int)
    return [items[i] for i in sorted(set(idx.tolist()))]


def _epoch_label(mjd_start: float, mjd_end: float) -> str:
    from astropy.time import Time
    a, b = Time([mjd_start, mjd_end], format="mjd").to_datetime()
    if (a.year, a.month) == (b.year, b.month):
        return a.strftime("%b %Y")
    if a.year == b.year:
        return f"{a.strftime('%b')}–{b.strftime('%b %Y')}"
    return f"{a.strftime('%b %Y')}–{b.strftime('%b %Y')}"


def select_frames(observations: list[dict], max_frames: int = 40,
                  gap_days: float = PASS_GAP_DAYS) -> dict:
    """Choose which images to download, before downloading anything.

    1. Keep only images whose footprint contains the target (unknown footprint: keep).
    2. Group into survey passes (epochs).
    3. If there are more passes than max_frames // 6, keep passes evenly spread in time.
    4. Share the frame budget round-robin over (epoch, detector) cells so every
       epoch gets every detector it has, then spread each cell's picks in time.
    """
    usable = [o for o in observations if o.get("contains_target") is not False and o.get("detector")]
    passes = group_passes(usable, gap_days)
    if not passes:
        return {"frames": [], "epochs": [], "n_candidates": 0, "n_passes_total": 0}

    max_passes = max(1, max_frames // N_DETECTORS)
    n_total = len(passes)
    if len(passes) > max_passes:
        keep = sorted(set(np.round(np.linspace(0, len(passes) - 1, max_passes)).astype(int).tolist()))
        passes = [passes[i] for i in keep]

    cells: dict[tuple[int, int], list[dict]] = {}
    for p, members in enumerate(passes):
        for o in members:
            cells.setdefault((p, o["detector"]), []).append(o)
    order = [(p, d) for p in range(len(passes)) for d in range(1, N_DETECTORS + 1) if (p, d) in cells]
    alloc = {c: 0 for c in order}
    budget = max_frames
    while budget > 0:
        progressed = False
        for c in order:
            if budget > 0 and alloc[c] < len(cells[c]):
                alloc[c] += 1
                budget -= 1
                progressed = True
        if not progressed:
            break

    frames: list[dict] = []
    epochs: list[dict] = []
    for p, members in enumerate(passes):
        picked: list[dict] = []
        for d in range(1, N_DETECTORS + 1):
            if (p, d) in cells:
                picked.extend(_spread(cells[(p, d)], alloc[(p, d)]))
        for o in picked:
            frames.append({**o, "epoch": p})
        dets = sorted({o["detector"] for o in members})
        mjd0, mjd1 = members[0]["mjd"], members[-1]["mjd"]
        epochs.append({
            "index": p,
            "label": _epoch_label(mjd0, mjd1),
            "mjd_start": mjd0,
            "mjd_end": mjd1,
            "mjd_mean": float(np.mean([o["mjd"] for o in picked])) if picked else 0.5 * (mjd0 + mjd1),
            "n_available": len(members),
            "n_selected": len(picked),
            "detectors": dets,
            "missing_detectors": [d for d in range(1, N_DETECTORS + 1) if d not in dets],
        })
    frames.sort(key=lambda o: (o["mjd"], o["detector"]))
    return {"frames": frames, "epochs": epochs, "n_candidates": len(usable), "n_passes_total": n_total}


# ================================================================= cutouts
NEEDED_HDUS = {"IMAGE", "FLAGS", "VARIANCE", "ZODI"}
MAX_BUSY_RETRIES = 8          # "server busy" replies tolerated per frame
CUTOUT_BREAKER = "IRSA cutout"
CUTOUT_BREAKER_THRESHOLD = 5  # consecutive real failures before skipping the service
CONNECT_TIMEOUT_S = 10.0
_VERSION_RE = re.compile(r"l2b-(v\d+)", re.IGNORECASE)

cutout_gate = AdaptiveGate(config.settings.http_workers)


class CutoutBusy(Exception):
    def __init__(self, retry_after: float):
        super().__init__(f"server busy (retry after {retry_after:g}s)")
        self.retry_after = retry_after


class CutoutError(Exception):
    pass


def cutout_url(url: str, ra: float, dec: float, size_deg: float) -> str:
    base = url.split("?", 1)[0]
    return f"{base}?center={ra:.6f},{dec:.6f}&size={size_deg:.5f}"


def cutout_key(url: str, ra: float, dec: float, size_deg: float) -> str:
    return cache_mod.make_key(cache_mod.NS_CUTOUT, url.split("?", 1)[0], round(ra, 6),
                              round(dec, 6), round(size_deg, 5), config.CODE_VERSION)


def _pipeline_version(url: str) -> str:
    m = _VERSION_RE.search(url)
    return m.group(1).lower() if m else "unknown"


def _wave_key(detector: int, version: str) -> str:
    return cache_mod.make_key("wave", detector, version)


def has_wave_table(detector: int | None, url: str) -> bool:
    if not detector:
        return True  # nothing we can do without a detector number
    return cache_mod.get_cache().get_bytes(_wave_key(detector, _pipeline_version(url))) is not None


def wavelength_at(header: fits.Header, wave_fits: bytes, x: float, y: float) -> tuple[float, float] | None:
    """(wavelength, bandwidth) in µm at cutout pixel (x, y), from the WAVE-TAB WCS."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            hdul = fits.HDUList.fromstring(wave_fits)
            w = WCS(header, fobj=hdul, key="W")
            lam, bw = w.pixel_to_world_values(x, y)
        lam, bw = float(lam), float(bw)
        return (lam, bw) if math.isfinite(lam) else None
    except Exception as exc:  # noqa: BLE001
        log.debug("wavelength lookup failed: %s", exc)
        return None


def _flag_names(flags_header: fits.Header) -> dict[int, str]:
    names = {bit: name for name, bit in config.FLAG_BITS.items()}
    for k in flags_header:
        if k.startswith("MSKN") and k[4:].isdigit():
            names[int(k[4:])] = str(flags_header[k]).strip()
    return names


def _download(url: str, want_full: bool, gate: AdaptiveGate) -> bytes:
    """One HTTP attempt. Raises CutoutBusy / CutoutError."""
    if breaker.is_open(CUTOUT_BREAKER):
        raise CutoutError("IRSA cutout service is down (skipped for 2 min)")
    gate.acquire()
    outcome, wait = "error", 0.0
    try:
        try:
            resp = session.get(url, stream=True,
                               timeout=(CONNECT_TIMEOUT_S, config.settings.http_timeout_s))
        except requests.Timeout as exc:
            raise CutoutError(f"timed out after {config.settings.http_timeout_s:g}s") from exc
        except requests.RequestException as exc:
            raise CutoutError(f"connection failed ({type(exc).__name__})") from exc
        try:
            if resp.status_code in (429, 503):
                outcome, wait = "busy", retry_after_s(resp, 5.0)
                raise CutoutBusy(wait)
            if resp.status_code != 200:
                raise CutoutError(f"HTTP {resp.status_code}")
            chunks = resp.iter_content(chunk_size=64 * 1024)
            try:
                data, _ = read_hdus_prefix(chunks, None if want_full else NEEDED_HDUS)
            except (FitsStreamError, requests.RequestException) as exc:
                raise CutoutError(f"bad FITS stream ({exc})") from exc
            outcome = "ok"
            return data
        finally:
            resp.close()  # stopping early: drop the rest of the file
    finally:
        gate.release(outcome, wait)
        if outcome == "ok":
            breaker.record_success(CUTOUT_BREAKER)


def fetch_cutout(obs: dict, ra: float, dec: float, size_deg: float, *,
                 gate: AdaptiveGate | None = None, want_full: bool | None = None) -> dict:
    """Download (or load from disk) one cutout centred on (ra, dec).

    Stores float32 arrays in .npz: image = IMAGE − ZODI with bad FLAGS → NaN,
    variance (same mask), raw flags (uint32). The IMAGE header (sky WCS) goes
    into the metadata. Returns {"key", "path", "meta", "cached"}.
    """
    cache = cache_mod.get_cache()
    key = cutout_key(obs["url"], ra, dec, size_deg)
    loaded = cache.load_arrays(key)
    if loaded is not None:
        return {"key": key, "path": str(cache.array_path(key)), "meta": loaded[1], "cached": True}

    gate = gate or cutout_gate
    detector = obs.get("detector")
    version = _pipeline_version(obs["url"])
    if want_full is None:  # default: full file only if this detector's WCS-WAVE table is unknown
        want_full = not has_wave_table(detector, obs["url"])
    t0 = time.perf_counter()
    data = _download(cutout_url(obs["url"], ra, dec, size_deg), want_full, gate)
    t_dl = time.perf_counter() - t0

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FITSFixedWarning)
            hdul = fits.HDUList.fromstring(data)
            names = {h.name.upper() for h in hdul}
            missing = NEEDED_HDUS - names
            if missing:
                raise CutoutError(f"cutout lacks {', '.join(sorted(missing))}")
            header = hdul["IMAGE"].header.copy()
            image = np.asarray(hdul["IMAGE"].data, dtype=np.float32)
            zodi = np.asarray(hdul["ZODI"].data, dtype=np.float32)
            var = np.asarray(hdul["VARIANCE"].data, dtype=np.float32)
            flags = np.asarray(hdul["FLAGS"].data)
            flags = flags.astype(np.int64).astype(np.uint32) if flags.dtype.kind == "i" else flags.astype(np.uint32)
            flag_names = _flag_names(hdul["FLAGS"].header)
            if want_full and "WCS-WAVE" in names and detector:
                buf = io.BytesIO()
                fits.HDUList([fits.PrimaryHDU(), hdul["WCS-WAVE"].copy()]).writeto(buf)
                cache.set_bytes(_wave_key(detector, version), buf.getvalue(), ttl=None)
            sky = WCS(header)
            tx, ty = (float(v) for v in sky.world_to_pixel_values(ra, dec))
    except CutoutError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise CutoutError(f"unreadable cutout ({type(exc).__name__}: {exc})") from exc

    bad = (flags & np.uint32(config.BAD_FLAG_MASK)) != 0
    sb = image - zodi
    sb[bad | ~np.isfinite(sb)] = np.nan
    var = var.copy()
    var[bad | ~np.isfinite(var) | (var <= 0)] = np.nan

    ny, nx = image.shape
    ix, iy = int(round(tx)), int(round(ty))
    near = flags[max(0, iy - 1):iy + 2, max(0, ix - 1):ix + 2] if (0 <= ix < nx and 0 <= iy < ny) else flags[:0, :0]
    near_bits = int(np.bitwise_or.reduce(near.ravel())) if near.size else 0
    wave_bytes = cache.get_bytes(_wave_key(detector, version)) if detector else None
    wl = wavelength_at(header, wave_bytes, tx, ty) if wave_bytes else None

    def hdr(k, default=None):
        v = header.get(k, default)
        return v if isinstance(v, (int, float, str)) else default

    meta = {
        "url": obs["url"],
        "obs_id": obs.get("obs_id"),
        "detector": detector,
        "planning_period": obs.get("planning_period"),
        "pipeline_version": version,
        "mjd": float(hdr("MJD-AVG", obs.get("mjd"))),
        "date_obs": hdr("DATE-AVG", hdr("DATE-OBS")),
        "center": [ra, dec],
        "size_deg": size_deg,
        "shape": [ny, nx],
        "target_pix": [tx, ty],
        "target_inside": bool(-0.5 <= tx <= nx - 0.5 and -0.5 <= ty <= ny - 0.5),
        "bad_fraction": float(np.mean(~np.isfinite(sb))),
        "flags_at_target": [flag_names.get(b, f"BIT{b}") for b in range(32) if near_bits & (1 << b)],
        "wavelength_um": wl[0] if wl else None,
        "bandwidth_um": wl[1] if wl else None,
        "psf_fwhm_arcsec": hdr("PSF_FWHM"),
        "bunit": "MJy/sr",
        "header": header.tostring(),
        "download_s": round(t_dl, 3),
        "bytes": len(data),
        "full_file": want_full,
    }
    cache.save_arrays(key, {"image": sb.astype(np.float32), "variance": var.astype(np.float32),
                            "flags": flags}, meta=meta)
    return {"key": key, "path": str(cache.array_path(key)), "meta": meta, "cached": False}


def ensure_wavelength(meta: dict) -> dict:
    """Fill wavelength_um/bandwidth_um from the cached WCS-WAVE table if missing."""
    if meta.get("wavelength_um") is not None or not meta.get("detector"):
        return meta
    wave = cache_mod.get_cache().get_bytes(
        _wave_key(meta["detector"], meta.get("pipeline_version") or _pipeline_version(meta["url"])))
    if wave is None or "header" not in meta:
        return meta
    wl = wavelength_at(fits.Header.fromstring(meta["header"]), wave, *meta["target_pix"])
    if wl:
        meta = {**meta, "wavelength_um": wl[0], "bandwidth_um": wl[1]}
    return meta


def fetch_cutout_with_retry(obs: dict, ra: float, dec: float, size_deg: float, *,
                            gate: AdaptiveGate | None = None, want_full: bool | None = None) -> dict:
    """fetch_cutout with the set policy: real failures retry once then give up;
    "server busy" replies wait (via the gate) and retry up to MAX_BUSY_RETRIES.
    Returns the fetch result, or {"error": reason, "obs": obs}."""
    failures, busy = 0, 0
    while True:
        try:
            return fetch_cutout(obs, ra, dec, size_deg, gate=gate, want_full=want_full)
        except CutoutBusy as exc:
            busy += 1
            if busy > MAX_BUSY_RETRIES:
                return {"error": f"IRSA busy after {busy} tries", "obs": obs}
            time.sleep(min(1.0, exc.retry_after) * 0.1)  # the gate enforces the real pause
        except CutoutError as exc:
            msg = str(exc)
            if "skipped" in msg:
                return {"error": msg, "obs": obs}
            failures += 1
            breaker.record_failure(CUTOUT_BREAKER, msg, threshold=CUTOUT_BREAKER_THRESHOLD)
            if failures >= 2:
                return {"error": msg, "obs": obs}
            time.sleep(1.0)
