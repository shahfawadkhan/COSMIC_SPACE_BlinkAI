"""Observation sets: search -> select -> download + reproject (pipelined) -> stack.

POST /api/sets {ra, dec, fov_arcmin, upsample, max_frames, collections} starts a
job whose id is derived from the request (same request = same id).
GET /api/sets/{id} reports progress, then the finished set manifest.

On disk (forever): every cutout (.npz), the grid, and the set stack .npz
(frames, variance, per-epoch × per-detector inverse-variance stacks).
Manifest: Redis + disk (7 days); a set with transient download failures is
kept only 10 min so the next request fills the gaps.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np

from . import cache as cache_mod
from . import config, irsa, reproject
from .coords import coord_info
from .errors import BadRequest, NotFound, UpstreamError
from .jobs import Job, jobs

log = logging.getLogger(__name__)

SEARCH_RADIUS_DEG = 2.0 / 3600.0
CUTOUT_MARGIN = 1.2
FOV_RANGE_ARCMIN = (1.0, 20.0)
UPSAMPLE_CHOICES = (1, 2, 3, 4)
MAX_FRAMES_RANGE = (6, 200)
INCOMPLETE_TTL_S = 600
N_DET = 6


# ------------------------------------------------------------------ request handling
def normalize_request(body: dict) -> dict:
    try:
        ra = float(body["ra"])
        dec = float(body["dec"])
    except (KeyError, TypeError, ValueError) as exc:
        raise BadRequest("ra and dec (degrees) are required") from exc
    if not (math.isfinite(ra) and math.isfinite(dec)) or not -90 <= dec <= 90:
        raise BadRequest("Dec must be between -90 and +90 degrees")
    ra %= 360.0
    fov = float(body.get("fov_arcmin") or 4.0)
    if not FOV_RANGE_ARCMIN[0] <= fov <= FOV_RANGE_ARCMIN[1]:
        raise BadRequest(f"Field of view must be {FOV_RANGE_ARCMIN[0]:g}-{FOV_RANGE_ARCMIN[1]:g} arcmin")
    upsample = int(body.get("upsample") or 2)
    if upsample not in UPSAMPLE_CHOICES:
        raise BadRequest("upsample must be 1, 2, 3 or 4")
    max_frames = int(body.get("max_frames") or 40)
    if not MAX_FRAMES_RANGE[0] <= max_frames <= MAX_FRAMES_RANGE[1]:
        raise BadRequest(f"max_frames must be {MAX_FRAMES_RANGE[0]}-{MAX_FRAMES_RANGE[1]}")
    collections = body.get("collections") or list(config.settings.spherex_collections)
    if isinstance(collections, str):
        collections = [c.strip() for c in collections.split(",") if c.strip()]
    return {
        "ra": round(ra, 4) % 360.0,
        "dec": round(dec, 4),
        "fov_arcmin": round(fov, 2),
        "upsample": upsample,
        "max_frames": max_frames,
        "collections": sorted(set(collections)),
    }


def set_id_for(params: dict) -> str:
    payload = json.dumps({**params, "v": config.CODE_VERSION}, sort_keys=True)
    return "s" + hashlib.sha256(payload.encode()).hexdigest()[:15]


def is_simulated(set_id: str) -> bool:
    """Planet X Lab sets: ids start with "sim" and live under their own "sim" cache prefix,
    so a simulated set can never overwrite or be mistaken for a real one."""
    return set_id.startswith("sim")


def manifest_key(set_id: str) -> str:
    if is_simulated(set_id):
        return cache_mod.make_key(cache_mod.NS_SIM, "manifest", set_id)
    return cache_mod.make_key(cache_mod.NS_MANIFEST, set_id)


def stack_key(set_id: str) -> str:
    if is_simulated(set_id):
        return cache_mod.make_key(cache_mod.NS_SIM, "stack", set_id)
    return cache_mod.make_key(cache_mod.NS_STACK, set_id)


def load_manifest(set_id: str) -> dict | None:
    cache = cache_mod.get_cache()
    m = cache.get_json(manifest_key(set_id))
    if m is not None:
        return m
    loaded = cache.load_arrays(stack_key(set_id))  # manifest expired but the stack is on disk
    if loaded is not None and loaded[1].get("complete", True):
        manifest = loaded[1]
        cache.set_json(manifest_key(set_id), manifest, ttl=config.TTL_MANIFEST)
        return manifest
    return None


def load_stack(set_id: str) -> tuple[dict[str, np.ndarray], dict]:
    loaded = cache_mod.get_cache().load_arrays(stack_key(set_id))
    if loaded is None:
        raise NotFound(f"Set {set_id} is not built yet")
    return loaded


def start_set(body: dict) -> dict:
    params = normalize_request(body)
    set_id = set_id_for(params)
    if load_manifest(set_id) is not None:
        return {"set_id": set_id, "job_id": set_id, "state": "done"}
    job = jobs.submit(set_id, "set", params, lambda j: build_set(j, params, set_id))
    return {"set_id": set_id, "job_id": set_id, "state": job.state}


def get_set_status(set_id: str) -> dict:
    status = jobs.get(set_id)  # read status first: a job finishing in between is then seen as done
    manifest = load_manifest(set_id)
    if manifest is None and status is not None and status.get("state") == "done":
        job = jobs.get_job(set_id)
        manifest = job.result if job is not None else None
    running = status is not None and status.get("state") in ("queued", "running")
    if manifest is not None and not running:
        n = len(manifest.get("frames", []))
        return {"set_id": set_id, "job_id": set_id, "state": "done", "stage": "done",
                "progress": {"done": n, "total": n}, "eta_s": 0, "error": None, "set": manifest}
    if status is None:
        raise NotFound(f"Unknown set {set_id}. POST /api/sets to build it.")
    return {"set_id": set_id, **status, "set": None}


# ------------------------------------------------------------------ stacking
def stack_epochs(frames: np.ndarray, variance: np.ndarray, epoch_of: list[int],
                 detector_of: list[int], n_epochs: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Inverse-variance mean per (epoch, detector). Returns stack, variance, counts."""
    n = frames.shape[-1]
    stack = np.full((n_epochs, N_DET, n, n), np.nan, np.float32)
    svar = np.full_like(stack, np.nan)
    count = np.zeros((n_epochs, N_DET), np.int16)
    for e in range(n_epochs):
        for d in range(1, N_DET + 1):
            idx = [i for i in range(len(epoch_of)) if epoch_of[i] == e and detector_of[i] == d]
            if not idx:
                continue
            img = frames[idx]
            var = variance[idx]
            w = np.where(np.isfinite(img) & np.isfinite(var) & (var > 0), 1.0 / np.where(var > 0, var, 1), 0.0)
            wsum = w.sum(axis=0)
            num = np.where(w > 0, img, 0.0).astype(np.float64) * w
            with np.errstate(invalid="ignore", divide="ignore"):
                stack[e, d - 1] = np.where(wsum > 0, num.sum(axis=0) / wsum, np.nan)
                svar[e, d - 1] = np.where(wsum > 0, 1.0 / wsum, np.nan)
            count[e, d - 1] = len(idx)
    return stack, svar, count


