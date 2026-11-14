"""Views of a set: frames grouped into epochs (or single frames), per band.

band = 1..6: inverse-variance mean of that detector's frames in each group.
band = "all": like-with-like across groups. First an inverse-variance stack per
(group, detector); then the detectors present in EVERY group are averaged with
one fixed weight per detector (the same for all groups). A group with an
extra detector or more frames of one detector therefore does not change the
colour mix, which would otherwise fake brightness changes.
"""


from __future__ import annotations

import threading
from collections import OrderedDict
from dataclasses import dataclass, field

import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS

from . import cache as cache_mod
from . import config, render, sets
from .errors import BadRequest, NotFound

EPOCH_GAP_DAYS = 30.0
N_DET = 6
GROUP_BYS = ("epoch", "frame", "visit")
VISIT_GAP_DAYS = 2.0  # "visit": frames within 2 days (used by the Planet X Lab: motion inside a pass)


@dataclass
class View:
    set_id: str
    band: str                         # "all" or "1".."6"
    group_by: str
    groups: list[dict]
    images: list[np.ndarray]
    variances: list[np.ndarray]
    detectors_used: list[int]
    detectors_excluded: list[int] = field(default_factory=list)
    manifest: dict = field(default_factory=dict)
    background: str = "mesh"
    _limits: dict = field(default_factory=dict)

    def limits(self, pmin: float = 1.0, pmax: float = 99.5) -> tuple[float, float]:
        """Display interval shared by every group, so blinking compares like with like."""
        key = (pmin, pmax)
        if key not in self._limits:
            self._limits[key] = render.percentile_limits(
                [im for im, g in zip(self.images, self.groups) if g["has_data"]], pmin, pmax)
        return self._limits[key]

    def group(self, index: int) -> int:
        if not 0 <= index < len(self.groups):
            raise NotFound(f"No {self.group_by} {index} in this view (0-{len(self.groups) - 1})")
        return index


def parse_band(band: str | int | None) -> str:
    """'all', one detector '1'..'6', or a list such as '4,5,6' (combined like 'all')."""
    b = str(band if band not in (None, "") else "all").lower().replace(" ", "")
    if b == "all" or (b.isdigit() and 1 <= int(b) <= N_DET):
        return b
    parts = [x for x in b.split(",") if x]
    if len(parts) > 1 and all(x.isdigit() and 1 <= int(x) <= N_DET for x in parts):
        return ",".join(str(d) for d in sorted({int(x) for x in parts}))
    raise BadRequest("band must be 'all', 1-6, or a list like 4,5,6")


def group_frames(frames: list[dict], gap_days: float = EPOCH_GAP_DAYS) -> list[list[int]]:
    """Indices of date-sorted frames split where the gap exceeds gap_days."""
    order = sorted(range(len(frames)), key=lambda i: frames[i]["mjd"])
    groups: list[list[int]] = []
    for i in order:
        if groups and frames[i]["mjd"] - frames[groups[-1][-1]]["mjd"] <= gap_days:
            groups[-1].append(i)
        else:
            groups.append([i])
    return groups


