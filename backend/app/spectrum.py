"""Photometry of one source in every SPHEREx image: light curve, spectrum and astrometry.

GET /api/spectrum?ra=&dec=&pm_ra=&pm_dec=&epoch=&aperture_arcsec=12&max_frames=40[&set_id=]
runs as a background job (same parameters = same job id; results cached 30 days).

Per image:
  * position moved to the image date with the proper motion (pm_ra = pmra*cos dec, mas/yr),
  * aperture photometry (radius = aperture_arcsec, sub-pixel weights) on IMAGE − ZODI,
    sky from a sigma-clipped annulus, flux converted MJy/sr -> mJy with the pixel solid angle,
  * wavelength and bandwidth at that pixel from the detector's WCS-WAVE table,
  * error from the VARIANCE plane plus the sky uncertainty, S/N,
  * flux-weighted centroid (astrometry) when S/N >= 5.
Masked pixels (OVERFLOW / NONLINEAR...) in the aperture mean no usable measurement: bright
stars such as Barnard's Star and R Dra saturate SPHEREx.

With set_id the set's cutouts already on disk are used (no second download). Without it the
images are searched and small cutouts downloaded.
No aperture correction is applied: fluxes are aperture fluxes (fine for relative light curves
and spectral shape; absolute values are low by the PSF fraction outside the aperture).
"""


from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import math
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_area

from . import cache as cache_mod
from . import config, irsa, sets
from .coords import coord_info
from .errors import BadRequest, NotFound
from .jobs import Job, jobs

log = logging.getLogger(__name__)

NS = "spectrum"
TTL = 30 * 24 * 3600
SNR_ASTROMETRY = 5.0
MASKED_LIMIT = 0.10       # more than 10 % of the aperture weight masked -> unusable
SATURATION_BITS = (1 << config.FLAG_BITS["OVERFLOW"]) | (1 << config.FLAG_BITS["NONLINEAR"])
SR_PER_DEG2 = (math.pi / 180.0) ** 2


# ------------------------------------------------------------------ photometry (pure)
def _weights(x0: float, y0: float, r: float, shape: tuple[int, int], sub: int = 5):
    """Sub-pixel aperture weights in a box around (x0, y0)."""
    ny, nx = shape
    xa, xb = max(0, int(math.floor(x0 - r - 1))), min(nx, int(math.ceil(x0 + r + 2)))
    ya, yb = max(0, int(math.floor(y0 - r - 1))), min(ny, int(math.ceil(y0 + r + 2)))
    if xa >= xb or ya >= yb:
        return None
    yy, xx = np.mgrid[ya:yb, xa:xb]
    off = (np.arange(sub) + 0.5) / sub - 0.5
    w = np.zeros(yy.shape)
    for dy in off:
        for dx in off:
            w += (np.hypot(xx + dx - x0, yy + dy - y0) <= r)
    return (slice(ya, yb), slice(xa, xb)), w / sub**2