# ------------------------------------------------------------------ the job
def _is_transient(reason: str) -> bool:
    r = reason.lower()
    return any(s in r for s in ("busy", "timed out", "connection", "http 5", "down", "skipped"))


def build_set(job: Job, p: dict, set_id: str) -> dict:
    cache = cache_mod.get_cache()
    ra, dec = p["ra"], p["dec"]
    timings: dict[str, float] = {}
    t_start = time.perf_counter()

    # 1. search + select (before any download)
    job.set_stage("searching", message="Searching NASA IRSA for SPHEREx images")
    t = time.perf_counter()
    search = irsa.search(ra, dec, SEARCH_RADIUS_DEG, collections=p["collections"])
    if search.get("stale"):
        # IRSA is down and an earlier image list was reused: centre on that saved position
        # (at most 36″ away) so the cutouts already on disk match and nothing is downloaded.
        ra, dec = search["query"]["ra"], search["query"]["dec"]
        p = {**p, "ra": ra, "dec": dec}
        job.set_stage("searching", message="NASA IRSA is not responding; using images saved earlier")
    timings["search"] = time.perf_counter() - t
    t = time.perf_counter()
    sel = irsa.select_frames(search["observations"], p["max_frames"])
    timings["select"] = time.perf_counter() - t
    frames = sel["frames"]
    if not frames:
        raise NotFound(f"No SPHEREx images cover this position in {', '.join(p['collections'])} yet.")

    # 2. common grid, computed once per set
    w, n, pix = reproject.make_grid_wcs(ra, dec, p["fov_arcmin"], p["upsample"])
    grid_key = cache_mod.make_key("grid", ra, dec, p["fov_arcmin"], p["upsample"], config.CODE_VERSION)
    if not cache.has_arrays(grid_key):
        ra_g, dec_g = reproject.grid_world(w, n)
        cache.save_arrays(grid_key, {"ra": ra_g, "dec": dec_g})
    grid_path = str(cache.array_path(grid_key))
    size_deg = p["fov_arcmin"] / 60.0 * CUTOUT_MARGIN

    # 3. download and reproject, pipelined
    total = len(frames)
    job.set_stage("downloading", total=total, message=f"Downloading {total} SPHEREx cutouts")
    # Only one frame per detector fetches the full file (to learn its WCS-WAVE table);
    # every other download stops after the ZODI extension (~97 % smaller).
    leaders: set[int] = set()
    seen_det: set[int] = set()
    for i, f in enumerate(frames):
        d = f.get("detector")
        if d and d not in seen_det:
            seen_det.add(d)
            if not irsa.has_wave_table(d, f["url"]):
                leaders.add(i)
    metas: dict[int, dict] = {}
    skipped: list[dict] = []
    rp_futures = {}
    n_cached, n_bytes, n_full, done = 0, 0, 0, 0
    t_dl = time.perf_counter()
    with ThreadPoolExecutor(max_workers=config.settings.http_workers, thread_name_prefix="dl") as pool:
        # Leaders first so the tables arrive early.
        order = sorted(range(total), key=lambda i: i not in leaders)
        futs = {pool.submit(irsa.fetch_cutout_with_retry, frames[i], ra, dec, size_deg,
                            want_full=(i in leaders)): i for i in order}
        for fut in as_completed(futs):
            i = futs[fut]
            try:
                res = fut.result()
            except Exception as exc:  # noqa: BLE001
                res = {"error": f"{type(exc).__name__}: {exc}"}
            done += 1
            if "error" in res:
                skipped.append({"index": i, "reason": res["error"]})
            else:
                metas[i] = res["meta"]
                n_full += int(bool(res["meta"].get("full_file")) and not res.get("cached"))
                n_cached += int(res.get("cached", False))
                if not res.get("cached"):
                    n_bytes += int(res["meta"].get("bytes", 0))
                rp_futures[i] = reproject.submit({"index": i, "cutout_path": res["path"],
                                                  "grid_path": grid_path})
            job.progress(done, downloaded=len(metas), failed=len(skipped), cached=n_cached,
                         reprojected=sum(f.done() for f in rp_futures.values()),
                         irsa_gate=irsa.cutout_gate.status())
    timings["download"] = time.perf_counter() - t_dl
    metas = {i: irsa.ensure_wavelength(m) for i, m in metas.items()}  # tables now known

    # 4. collect reprojections (most are already done)
    t = time.perf_counter()
    job.set_stage("reprojecting", total=len(rp_futures), message="Aligning images on a common grid")
    results: dict[int, dict] = {}
    for k, fut in enumerate(as_completed(rp_futures.values()), 1):
        try:
            r = fut.result()
            results[r["index"]] = r
        except Exception as exc:  # noqa: BLE001
            log.warning("reprojection failed: %s", exc)
        job.progress(k)
    for i in rp_futures:
        if i not in results:
            skipped.append({"index": i, "reason": "reprojection failed"})
    timings["reproject_wait"] = time.perf_counter() - t
    timings["reproject_cpu"] = sum(r["seconds"] for r in results.values())

    # 5. stack and save
    t = time.perf_counter()
    job.set_stage("rendering", total=1, message="Stacking epochs")
    kept = sorted((i for i, r in results.items() if r["keep"]), key=lambda i: (metas[i]["mjd"], frames[i]["detector"]))
    for i, r in results.items():
        if not r["keep"]:
            skipped.append({"index": i, "reason": r["reason"]})
    if not kept:
        reasons = sorted({s["reason"] for s in skipped})
        raise UpstreamError("No usable SPHEREx frames for this field. " + "; ".join(reasons[:3]))

    used_epochs = sorted({frames[i]["epoch"] for i in kept})
    remap = {old: new for new, old in enumerate(used_epochs)}
    cube = np.stack([results[i]["image"] for i in kept]).astype(np.float32)
    vcube = np.stack([results[i]["variance"] for i in kept]).astype(np.float32)
    epoch_of = [remap[frames[i]["epoch"]] for i in kept]
    det_of = [frames[i]["detector"] for i in kept]
    stack, svar, count = stack_epochs(cube, vcube, epoch_of, det_of, len(used_epochs))

    frame_list = []
    for k, i in enumerate(kept):
        f, m = frames[i], metas[i]
        frame_list.append({
            "index": k, "epoch": remap[f["epoch"]], "detector": f["detector"],
            "obs_id": f["obs_id"], "planning_period": f.get("planning_period"),
            "mjd": m["mjd"], "date_obs": m.get("date_obs"),
            "wavelength_um": m.get("wavelength_um"), "bandwidth_um": m.get("bandwidth_um"),
            "finite_fraction": results[i]["finite_fraction"],
            "flags_at_target": m.get("flags_at_target", []),
            "psf_fwhm_arcsec": m.get("psf_fwhm_arcsec"),
            "file_name": f.get("file_name"), "url": f["url"],
        })
    epochs = []
    for old in used_epochs:
        e = dict(sel["epochs"][old])
        e["index"] = remap[old]
        mine = [fr for fr in frame_list if fr["epoch"] == e["index"]]
        e["n_frames"] = len(mine)
        e["mjd_mean"] = float(np.mean([fr["mjd"] for fr in mine]))
        e["detectors_used"] = sorted({fr["detector"] for fr in mine})
        e["missing_detectors"] = [d for d in range(1, N_DET + 1) if d not in e["detectors_used"]]
        epochs.append(e)
    skipped_list = [{
        "obs_id": frames[s["index"]]["obs_id"], "detector": frames[s["index"]]["detector"],
        "mjd": frames[s["index"]]["mjd"], "reason": s["reason"]} for s in skipped]
    complete = not any(_is_transient(s["reason"]) for s in skipped_list)
    timings["stack"] = time.perf_counter() - t
    timings["total"] = time.perf_counter() - t_start

    manifest = {
        "set_id": set_id,
        "code_version": config.CODE_VERSION,
        "source": irsa.SOURCE_LABEL,
        "collections": p["collections"],
        "created": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "request": p,
        "center": coord_info(ra, dec),
        "grid": {"n": n, "pix_arcsec": pix, "fov_arcmin": p["fov_arcmin"], "upsample": p["upsample"],
                 "wcs": {k: v for k, v in w.to_header().items()}},
        "cutout_size_deg": size_deg,
        "units": "MJy/sr (IMAGE − ZODI)",
        "epochs": epochs,
        "frames": frame_list,
        "skipped": skipped_list,
        "complete": complete,
        "counts": {"search_results": search["count"], "candidates": sel["n_candidates"],
                   "passes_available": sel["n_passes_total"], "selected": total,
                   "downloaded": len(metas) - n_cached, "from_cache": n_cached,
                   "full_files": n_full,
                   "kept": len(kept), "skipped": len(skipped_list)},
        "download": {"bytes": n_bytes, "irsa_gate": irsa.cutout_gate.status()},
        "timings_s": {k: round(v, 3) for k, v in timings.items()},
    }
    cache.save_arrays(stack_key(set_id), {
        "frames": cube, "variance": vcube, "epoch_stack": stack,
        "epoch_variance": svar, "epoch_count": count}, meta=manifest)
    cache.set_json(manifest_key(set_id), manifest,
                   ttl=config.TTL_MANIFEST if complete else INCOMPLETE_TTL_S)
    log.info("set %s: %d frames kept / %d selected, %d epochs | search %.1fs download %.1fs "
             "reproject cpu %.1fs (+%.1fs wait) stack %.1fs total %.1fs",
             set_id, len(kept), total, len(epochs), timings["search"], timings["download"],
             timings["reproject_cpu"], timings["reproject_wait"], timings["stack"], timings["total"])
    job.progress(1)
    return manifest
