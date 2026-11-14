"""Reproject cutouts onto a common TAN grid centred on the target.

The grid's RA/Dec arrays are computed once per set and saved to disk; each
worker process loads them once (LRU) and, per frame, does one vectorised
WCS world->pixel call followed by scipy map_coordinates (bilinear, NaN outside).
CPU work runs in a ProcessPoolExecutor (CPU_WORKERS; 0 = run inline).
"""
from __future__ import annotations

import json
import logging
import math
import threading
import time
import warnings
from concurrent.futures import Future, ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from functools import lru_cache

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from scipy.ndimage import map_coordinates

from . import config

log = logging.getLogger(__name__)

MIN_FINITE_FRACTION = 0.5


# ------------------------------------------------------------------ grid
def make_grid_wcs(ra: float, dec: float, fov_arcmin: float, upsample: int) -> tuple[WCS, int, float]:
    """North-up, east-left TAN grid; odd size so the target sits on the centre pixel."""
    pix_arcsec = config.PIXEL_SCALE_ARCSEC / upsample
    n = int(math.ceil(fov_arcmin * 60.0 / pix_arcsec))
    if n % 2 == 0:
        n += 1
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2.0, (n + 1) / 2.0]
    w.wcs.cdelt = [-pix_arcsec / 3600.0, pix_arcsec / 3600.0]
    w.wcs.cunit = ["deg", "deg"]
    w.wcs.radesys = "ICRS"
    w.array_shape = (n, n)
    return w, n, pix_arcsec


def grid_world(w: WCS, n: int) -> tuple[np.ndarray, np.ndarray]:
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    ra, dec = w.pixel_to_world_values(xx, yy)
    return np.asarray(ra, np.float64), np.asarray(dec, np.float64)


# ------------------------------------------------------------------ worker (runs in child processes)
@lru_cache(maxsize=8)
def _load_grid(path: str) -> tuple[np.ndarray, np.ndarray]:
    with np.load(path, allow_pickle=False) as z:
        return z["ra"], z["dec"]


def reproject_arrays(image: np.ndarray, variance: np.ndarray | None, header: fits.Header | str,
                     ra_grid: np.ndarray, dec_grid: np.ndarray) -> tuple[np.ndarray, np.ndarray | None]:
    if isinstance(header, str):
        header = fits.Header.fromstring(header)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        w = WCS(header)
        x, y = w.world_to_pixel_values(ra_grid, dec_grid)
    coords = np.array([np.asarray(y, np.float32), np.asarray(x, np.float32)])
    out = map_coordinates(image.astype(np.float32, copy=False), coords, order=1,
                          cval=np.nan, prefilter=False, output=np.float32)
    out_v = None
    if variance is not None:
        out_v = map_coordinates(variance.astype(np.float32, copy=False), coords, order=1,
                                cval=np.nan, prefilter=False, output=np.float32)
    return out, out_v


def reproject_frame(task: dict) -> dict:
    """task: {index, cutout_path, grid_path, min_finite}. Returns arrays + keep decision."""
    t0 = time.perf_counter()
    ra_g, dec_g = _load_grid(task["grid_path"])
    with np.load(task["cutout_path"], allow_pickle=False) as z:
        image = z["image"]
        variance = z["variance"]
        meta = json.loads(str(z["__meta__"]))
    img, var = reproject_arrays(image, variance, meta["header"], ra_g, dec_g)
    finite = float(np.isfinite(img).mean())
    reason = None
    if not meta.get("target_inside", True):
        reason = "target outside cutout"
    elif finite < task.get("min_finite", MIN_FINITE_FRACTION):
        reason = f"only {finite:.0%} of the field covered"
    return {
        "index": task["index"],
        "image": img,
        "variance": var,
        "finite_fraction": finite,
        "keep": reason is None,
        "reason": reason,
        "seconds": time.perf_counter() - t0,
    }


# ------------------------------------------------------------------ pool
_pool: ProcessPoolExecutor | None = None
_pool_lock = threading.Lock()


def _get_pool() -> ProcessPoolExecutor | None:
    global _pool
    if config.settings.cpu_workers <= 0:
        return None
    with _pool_lock:
        if _pool is None:
            _pool = ProcessPoolExecutor(max_workers=min(config.settings.cpu_workers, 61))
        return _pool


def submit(task: dict) -> Future:
    """Queue a frame for reprojection; falls back to inline if the pool is broken."""
    pool = _get_pool()
    if pool is not None:
        try:
            return pool.submit(reproject_frame, task)
        except (BrokenProcessPool, RuntimeError) as exc:
            log.warning("Process pool unavailable (%s); reprojecting inline", exc)
            shutdown()
    fut: Future = Future()
    try:
        fut.set_result(reproject_frame(task))
    except Exception as exc:  # noqa: BLE001
        fut.set_exception(exc)
    return fut


def _noop(i: int) -> int:
    return i


def warmup() -> None:
    """Start worker processes now (Windows spawn + astropy/scipy import takes seconds),
    so the first set does not pay for it."""
    pool = _get_pool()
    if pool is None:
        return
    t0 = time.perf_counter()
    try:
        list(pool.map(_noop, range(config.settings.cpu_workers)))
        log.info("Reprojection pool ready: %d processes in %.1fs",
                 config.settings.cpu_workers, time.perf_counter() - t0)
    except Exception as exc:  # noqa: BLE001
        log.warning("Process pool warm-up failed (%s); will retry on first use", exc)
        shutdown()


def shutdown() -> None:
    global _pool
    with _pool_lock:
        if _pool is not None:
            _pool.shutdown(wait=False, cancel_futures=True)
            _pool = None