def measure(image: np.ndarray, variance: np.ndarray | None, flags: np.ndarray | None, header: str | fits.Header,
            ra: float, dec: float, aperture_arcsec: float) -> dict:
    """Aperture photometry at (ra, dec). Returns flux (mJy), error, S/N, centroid and a status."""
    if isinstance(header, str):
        header = fits.Header.fromstring(header)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        w = WCS(header)
    x, y = (float(v) for v in w.world_to_pixel_values(ra, dec))
    area_deg2 = float(proj_plane_pixel_area(w.celestial))
    pix_arcsec = math.sqrt(area_deg2) * 3600.0
    omega = area_deg2 * SR_PER_DEG2
    r = aperture_arcsec / pix_arcsec
    r_in, r_out = max(2.5 * r, r + 2.0), max(2.5 * r, r + 2.0) + 3.0
    ny, nx = image.shape
    out = {"x": x, "y": y, "aperture_px": r, "pixel_arcsec": pix_arcsec}
    if not (r_out <= x <= nx - 1 - r_out and r_out <= y <= ny - 1 - r_out):
        return {**out, "status": "outside", "reason": "position too close to the image edge"}

    # sky: sigma-clipped annulus
    yy, xx = np.mgrid[0:ny, 0:nx]
    rr = np.hypot(xx - x, yy - y)
    sky_v = image[(rr >= r_in) & (rr <= r_out) & np.isfinite(image)]
    if sky_v.size < 10:
        return {**out, "status": "masked", "reason": "sky annulus is masked"}
    for _ in range(3):
        med = np.median(sky_v)
        sig = 1.4826 * np.median(np.abs(sky_v - med)) or np.std(sky_v)
        keep = np.abs(sky_v - med) < 3 * sig if sig > 0 else np.ones(sky_v.size, bool)
        if keep.all():
            break
        sky_v = sky_v[keep]
    sky, sky_sig, n_sky = float(np.median(sky_v)), float(1.4826 * np.median(np.abs(sky_v - np.median(sky_v)))), sky_v.size

    win = _weights(x, y, r, image.shape)
    sl, wts = win
    cut = image[sl]
    bad = ~np.isfinite(cut)
    masked_frac = float(wts[bad].sum() / max(wts.sum(), 1e-9))
    flag_bits = int(np.bitwise_or.reduce(flags[sl][wts > 0].ravel())) if flags is not None else 0
    if masked_frac > MASKED_LIMIT:
        saturated = bool(flag_bits & SATURATION_BITS) or bad[wts >= 0.5].any() and masked_frac > 0.3
        names = [k for k, b in config.FLAG_BITS.items() if flag_bits & (1 << b) and k in config.MASKED_FLAGS]
        return {**out, "status": "saturated" if saturated else "masked", "masked_fraction": masked_frac,
                "reason": ("no usable measurement – star saturated" if saturated
                           else f"no usable measurement – masked pixels in aperture ({', '.join(names) or 'flagged'})")}

    good = ~bad
    net = np.where(good, cut - sky, 0.0)
    wsum = float(wts[good].sum())
    flux_sb = float((wts * net).sum()) / max(wsum, 1e-9) * float(wts.sum())  # fill masked bits with the mean
    var_cut = variance[sl] if variance is not None else np.full(cut.shape, np.nan)
    var_term = float(np.nansum(np.where(good, wts**2 * var_cut, 0.0)))
    if not np.isfinite(var_term) or var_term <= 0:
        var_term = float((wts[good] ** 2).sum()) * sky_sig**2
    sky_term = (float(wts.sum()) ** 2) * sky_sig**2 / max(n_sky, 1)
    err_sb = math.sqrt(var_term + sky_term)
    flux_mjy = flux_sb * omega * 1e9
    err_mjy = err_sb * omega * 1e9
    snr = flux_mjy / err_mjy if err_mjy > 0 else float("nan")

    res = {**out, "status": "ok", "flux_mjy": flux_mjy, "err_mjy": err_mjy, "snr": snr,
           "sky_mjy_per_pix": sky * omega * 1e9, "masked_fraction": masked_frac}
    if snr >= SNR_ASTROMETRY:
        pos = np.clip(net, 0, None) * (wts > 0)
        if pos.sum() > 0:
            ys, xs = np.mgrid[sl]
            cx, cy = float((pos * xs).sum() / pos.sum()), float((pos * ys).sum() / pos.sum())
            cra, cdec = (float(v) for v in w.pixel_to_world_values(cx, cy))
            res.update({"centroid_x": cx, "centroid_y": cy, "centroid_ra": cra, "centroid_dec": cdec})
    return res


def propagate(ra: float, dec: float, pmra: float, pmdec: float, epoch: float, jyear: float) -> tuple[float, float]:
    dt = jyear - epoch
    cosd = max(1e-9, math.cos(math.radians(dec)))
    return (ra + pmra * dt / 3.6e6 / cosd) % 360.0, dec + pmdec * dt / 3.6e6