def ivar_mean(images: np.ndarray, variances: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Inverse-variance mean along axis 0 (NaN where no valid input)."""
    ok = np.isfinite(images) & np.isfinite(variances) & (variances > 0)
    w = np.where(ok, 1.0 / np.where(ok, variances, 1.0), 0.0)
    wsum = w.sum(axis=0)
    num = (np.where(ok, images, 0.0) * w).sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(wsum > 0, num / wsum, np.nan)
        var = np.where(wsum > 0, 1.0 / wsum, np.nan)
    return mean.astype(np.float32), var.astype(np.float32)


BACKGROUNDS = ("mesh", "median", "none")
MESH_CELLS = 6
MIN_WEIGHT_FRACTION = 0.6  # all-band: share of detector weight a pixel needs to be shown


def background_mesh(img: np.ndarray, cells: int = MESH_CELLS) -> np.ndarray:
    """Smooth background: sigma-clipped median in a cells×cells mesh, bilinear in between."""
    return background_mesh_cube(img[None], cells)[0]


def _mesh_cells(cube: np.ndarray, cells: int) -> tuple[np.ndarray, int, int, int, int]:
    """Sigma-clipped median per mesh cell, for every frame at once: (N, cy, cx)."""
    import warnings
    n, n_y, n_x = cube.shape
    cy, cx = max(1, min(cells, n_y // 8)), max(1, min(cells, n_x // 8))
    h, w = -(-n_y // cy), -(-n_x // cx)
    pad = np.full((n, cy * h, cx * w), np.nan, np.float32)
    pad[:, :n_y, :n_x] = cube
    v = pad.reshape(n, cy, h, cx, w).transpose(0, 1, 3, 2, 4).reshape(n, cy, cx, h * w)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN cells
        for _ in range(3):  # clip stars (upper tail only)
            med = np.nanmedian(v, axis=-1, keepdims=True)
            sig = 1.4826 * np.nanmedian(np.abs(v - med), axis=-1, keepdims=True)
            sig = np.where(sig > 0, sig, np.inf)
            v = np.where(v < med + 3 * sig, v, np.nan)
        mesh = np.nanmedian(v, axis=-1)
    mesh[np.isfinite(v).sum(axis=-1) < 10] = np.nan
    return mesh, cy, cx, h, w


def background_mesh_cube(cube: np.ndarray, cells: int = MESH_CELLS) -> np.ndarray:
    from scipy.ndimage import map_coordinates
    n, n_y, n_x = cube.shape
    meshes, cy, cx, h, w = _mesh_cells(cube, cells)
    fy = (np.arange(n_y) + 0.5) / h - 0.5 + 1.0   # fractional cell index (+1 for the padding)
    fx = (np.arange(n_x) + 0.5) / w - 0.5 + 1.0
    yy, xx = np.meshgrid(fy, fx, indexing="ij")
    out = np.zeros_like(cube)
    for k in range(n):
        out[k] = _interp_mesh(meshes[k], cy, cx, yy, xx, map_coordinates)
    return out


def _interp_mesh(mesh, cy, cx, yy, xx, map_coordinates):
    if not np.isfinite(mesh).any():
        return np.zeros(yy.shape)
    mesh = np.where(np.isfinite(mesh), mesh, np.nanmedian(mesh))
    if mesh.size == 1:
        return np.full(yy.shape, mesh[0, 0])
    # Values sit at cell centres; interpolate linearly between them and extrapolate
    # linearly to the edges (holding the edge flat would leave half a cell of gradient).
    # Linear extrapolation = pad the mesh with one mirrored-slope cell on each side.
    pad = np.pad(mesh, 1, mode="edge").astype(np.float64)
    if cy > 1:
        pad[0, :] = 2 * pad[1, :] - pad[2, :]
        pad[-1, :] = 2 * pad[-2, :] - pad[-3, :]
    if cx > 1:
        pad[:, 0] = 2 * pad[:, 1] - pad[:, 2]
        pad[:, -1] = 2 * pad[:, -2] - pad[:, -3]
    return map_coordinates(pad, [yy, xx], order=1, mode="nearest", prefilter=False)


def subtract_background(cube: np.ndarray, mode: str) -> np.ndarray:
    """Remove each frame's leftover background (after ZODI) so detectors and dates match."""
    if mode == "none":
        return cube
    if mode == "median":
        med = np.nanmedian(cube.reshape(cube.shape[0], -1), axis=1)
        return cube - np.nan_to_num(med)[:, None, None].astype(cube.dtype)
    return (cube - background_mesh_cube(cube)).astype(cube.dtype)


def epoch_groups(frames: list[dict], gap_days: float = EPOCH_GAP_DAYS) -> list[list[int]]:
    """Epochs as decided when the set was built (30-day rule applied to ALL search results).

    Re-applying the gap rule to only the selected frames would split one survey pass
    wherever the selection left a gap, so the stored epoch is used when present.
    """
    if frames and all("epoch" in f for f in frames):
        by: dict[int, list[int]] = {}
        for i in sorted(range(len(frames)), key=lambda i: frames[i]["mjd"]):
            by.setdefault(int(frames[i]["epoch"]), []).append(i)
        return [by[e] for e in sorted(by)]
    return group_frames(frames, gap_days)


def _label(mjds: list[float]) -> str:
    a, b = Time([min(mjds), max(mjds)], format="mjd").to_datetime()
    if (a.year, a.month, a.day) == (b.year, b.month, b.day):
        return a.strftime("%d %b %Y")
    if (a.year, a.month) == (b.year, b.month):
        return a.strftime("%b %Y")
    if a.year == b.year:
        return f"{a.strftime('%b')}–{b.strftime('%b %Y')}"
    return f"{a.strftime('%b %Y')}–{b.strftime('%b %Y')}"


def build_view(arrays: dict, manifest: dict, band: str, group_by: str,
               gap_days: float = EPOCH_GAP_DAYS, background: str = "mesh",
               cube: np.ndarray | None = None) -> View:
    """cube: frames with background already removed (computed here if not given)."""
    if group_by not in GROUP_BYS:
        raise BadRequest("group_by must be 'epoch' or 'frame'")
    if background not in BACKGROUNDS:
        raise BadRequest(f"background must be one of: {', '.join(BACKGROUNDS)}")
    frames = manifest["frames"]
    if cube is None:
        cube = subtract_background(arrays["frames"], background)
    vcube = arrays["variance"]
    n = cube.shape[-1]
    if group_by == "frame":
        groups_idx = [[i] for i in sorted(range(len(frames)), key=lambda i: frames[i]["mjd"])]
    elif group_by == "visit":
        groups_idx = group_frames(frames, VISIT_GAP_DAYS)
    else:
        groups_idx = epoch_groups(frames, gap_days)
    allowed = {int(x) for x in band.split(",")} if "," in band else None
    if allowed:
        groups_idx = [[i for i in g if frames[i]["detector"] in allowed] for g in groups_idx]
        groups_idx = [g for g in groups_idx if g]
    if band.isdigit():
        d = int(band)
        groups_idx = [[i for i in g if frames[i]["detector"] == d] for g in groups_idx]
        groups_idx = [g for g in groups_idx if g] if group_by == "frame" else groups_idx

    images, variances, detectors_used, excluded = [], [], [], []
    if band.isdigit():
        detectors_used = [int(band)]
        for g in groups_idx:
            if g:
                im, v = ivar_mean(cube[g], vcube[g])
            else:
                im = v = np.full((n, n), np.nan, np.float32)
            images.append(im)
            variances.append(v)
    elif group_by == "frame":
        detectors_used = sorted({f["detector"] for f in frames})
        for g in groups_idx:
            images.append(cube[g[0]])
            variances.append(vcube[g[0]])
    else:
        per: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = {}
        for gi, g in enumerate(groups_idx):
            for d in range(1, N_DET + 1):
                if allowed and d not in allowed:
                    continue
                idx = [i for i in g if frames[i]["detector"] == d]
                if idx:
                    per[(gi, d)] = ivar_mean(cube[idx], vcube[idx])
        present = [d for d in range(1, N_DET + 1) if any((gi, d) in per for gi in range(len(groups_idx)))]
        detectors_used = [d for d in present if all((gi, d) in per for gi in range(len(groups_idx)))]
        excluded = [d for d in present if d not in detectors_used]
        if not detectors_used and present:  # no detector in every epoch: best effort, reported
            counts = {d: sum((gi, d) in per for gi in range(len(groups_idx))) for d in present}
            detectors_used = [d for d in present if counts[d] == max(counts.values())]
            excluded = [d for d in present if d not in detectors_used]
        # One fixed weight per detector: inverse of its median variance over all groups.
        weights = {}
        for d in detectors_used:
            med_var = np.nanmedian([np.nanmedian(per[(gi, d)][1]) for gi in range(len(groups_idx)) if (gi, d) in per])
            weights[d] = 1.0 / med_var if np.isfinite(med_var) and med_var > 0 else 0.0
        for gi in range(len(groups_idx)):
            num = np.zeros((n, n))
            vnum = np.zeros((n, n))
            wcov = np.zeros((n, n))
            wsum = 0.0
            for d in detectors_used:
                if (gi, d) not in per:
                    continue
                im, v = per[(gi, d)]
                w = weights[d]
                ok_d = np.isfinite(im)
                num += np.where(ok_d, im, 0.0) * w
                vnum += np.where(ok_d & np.isfinite(v), v, 0.0) * w * w
                wcov += np.where(ok_d, w, 0.0)
                wsum += w
            # Near like-with-like: a pixel is shown only where detectors carrying at least
            # MIN_WEIGHT_FRACTION of the weight have data, so the detector mix cannot change much.
            ok = (wsum > 0) & (wcov >= MIN_WEIGHT_FRACTION * wsum)
            with np.errstate(invalid="ignore", divide="ignore"):
                images.append(np.where(ok, num / wcov, np.nan).astype(np.float32))
                variances.append(np.where(ok, vnum / wcov ** 2, np.nan).astype(np.float32))

    groups = []
    for gi, g in enumerate(groups_idx):
        if group_by != "frame" and not band.isdigit():  # combined detectors: members actually used
            members = [i for i in g if frames[i]["detector"] in detectors_used]
        else:
            members = list(g)
        mjds = [frames[i]["mjd"] for i in members] or [frames[i]["mjd"] for i in g] or [float("nan")]
        waves = [frames[i]["wavelength_um"] for i in members if frames[i].get("wavelength_um") is not None]
        im = images[gi]
        groups.append({
            "index": gi,
            "label": _label(mjds) if np.all(np.isfinite(mjds)) else "",
            "mjd": float(np.mean(mjds)),
            "mjd_start": float(min(mjds)),
            "mjd_end": float(max(mjds)),
            "date": Time(float(np.mean(mjds)), format="mjd").isot[:19] if np.all(np.isfinite(mjds)) else None,
            "members": members,
            "n_frames": len(members),
            "detectors": sorted({frames[i]["detector"] for i in members}),
            "wavelength_um": [min(waves), max(waves)] if waves else None,
            "coverage": float(np.isfinite(im).mean()),
            "has_data": bool(len(members) > 0 and np.isfinite(im).any()),
            "flags_at_target": sorted({fl for i in members for fl in frames[i].get("flags_at_target", [])}),
        })
    return View(manifest["set_id"], band, group_by, groups, images, variances,
                detectors_used, excluded, manifest)


# ------------------------------------------------------------------ cache of views in memory
_views: OrderedDict = OrderedDict()
_cubes: OrderedDict = OrderedDict()  # background-subtracted frames per set
_lock = threading.Lock()
_MAX_VIEWS = 24
_MAX_CUBES = 6


def get_view(set_id: str, band="all", group_by: str = "epoch", background: str = "mesh") -> View:
    band = parse_band(band)
    if background not in BACKGROUNDS:
        raise BadRequest(f"background must be one of: {', '.join(BACKGROUNDS)}")
    cache = cache_mod.get_cache()
    path = cache.array_path(sets.stack_key(set_id))
    try:
        mtime = path.stat().st_mtime_ns
    except FileNotFoundError as exc:
        raise NotFound(f"Set {set_id} is not built yet. POST /api/sets first.") from exc
    key = (set_id, band, group_by, background, mtime, config.CODE_VERSION)
    with _lock:
        if key in _views:
            _views.move_to_end(key)
            return _views[key]
    # Background removal is the slow part and the same for every band: do it once per set.
    ckey = (set_id, background, mtime, config.CODE_VERSION)
    with _lock:
        cached = _cubes.get(ckey)
        if cached is not None:
            _cubes.move_to_end(ckey)
    if cached is None:
        arrays, manifest = sets.load_stack(set_id)
        cached = (arrays, manifest, subtract_background(arrays["frames"], background))
        with _lock:
            _cubes[ckey] = cached
            while len(_cubes) > _MAX_CUBES:
                _cubes.popitem(last=False)
    arrays, manifest, cube = cached
    view = build_view(arrays, manifest, band, group_by, background=background, cube=cube)
    view.background = background
    with _lock:
        _views[key] = view
        while len(_views) > _MAX_VIEWS:
            _views.popitem(last=False)
    return view


def grid_wcs(manifest: dict) -> WCS:
    hdr = fits.Header()
    for k, v in manifest["grid"]["wcs"].items():
        hdr[k] = v
    return WCS(hdr)


def combine(view: View, plus: list[int], minus: list[int]) -> tuple[np.ndarray, np.ndarray]:
    """ivar-mean of `plus` groups minus ivar-mean of `minus` groups (minus may be empty)."""
    if not plus:
        raise BadRequest("Give at least one group in 'plus'")
    for i in plus + minus:
        view.group(i)
    p_img, p_var = ivar_mean(np.stack([view.images[i] for i in plus]),
                             np.stack([view.variances[i] for i in plus]))
    if not minus:
        return p_img, p_var
    m_img, m_var = ivar_mean(np.stack([view.images[i] for i in minus]),
                             np.stack([view.variances[i] for i in minus]))
    return p_img - m_img, p_var + m_var


def view_summary(view: View, base_url: str = "") -> dict:
    lo, hi = view.limits()
    groups = []
    for g in view.groups:
        url = (f"{base_url}/api/sets/{view.set_id}/image.png?band={view.band}"
               f"&group_by={view.group_by}&background={view.background}"
               f"&index={g['index']}") if g["has_data"] else None
        groups.append({**g, "image_url": url})
    m = view.manifest
    return {
        "set_id": view.set_id,
        "source": m.get("source", "NASA IRSA DATA"),
        "band": view.band,
        "group_by": view.group_by,
        "detectors_used": view.detectors_used,
        "detectors_excluded": view.detectors_excluded,
        "background": view.background,
        "note": ("All-band view: only detectors present in every epoch, fixed weights; "
                 "a pixel is shown where detectors with ≥60% of the weight have data."
                 if view.band == "all" and view.group_by == "epoch" else None),
        "center": m.get("center"),
        "grid": {k: m["grid"][k] for k in ("n", "pix_arcsec", "fov_arcmin", "upsample")},
        "units": m.get("units"),
        "display": {"vmin": lo, "vmax": hi, "pmin": 1.0, "pmax": 99.5},
        "epochs": groups,  # with group_by=frame each entry is a single frame
        "count": len(groups),
    }