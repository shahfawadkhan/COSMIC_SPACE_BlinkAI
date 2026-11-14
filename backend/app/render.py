"""PNG rendering for sky images and differences.

Images: stretch (linear|sqrt|asinh|log) over a percentile interval, colour map,
nearest-neighbour upscale, north up (grid row 0 is south, so rows are flipped).
Missing pixels (NaN) are transparent.

Differences: symmetric limits ±5 robust sigma around the median. With tail
statistics (tail=k > 0) every pixel within k·sigma of the median gets ONE
neutral colour; beyond that, negative pixels turn blue and positive red, with
strength rising from 0.35 at k·sigma to 1 at the display limit, so only
significant change is visible.
"""
from __future__ import annotations

import io
from functools import lru_cache

import numpy as np
from PIL import Image

STRETCHES = ("linear", "sqrt", "asinh", "log")
IMAGE_CMAPS = ("gray", "inferno", "viridis", "magma")
DIFF_CMAPS = ("RdBu_r", "coolwarm", "gray")
MAD_TO_SIGMA = 1.4826
DIFF_LIMIT_SIGMA = 5.0
TAIL_MIN_STRENGTH = 0.35
MAX_UPSCALE = 8


# ------------------------------------------------------------------ statistics
def robust_stats(a: np.ndarray, max_samples: int = 200_000) -> tuple[float, float]:
    """(median, 1.4826 × MAD) of the finite values; (nan, nan) if none."""
    v = a[np.isfinite(a)]
    if v.size == 0:
        return float("nan"), float("nan")
    if v.size > max_samples:
        v = v[:: v.size // max_samples + 1]
    med = float(np.median(v))
    mad = float(np.median(np.abs(v - med)))
    sigma = MAD_TO_SIGMA * mad
    if sigma <= 0:  # e.g. mostly-constant images: fall back to the std
        sigma = float(np.std(v)) or 1e-12
    return med, sigma


def percentile_limits(arrays, pmin: float = 1.0, pmax: float = 99.5,
                      max_samples: int = 400_000) -> tuple[float, float]:
    """Shared display interval over one or more arrays (finite values only)."""
    if isinstance(arrays, np.ndarray):
        arrays = [arrays]
    vals = [a[np.isfinite(a)] for a in arrays]
    v = np.concatenate(vals) if vals else np.array([])
    if v.size == 0:
        return 0.0, 1.0
    if v.size > max_samples:
        v = v[:: v.size // max_samples + 1]
    lo, hi = np.percentile(v, [pmin, pmax])
    if not hi > lo:
        hi = lo + (abs(lo) * 1e-3 or 1e-6)
    return float(lo), float(hi)


# ------------------------------------------------------------------ stretches
def apply_stretch(x: np.ndarray, stretch: str) -> np.ndarray:
    """x already scaled to [0, 1]; returns [0, 1]."""
    x = np.clip(x, 0.0, 1.0)
    if stretch == "linear":
        return x
    if stretch == "sqrt":
        return np.sqrt(x)
    if stretch == "asinh":
        a = 0.1
        return np.arcsinh(x / a) / np.arcsinh(1.0 / a)
    if stretch == "log":
        a = 1000.0
        return np.log10(1.0 + a * x) / np.log10(1.0 + a)
    raise ValueError(f"stretch must be one of {STRETCHES}")


def normalize(img: np.ndarray, vmin: float, vmax: float, stretch: str = "asinh") -> np.ndarray:
    with np.errstate(invalid="ignore"):
        x = (img.astype(np.float64) - vmin) / (vmax - vmin if vmax > vmin else 1.0)
    out = apply_stretch(x, stretch)
    out[~np.isfinite(img)] = np.nan
    return out


# ------------------------------------------------------------------ tail statistics
def tail_levels(diff: np.ndarray, k: float, limit_sigma: float = DIFF_LIMIT_SIGMA,
                median: float | None = None, sigma: float | None = None) -> tuple[np.ndarray, dict]:
    """Map a difference image to colour-map positions in [0, 1] (0.5 = no change).

    k = 0: plain symmetric scaling over ±limit_sigma.
    k > 0: |d| < k·sigma -> exactly 0.5; beyond, 0.5 ± 0.5·s with s rising
           linearly from 0.35 at k·sigma to 1 at the display limit.
    """
    if median is None or sigma is None:
        median, sigma = robust_stats(diff)
    if not np.isfinite(sigma) or sigma <= 0:
        sigma = 1e-12
    if not np.isfinite(median):
        median = 0.0
    z = (diff.astype(np.float64) - median) / sigma
    lim = max(limit_sigma, k + 0.5) if k > 0 else limit_sigma
    if k <= 0:
        pos = 0.5 + 0.5 * np.clip(z / lim, -1.0, 1.0)
    else:
        az = np.abs(z)
        strength = TAIL_MIN_STRENGTH + (1.0 - TAIL_MIN_STRENGTH) * np.clip((az - k) / (lim - k), 0.0, 1.0)
        pos = np.where(az < k, 0.5, 0.5 + 0.5 * np.sign(z) * strength)
    pos[~np.isfinite(diff)] = np.nan
    finite = np.isfinite(z)
    stats = {
        "median": median, "sigma": sigma, "tail_k": k, "limit_sigma": lim,
        "vmin": median - lim * sigma, "vmax": median + lim * sigma,
        "n_positive": int(np.sum(finite & (z >= k))) if k > 0 else None,
        "n_negative": int(np.sum(finite & (z <= -k))) if k > 0 else None,
    }
    return pos, stats


# ------------------------------------------------------------------ colour + PNG
@lru_cache(maxsize=16)
def _lut(cmap: str) -> np.ndarray:
    import matplotlib
    cm = matplotlib.colormaps[cmap]
    return (cm(np.linspace(0, 1, 256))[:, :3] * 255).round().astype(np.uint8)


def colorize(levels: np.ndarray, cmap: str) -> np.ndarray:
    """levels in [0, 1] (NaN = missing) -> RGBA uint8, NaN transparent."""
    lut = _lut(cmap)
    finite = np.isfinite(levels)
    idx = np.zeros(levels.shape, np.int32)
    idx[finite] = np.clip(np.rint(levels[finite] * 255), 0, 255).astype(np.int32)
    rgba = np.empty(levels.shape + (4,), np.uint8)
    rgba[..., :3] = lut[idx]
    rgba[..., 3] = np.where(finite, 255, 0)
    return rgba


def to_png(rgba: np.ndarray, upscale: int = 1, north_up: bool = True) -> bytes:
    """Encode RGBA (grid orientation: row 0 = south) as PNG, north up."""
    upscale = int(max(1, min(MAX_UPSCALE, upscale)))
    if north_up:
        rgba = rgba[::-1]
    if upscale > 1:
        rgba = np.repeat(np.repeat(rgba, upscale, axis=0), upscale, axis=1)
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(rgba), "RGBA").save(buf, format="PNG", compress_level=6)
    return buf.getvalue()


def check_params(stretch: str | None = None, cmap: str | None = None, *,
                 diff: bool = False, upscale: int = 1) -> None:
    from .errors import BadRequest
    if stretch is not None and stretch not in STRETCHES:
        raise BadRequest(f"stretch must be one of: {', '.join(STRETCHES)}")
    allowed = DIFF_CMAPS if diff else IMAGE_CMAPS
    if cmap is not None and cmap not in allowed:
        raise BadRequest(f"cmap must be one of: {', '.join(allowed)}")
    if not 1 <= upscale <= MAX_UPSCALE:
        raise BadRequest(f"upscale must be 1-{MAX_UPSCALE}")


def render_image(img: np.ndarray, *, vmin: float | None = None, vmax: float | None = None,
                 pmin: float = 1.0, pmax: float = 99.5, stretch: str = "asinh",
                 cmap: str = "gray", upscale: int = 1) -> tuple[bytes, dict]:
    check_params(stretch, cmap, upscale=upscale)
    if vmin is None or vmax is None:
        lo, hi = percentile_limits(img, pmin, pmax)
        vmin = lo if vmin is None else vmin
        vmax = hi if vmax is None else vmax
    levels = normalize(img, vmin, vmax, stretch)
    return to_png(colorize(levels, cmap), upscale), {"vmin": vmin, "vmax": vmax, "stretch": stretch}


def render_difference(diff: np.ndarray, *, tail: float = 3.0, cmap: str = "RdBu_r",
                      upscale: int = 1, limit_sigma: float = DIFF_LIMIT_SIGMA) -> tuple[bytes, dict]:
    check_params(None, cmap, diff=True, upscale=upscale)
    levels, stats = tail_levels(diff, tail, limit_sigma)
    return to_png(colorize(levels, cmap), upscale), stats