def fit_motion(rows: list[dict], ra0: float, dec0: float) -> dict | None:
    """Linear fit of centroid offsets (arcsec) vs time: measured proper motion. Needs >= 3 points."""
    pts = [r for r in rows if r.get("centroid_ra") is not None]
    if len(pts) < 3:
        return None
    t = np.array([r["jyear"] for r in pts])
    if t.max() - t.min() < 0.1:
        return None
    cosd = math.cos(math.radians(dec0))
    dx = np.array([((r["centroid_ra"] - ra0 + 540) % 360 - 180) * cosd * 3600 for r in pts])
    dy = np.array([(r["centroid_dec"] - dec0) * 3600 for r in pts])
    A = np.vstack([np.ones_like(t), t - t.mean()]).T
    out = {"n": len(pts), "baseline_yr": float(t.max() - t.min())}
    for name, v in (("ra", dx), ("dec", dy)):
        coef, *_ = np.linalg.lstsq(A, v, rcond=None)
        resid = v - A @ coef
        dof = max(1, len(v) - 2)
        cov = np.linalg.inv(A.T @ A) * float((resid**2).sum() / dof)
        out[f"pm{name}_mas_yr"] = float(coef[1] * 1000)
        out[f"pm{name}_err_mas_yr"] = float(math.sqrt(max(cov[1, 1], 0)) * 1000)
        out[f"rms_{name}_arcsec"] = float(np.sqrt((resid**2).mean()))
    return out


BLEND_EXTRA_ARCSEC = 6.0  # ~ PSF FWHM: a star this far outside the aperture still leaks light in


def flag_blends(rows: list[dict], p: dict) -> str:
    """Mark measurements whose aperture overlaps a Gaia DR3 star (moved to that date).
    The target itself (same place, similar proper motion) is not a blend."""
    from . import catalog
    from .coords import angular_sep_deg
    from .errors import UpstreamError
    meas = [r for r in rows if r["status"] == "ok"]
    if not meas:
        return "not needed"
    jy = float(np.mean([r["jyear"] for r in meas]))
    ra0, dec0 = propagate(p["ra"], p["dec"], p["pm_ra"], p["pm_dec"], p["epoch"], jy)
    try:
        cone = catalog.cone("gaia", ra0, dec0, 120.0, limit=800)
    except UpstreamError as exc:
        return f"Gaia unavailable ({exc.message}); blends not checked"
    pm_t = math.hypot(p["pm_ra"], p["pm_dec"])
    for r in meas:
        lim = r["aperture_px"] * r["pixel_arcsec"] + BLEND_EXTRA_ARCSEC
        hits = []
        for s in cone["sources"]:
            sra, sdec = catalog.position_at(s, r["jyear"])
            sep = angular_sep_deg(r["ra_expected"], r["dec_expected"], sra, sdec) * 3600.0
            if sep > lim:
                continue
            pm_s = math.hypot(s.get("pmra") or 0.0, s.get("pmdec") or 0.0)
            if sep < 2.0 and abs(pm_s - pm_t) <= max(50.0, 0.2 * pm_t):
                continue  # this is the target
            hits.append({"id": s["id"], "sep_arcsec": round(sep, 1), "gmag": s.get("mag")})
        if hits:
            r["blend"] = sorted(hits, key=lambda h: h["sep_arcsec"])[:3]
    return f"checked against {cone['provider']}"


# ------------------------------------------------------------------ job
def normalize(params: dict) -> dict:
    try:
        ra = float(params["ra"]) % 360.0
        dec = float(params["dec"])
    except (KeyError, TypeError, ValueError) as exc:
        raise BadRequest("ra and dec (degrees) are required") from exc
    if not -90 <= dec <= 90:
        raise BadRequest("Dec must be between -90 and +90")
    ap = float(params.get("aperture_arcsec") or 12.0)
    if not 3 <= ap <= 40:
        raise BadRequest("aperture_arcsec must be 3-40")
    mf = int(params.get("max_frames") or 40)
    if not 6 <= mf <= 200:
        raise BadRequest("max_frames must be 6-200")
    return {"ra": round(ra, 6), "dec": round(dec, 6), "pm_ra": float(params.get("pm_ra") or 0.0),
            "pm_dec": float(params.get("pm_dec") or 0.0), "epoch": float(params.get("epoch") or 2000.0),
            "aperture_arcsec": round(ap, 2), "max_frames": mf, "set_id": params.get("set_id") or None}


def job_id_for(p: dict) -> str:
    return "p" + hashlib.sha256(json.dumps({**p, "v": config.CODE_VERSION, "s": 1}, sort_keys=True).encode()).hexdigest()[:15]


