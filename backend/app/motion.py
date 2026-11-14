"""Mover candidates between two epochs (B − A).

A moving source leaves a dipole in the difference: a negative peak at its old
position (in A) and a positive peak at its new position (in B).

0. (Endpoints are re-measured on the A and B images when given: see refine_on_image.)
1. Light smoothing (σ ≈ half a native SPHEREx pixel), robust sigma = 1.4826·MAD.
2. Local maxima of the difference above +threshold·σ (new positions) and of its
   negative above threshold·σ (old positions).
3. Pair each negative with the nearest unused positive between min_shift_pix
   and max_shift (arcsec), closest pairs first, one-to-one. The two ends of a
   real mover have similar amplitude, so pairs whose peak ratio is beyond
   max_flux_ratio are rejected (two unrelated variable stars, PSF residuals).

These are CANDIDATES, not discoveries: they still need checking against
catalogues and by eye.
"""
from __future__ import annotations

import math

import numpy as np
from scipy import ndimage

from .render import robust_stats


def _centroid(z: np.ndarray, y: int, x: int) -> tuple[float, float]:
    y0, y1 = max(0, y - 1), min(z.shape[0], y + 2)
    x0, x1 = max(0, x - 1), min(z.shape[1], x + 2)
    patch = np.nan_to_num(z[y0:y1, x0:x1], nan=0.0)
    patch = np.clip(patch, 0, None)
    s = patch.sum()
    if s <= 0:
        return float(x), float(y)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    return float((patch * xx).sum() / s), float((patch * yy).sum() / s)


def refine_on_image(img: np.ndarray, x: float, y: float, radius: float = 2.0) -> tuple[float, float]:
    """Source position in the epoch image itself, near a difference lobe.

    For a small shift the two lobes of a dipole sit further apart than the true
    motion; the peak in the image A (or B) near each lobe gives the real position.
    """
    ny, nx = img.shape
    x0, x1 = int(max(0, np.floor(x - radius - 3))), int(min(nx, np.ceil(x + radius + 4)))
    y0, y1 = int(max(0, np.floor(y - radius - 3))), int(min(ny, np.ceil(y + radius + 4)))
    win = img[y0:y1, x0:x1]
    if win.size == 0 or not np.isfinite(win).any():
        return x, y
    sub = win - np.nanmedian(win)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    near = (np.hypot(xx - x, yy - y) <= radius) & np.isfinite(sub)
    if not near.any():
        return x, y
    k = np.argmax(np.where(near, sub, -np.inf))
    py, px = int(yy.flat[k]), int(xx.flat[k])
    data = np.where(np.isfinite(img), img - np.nanmedian(win), np.nan)
    return _subpixel_peak(data, px, py)


def _subpixel_peak(data: np.ndarray, px: int, py: int) -> tuple[float, float]:
    """Parabola through log-intensity of the peak and its neighbours, per axis.
    Exact for a Gaussian PSF; falls back to a 3x3 centroid if values are not positive."""
    ny, nx = data.shape

    def axis(vm, v0, vp):
        if not (vm > 0 and v0 > 0 and vp > 0):
            return None
        lm, l0, lp = np.log(vm), np.log(v0), np.log(vp)
        den = lm - 2 * l0 + lp
        if den >= 0:
            return None
        return float(np.clip(0.5 * (lm - lp) / den, -1.0, 1.0))

    if 0 < px < nx - 1 and 0 < py < ny - 1:
        dx = axis(data[py, px - 1], data[py, px], data[py, px + 1])
        dy = axis(data[py - 1, px], data[py, px], data[py + 1, px])
        if dx is not None and dy is not None:
            return px + dx, py + dy
    return _centroid(np.nan_to_num(data, nan=0.0), py, px)


def _peak_flux(img: np.ndarray | None, x: float, y: float) -> float | None:
    """Background-subtracted mean of the 3x3 core at (x, y)."""
    if img is None:
        return None
    ny, nx = img.shape
    xi, yi = int(round(x)), int(round(y))
    if not (0 <= xi < nx and 0 <= yi < ny):
        return None
    win = img[max(0, yi - 6):yi + 7, max(0, xi - 6):xi + 7]
    core = img[max(0, yi - 1):yi + 2, max(0, xi - 1):xi + 2]
    if not np.isfinite(core).any() or not np.isfinite(win).any():
        return None
    return float(np.nanmean(core) - np.nanmedian(win))