def result_key(job_id: str) -> str:
    return cache_mod.make_key(NS, job_id)


def _frames_from_set(set_id: str) -> tuple[list[tuple[dict, dict]], dict]:
    manifest = sets.load_manifest(set_id)
    if manifest is None:
        raise NotFound(f"Set {set_id} is not built")
    cache = cache_mod.get_cache()
    req = manifest["request"]
    size = manifest.get("cutout_size_deg") or req["fov_arcmin"] / 60.0 * 1.2
    out, missing = [], 0
    for f in manifest["frames"]:
        loaded = cache.load_arrays(irsa.cutout_key(f["url"], req["ra"], req["dec"], size))
        if loaded is None:
            missing += 1
            continue
        out.append((f, {"arrays": loaded[0], "meta": loaded[1]}))
    return out, {"source": f"set {set_id} (cutouts already on disk)", "missing_cutouts": missing}


def _frames_downloaded(p: dict, job: Job) -> tuple[list[tuple[dict, dict]], dict]:
    jy_now = float(Time.now().jyear)
    ra, dec = propagate(p["ra"], p["dec"], p["pm_ra"], p["pm_dec"], p["epoch"], jy_now)
    search = irsa.search(ra, dec, 2.0 / 3600)
    frames = irsa.select_frames(search["observations"], p["max_frames"])["frames"]
    size = max(1.5 / 60.0, p["aperture_arcsec"] * 14 / 3600.0)
    job.set_stage("downloading", total=len(frames), message=f"Downloading {len(frames)} small cutouts")
    out, done = [], 0
    with ThreadPoolExecutor(max_workers=config.settings.http_workers) as pool:
        futs = {pool.submit(irsa.fetch_cutout_with_retry, f, ra, dec, size): f for f in frames}
        for fut in as_completed(futs):
            done += 1
            res = fut.result()
            if "error" not in res:
                loaded = cache_mod.get_cache().load_arrays(res["key"])
                if loaded:
                    out.append((futs[fut], {"arrays": loaded[0], "meta": loaded[1]}))
            job.progress(done)
    return out, {"source": "SPHEREx cutouts downloaded for this position", "missing_cutouts": len(frames) - len(out)}


def run(job: Job, p: dict, job_id: str) -> dict:
    t0 = time.perf_counter()
    job.set_stage("searching", message="Collecting SPHEREx images")
    frames, info = _frames_from_set(p["set_id"]) if p["set_id"] else _frames_downloaded(p, job)
    if not frames:
        raise NotFound("No SPHEREx images are available for this position")
    job.set_stage("rendering", total=len(frames), message="Measuring the source in every image")
    cache = cache_mod.get_cache()
    rows = []
    for k, (f, cut) in enumerate(frames, 1):
        meta = cut["meta"]
        mjd = float(meta.get("mjd") or f["mjd"])
        jy = float(Time(mjd, format="mjd").jyear)
        ra, dec = propagate(p["ra"], p["dec"], p["pm_ra"], p["pm_dec"], p["epoch"], jy)
        a = cut["arrays"]
        m = measure(a["image"], a.get("variance"), a.get("flags"), meta["header"], ra, dec, p["aperture_arcsec"])
        det = meta.get("detector") or f.get("detector")
        wave = None
        if det and m["status"] != "outside":
            wb = cache.get_bytes(irsa._wave_key(det, meta.get("pipeline_version") or irsa._pipeline_version(meta["url"])))
            if wb:
                wave = irsa.wavelength_at(fits.Header.fromstring(meta["header"]), wb, m["x"], m["y"])
        rows.append({
            "mjd": mjd, "date": Time(mjd, format="mjd").isot[:19], "jyear": jy, "detector": det,
            "obs_id": meta.get("obs_id") or f.get("obs_id"), "url": meta.get("url") or f.get("url"),
            "wavelength_um": wave[0] if wave else None, "bandwidth_um": wave[1] if wave else None,
            "ra_expected": ra, "dec_expected": dec, **m,
        })
        job.progress(k)
    rows.sort(key=lambda r: r["mjd"])
    blend_info = flag_blends(rows, p)
    ok = [r for r in rows if r["status"] == "ok"]
    sat = [r for r in rows if r["status"] == "saturated"]
    summary = {
        "n_images": len(rows), "n_measured": len(ok), "n_saturated": len(sat),
        "n_masked": sum(r["status"] == "masked" for r in rows), "n_outside": sum(r["status"] == "outside" for r in rows),
        "n_detected": sum((r.get("snr") or 0) >= 5 for r in ok),
        "n_blended": sum(bool(r.get("blend")) for r in ok),
        "blend_check": blend_info,
        "message": ("no usable measurement – star saturated" if sat and not ok else
                    f"{len(sat)} saturated image(s) left out" if sat else None),
    }
    if summary["n_blended"]:
        summary["blend_message"] = (f"In {summary['n_blended']} of {len(ok)} images the aperture overlaps a catalogued "
                                    "Gaia star: those fluxes include its light, and they are left out of the motion fit.")
    jy_ref = float(np.mean([r["jyear"] for r in rows]))
    ra_ref, dec_ref = propagate(p["ra"], p["dec"], p["pm_ra"], p["pm_dec"], p["epoch"], jy_ref)
    motion = fit_motion([r for r in ok if not r.get("blend")], *propagate(p["ra"], p["dec"], 0, 0, p["epoch"], jy_ref))
    for r in ok:  # astrometric residuals against the catalogue prediction, arcsec
        if r.get("centroid_ra") is not None:
            cosd = math.cos(math.radians(r["dec_expected"]))
            r["dra_arcsec"] = ((r["centroid_ra"] - r["ra_expected"] + 540) % 360 - 180) * cosd * 3600
            r["ddec_arcsec"] = (r["centroid_dec"] - r["dec_expected"]) * 3600
    result = {
        "job_id": job_id, "params": p, "source": irsa.SOURCE_LABEL, "frames_from": info["source"],
        "missing_cutouts": info["missing_cutouts"], "position": coord_info(ra_ref, dec_ref),
        "units": {"flux": "mJy (aperture flux, no aperture correction)", "wavelength": "µm"},
        "summary": summary, "motion_fit": motion, "rows": rows,
        "timings_s": {"total": round(time.perf_counter() - t0, 2)},
    }
    cache.set_json(result_key(job_id), result, ttl=TTL)
    return result


def start_or_get(params: dict) -> dict:
    p = normalize(params)
    jid = job_id_for(p)
    done = cache_mod.get_cache().get_json(result_key(jid))
    if done is not None:
        return {"job_id": jid, "state": "done", "stage": "done", "progress": {"done": 1, "total": 1}, "result": done}
    status = jobs.get(jid)
    if status is None or status.get("state") == "error" and jobs.get_job(jid) is None:
        jobs.submit(jid, "spectrum", p, lambda j: run(j, p, jid))
        status = jobs.get(jid)
    if status and status.get("state") == "done":
        job = jobs.get_job(jid)
        return {**status, "result": job.result if job else cache_mod.get_cache().get_json(result_key(jid))}
    return {**(status or {"job_id": jid, "state": "queued"}), "result": None}


CSV_COLS = ["date", "mjd", "detector", "wavelength_um", "bandwidth_um", "flux_mjy", "err_mjy", "snr", "status",
            "reason", "ra_expected", "dec_expected", "centroid_ra", "centroid_dec", "dra_arcsec", "ddec_arcsec",
            "obs_id", "url"]


def to_csv(result: dict) -> str:
    buf = io.StringIO()
    p = result["params"]
    buf.write(f"# COSMIC Space Blink AI photometry. Source: {result['source']} (SPHEREx, IRSA). "
              f"RA {p['ra']} Dec {p['dec']} pm_ra {p['pm_ra']} pm_dec {p['pm_dec']} mas/yr epoch {p['epoch']}. "
              f"Aperture radius {p['aperture_arcsec']} arcsec. Flux = aperture flux in mJy, no aperture correction.\n")
    wr = csv.DictWriter(buf, fieldnames=CSV_COLS, extrasaction="ignore")
    wr.writeheader()
    for r in result["rows"]:
        wr.writerow({k: ("" if r.get(k) is None else r.get(k)) for k in CSV_COLS})
    return buf.getvalue()