def xcorr_shift(img_a: np.ndarray, img_b: np.ndarray, cx: float, cy: float,
                radius: float, max_shift: int) -> tuple[float, float, float] | None:
    """Shift (dx, dy) that best maps A onto B around (cx, cy), by least squares over
    integer shifts then a parabola for the sub-pixel part. Used for saturated stars,
    whose masked core and halo move together. Returns (dx, dy, rms) or None."""
    ny, nx = img_a.shape
    r = int(np.ceil(radius))
    m = int(max_shift)
    xi, yi = int(round(cx)), int(round(cy))
    if xi - r - m < 0 or yi - r - m < 0 or xi + r + m >= nx or yi + r + m >= ny:
        # clip the search to the image
        m = max(1, min(m, xi - r, yi - r, nx - 1 - xi - r, ny - 1 - yi - r))
        if m < 1:
            return None
    a = img_a[yi - r:yi + r + 1, xi - r:xi + r + 1]
    a = a - np.nanmedian(a)
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    inside = np.hypot(xx, yy) <= radius
    best = None
    ssd = np.full((2 * m + 1, 2 * m + 1), np.nan)
    need = 0.4 * inside.sum()
    for j, dy in enumerate(range(-m, m + 1)):
        for i, dx in enumerate(range(-m, m + 1)):
            b = img_b[yi + dy - r:yi + dy + r + 1, xi + dx - r:xi + dx + r + 1]
            b = b - np.nanmedian(b)
            ok = inside & np.isfinite(a) & np.isfinite(b)
            # holes (masked cores) must line up too: a hole in only one image is a mismatch
            hole_mismatch = inside & (np.isfinite(a) != np.isfinite(b))
            if ok.sum() < need:
                continue
            ssd[j, i] = np.mean((a[ok] - b[ok]) ** 2) * (1 + hole_mismatch.sum() / max(1, inside.sum()))
    if not np.isfinite(ssd).any():
        return None
    j, i = np.unravel_index(np.nanargmin(ssd), ssd.shape)

    def sub(vm, v0, vp):
        den = vm - 2 * v0 + vp
        return 0.0 if not (np.isfinite(den) and den > 0) else float(np.clip(0.5 * (vm - vp) / den, -0.5, 0.5))

    fx = sub(ssd[j, i - 1], ssd[j, i], ssd[j, i + 1]) if 0 < i < 2 * m else 0.0
    fy = sub(ssd[j - 1, i], ssd[j, i], ssd[j + 1, i]) if 0 < j < 2 * m else 0.0
    return i - m + fx, j - m + fy, float(np.sqrt(ssd[j, i]))


def _hole_centre(img: np.ndarray, x: float, y: float, r: float) -> tuple[float, float] | None:
    """Centroid of the masked (NaN) pixels connected to the hole nearest (x, y): a saturated core."""
    ny, nx = img.shape
    x0, x1 = int(max(0, x - r)), int(min(nx, x + r + 1))
    y0, y1 = int(max(0, y - r)), int(min(ny, y + r + 1))
    holes = ~np.isfinite(img[y0:y1, x0:x1])
    if not holes.any():
        return None
    labels, nlab = ndimage.label(holes)
    yy, xx = np.nonzero(labels)
    k = np.argmin(np.hypot(xx + x0 - x, yy + y0 - y))
    lab = labels[yy[k], xx[k]]
    # a hole touching the window edge is probably the field edge, not a star core
    sel = labels == lab
    if sel[0, :].any() or sel[-1, :].any() or sel[:, 0].any() or sel[:, -1].any():
        return None
    cy_, cx_ = ndimage.center_of_mass(sel)
    return float(cx_ + x0), float(cy_ + y0)


def _has_hole(img: np.ndarray, x: float, y: float, r: float) -> bool:
    ny, nx = img.shape
    x0, x1 = int(max(0, x - r)), int(min(nx, x + r + 1))
    y0, y1 = int(max(0, y - r)), int(min(ny, y + r + 1))
    return bool((~np.isfinite(img[y0:y1, x0:x1])).any())


def find_peaks(z: np.ndarray, threshold: float, edge: int = 1) -> list[dict]:
    """Local maxima of z above threshold (z already in sigma units)."""
    zz = np.where(np.isfinite(z), z, -np.inf)
    local_max = ndimage.maximum_filter(zz, size=3, mode="constant", cval=-np.inf) == zz
    mask = local_max & (zz >= threshold)
    if edge > 0:
        mask[:edge, :] = mask[-edge:, :] = False
        mask[:, :edge] = mask[:, -edge:] = False
    peaks = []
    for y, x in zip(*np.nonzero(mask)):
        cx, cy = _centroid(z, int(y), int(x))
        peaks.append({"x": cx, "y": cy, "px": int(x), "py": int(y), "sigma": float(z[y, x])})
    peaks.sort(key=lambda p: -p["sigma"])
    return peaks


def position_angle_deg(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    """Direction from 1 to 2, degrees east of north (0 = N, 90 = E)."""
    r1, d1, r2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    dra = r2 - r1
    pa = math.atan2(math.sin(dra) * math.cos(d2),
                    math.cos(d1) * math.sin(d2) - math.sin(d1) * math.cos(d2) * math.cos(dra))
    return math.degrees(pa) % 360.0


def find_movers(diff: np.ndarray, *, pix_arcsec: float, wcs=None, threshold: float = 5.0,
                max_shift_arcsec: float = 120.0, min_shift_pix: float = 1.5,
                smooth_pix: float | None = None, max_flux_ratio: float = 3.0,
                dt_days: float | None = None, max_peaks: int = 500,
                img_a: np.ndarray | None = None, img_b: np.ndarray | None = None,
                max_residual_frac: float = 0.5) -> dict:
    """Return {"pairs": [...], "unpaired_new": [...], "unpaired_old": [...], "stats": {...}}.

    diff = B − A on the common grid (row 0 = south). wcs (astropy) converts pixels to RA/Dec.
    """
    if smooth_pix is None:
        smooth_pix = max(0.5, 0.5 * 6.2 / pix_arcsec)   # ~half a native pixel
    finite = np.isfinite(diff)
    filled = np.where(finite, diff, 0.0)
    if smooth_pix > 0:
        num = ndimage.gaussian_filter(filled, smooth_pix)
        den = ndimage.gaussian_filter(finite.astype(float), smooth_pix)
        with np.errstate(invalid="ignore", divide="ignore"):
            sm = np.where(den > 0.5, num / den, np.nan)
    else:
        sm = np.where(finite, diff, np.nan)
    med, sigma = robust_stats(sm)
    z = (sm - med) / sigma
    pos = find_peaks(z, threshold)[:max_peaks]
    neg = find_peaks(-z, threshold)[:max_peaks]
    if img_b is not None:
        for p in pos:
            p["x"], p["y"] = refine_on_image(img_b, p["x"], p["y"])
    if img_a is not None:
        for p in neg:
            p["x"], p["y"] = refine_on_image(img_a, p["x"], p["y"])

    max_shift_pix = max_shift_arcsec / pix_arcsec
    candidates = []
    for i, a in enumerate(neg):
        for j, b in enumerate(pos):
            d = math.hypot(b["x"] - a["x"], b["y"] - a["y"])
            if min_shift_pix <= d <= max_shift_pix:
                ratio = max(a["sigma"], b["sigma"]) / max(1e-9, min(a["sigma"], b["sigma"]))
                if ratio <= max_flux_ratio:
                    candidates.append((d, i, j, ratio))
    candidates.sort()

    # Static-star test: a mover has left its old place in B and was not yet at its new
    # place in A. A static star with a brightness/PSF change is bright at both.
    rejected_static = 0
    if img_a is not None and img_b is not None:
        kept = []
        for c in candidates:
            a, b = neg[c[1]], pos[c[2]]
            fa_from, fb_from = _peak_flux(img_a, a["x"], a["y"]), _peak_flux(img_b, a["x"], a["y"])
            fa_to, fb_to = _peak_flux(img_a, b["x"], b["y"]), _peak_flux(img_b, b["x"], b["y"])
            if None in (fa_from, fb_from, fa_to, fb_to) or fa_from <= 0 or fb_to <= 0:
                rejected_static += 1
                continue
            left, already = fb_from / fa_from, fa_to / fb_to
            if left < max_residual_frac and already < max_residual_frac:
                kept.append(c + (left, already))
            else:
                rejected_static += 1
        candidates = kept
    else:
        candidates = [c + (None, None) for c in candidates]
    used_n, used_p, pairs = set(), set(), []
    saturated_done: list[tuple[float, float, float]] = []

    def world(p):
        if wcs is None:
            return None, None
        ra, dec = wcs.pixel_to_world_values(p["x"], p["y"])
        return float(ra), float(dec)

    for d, i, j, ratio, left, already in candidates:
        if i in used_n or j in used_p:
            continue
        used_n.add(i)
        used_p.add(j)
        a, b = neg[i], pos[j]
        method, saturated = "difference peaks", False
        if img_a is not None and img_b is not None:
            mx, my = 0.5 * (a["x"] + b["x"]), 0.5 * (a["y"] + b["y"])
            if _has_hole(img_a, mx, my, d / 2 + 2) or _has_hole(img_b, mx, my, d / 2 + 2):
                # Saturated star: its masked core sits between the lobes, so the lobes are
                # halo edges, not positions. Match the whole halo instead; one result per star.
                if any(math.hypot(mx - sx, my - sy) <= sr for sx, sy, sr in saturated_done):
                    continue
                saturated_done.append((mx, my, d / 2 + 6))
                res = xcorr_shift(img_a, img_b, mx, my, radius=d / 2 + 4, max_shift=int(math.ceil(d)) + 2)
                if res is None:
                    continue
                dx, dy, _ = res
                # Where the star is: the centre of its masked core in A (fallback: lobe midpoint).
                core = _hole_centre(img_a, mx, my, max(d / 2 + 4, 20.0))
                fx, fy = core if core is not None else (mx - dx / 2, my - dy / 2)
                a = {**a, "x": fx, "y": fy}
                b = {**b, "x": fx + dx, "y": fy + dy}
                d = math.hypot(dx, dy)
                method, saturated = "halo cross-correlation (saturated core)", True
                if not min_shift_pix <= d <= max_shift_pix:
                    continue
        ra1, dec1 = world(a)
        ra2, dec2 = world(b)
        shift = d * pix_arcsec
        if ra1 is not None:
            pa = position_angle_deg(ra1, dec1, ra2, dec2)
        else:  # grid is north-up, east-left: +y = N, −x = E
            pa = math.degrees(math.atan2(-(b["x"] - a["x"]), b["y"] - a["y"])) % 360.0
        pair = {
            "from": {"x": a["x"], "y": a["y"], "ra": ra1, "dec": dec1, "sigma": a["sigma"]},
            "to": {"x": b["x"], "y": b["y"], "ra": ra2, "dec": dec2, "sigma": b["sigma"]},
            "shift_arcsec": shift,
            "shift_pix": d,
            "pa_deg": pa,
            "significance": min(a["sigma"], b["sigma"]),
            "peak_ratio": ratio,
            "left_at_old_position": left,        # B/A flux at the old position (mover: ~0)
            "already_at_new_position": already,  # A/B flux at the new position (mover: ~0)
            "method": method,
            "saturated": saturated,
            "label": "Unidentified candidate – needs further scientific investigation",
        }
        if dt_days:
            pair["rate_arcsec_per_yr"] = shift / (abs(dt_days) / 365.25)
            pair["rate_arcsec_per_day"] = shift / abs(dt_days)
        pairs.append(pair)
    pairs.sort(key=lambda p: -p["significance"])

    def plain(lst, used):
        out = []
        for k, p in enumerate(lst):
            if k not in used:
                ra, dec = world(p)
                out.append({"x": p["x"], "y": p["y"], "ra": ra, "dec": dec, "sigma": p["sigma"]})
        return out

    return {
        "pairs": pairs,
        "unpaired_new": plain(pos, used_p),   # brightened / appeared (variable star, transient)
        "unpaired_old": plain(neg, used_n),   # faded / disappeared
        "stats": {"median": med, "sigma": sigma, "threshold": threshold, "smooth_pix": smooth_pix,
                  "n_positive_peaks": len(pos), "n_negative_peaks": len(neg),
                  "rejected_as_static": rejected_static,
                  "max_shift_arcsec": max_shift_arcsec, "min_shift_pix": min_shift_pix},
    }
