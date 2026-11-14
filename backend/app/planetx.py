"""Planet X Lab: injection-recovery test. NOTHING here is a real detection.

There is no Planet X (Planet Nine) in any archive. This module adds a clearly labelled SIMULATED
moving source to copies of real SPHEREx frames (or to fully synthetic frames), runs the normal
mover detector, and reports whether the fake was recovered.

Physics. At distance d (AU) the apparent motion is dominated by parallax from Earth's orbit;
a typical rate is 2.5 x 206265 / d / 365 arcsec/day (~2.8"/day at 500 AU). Between survey passes
six months apart that is ~500", far more than a 4' field, so the object cannot be in the field in
two passes. The meaningful test is therefore WITHIN a pass: SPHEREx revisits a spot several times
over days to weeks. Frames are grouped into visits (2-day gaps) and consecutive visits are compared.

Simulated sets get ids starting with "sim" and live under the "sim" cache prefix: a real set is
never overwritten, and every response carries simulated=True.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math

import numpy as np

from . import cache as cache_mod
from . import config, motion, reproject, sets, views
from .coords import angular_sep_deg, coord_info
from .errors import BadRequest, NotFound

FWHM_ARCSEC = 6.5
DEFAULT_DETECTORS = (4, 5, 6)  # a cold object is brighter at 3-5 um than at 1 um
LABEL = "SIMULATED test source – not a real detection"
MIN_SHIFT_PIX = 1.5
MATCH_TOL_ARCSEC = 12.4  # two native SPHEREx pixels
EDGE_PIX = 3


def auto_rate(distance_au: float) -> float:
    """Parallax-driven apparent rate, arcsec/day: 2.5 x 206265 / d / 365."""
    return 2.5 * 206265.0 / distance_au / 365.0


# ------------------------------------------------------------------ parameters
def normalize(body: dict) -> dict:
    mode = str(body.get("mode") or ("real" if body.get("set_id") else "synthetic"))
    if mode not in ("real", "synthetic"):
        raise BadRequest("mode must be 'real' or 'synthetic'")
    if mode == "real" and not body.get("set_id"):
        raise BadRequest("Build a real field first (set_id), or use mode 'synthetic'")
    if mode == "real" and str(body["set_id"]).startswith("sim"):
        raise BadRequest("Inject into a REAL set, not into a simulated one")
    d = float(body.get("distance_au") or 500.0)
    if not 300 <= d <= 1000:
        raise BadRequest("distance_au must be 300-1000")
    rate = body.get("rate_arcsec_per_day")
    rate = float(rate) if rate not in (None, "") else auto_rate(d)
    if not 0 < rate <= 60:
        raise BadRequest("rate_arcsec_per_day must be between 0 and 60")
    snr = float(body.get("peak_snr") or 10.0)
    if not 0.5 <= snr <= 50:
        raise BadRequest("peak_snr must be 3-50 (lower values are allowed only for tests)")
    dets = body.get("detectors") or list(DEFAULT_DETECTORS)
    if isinstance(dets, str):
        dets = [int(x) for x in dets.replace(" ", "").split(",") if x]
    dets = sorted({int(x) for x in dets})
    if not dets or any(not 1 <= x <= 6 for x in dets):
        raise BadRequest("detectors must be a list of 1-6")
    p = {
        "mode": mode,
        "set_id": body.get("set_id") if mode == "real" else None,
        "start_ra": None if body.get("start_ra") in (None, "") else float(body["start_ra"]) % 360.0,
        "start_dec": None if body.get("start_dec") in (None, "") else float(body["start_dec"]),
        "t0_mjd": None if body.get("t0_mjd") in (None, "") else float(body["t0_mjd"]),
        "distance_au": d,
        "rate_arcsec_per_day": round(rate, 4),
        "rate_auto": body.get("rate_arcsec_per_day") in (None, ""),
        "position_angle_deg": float(body.get("position_angle_deg") if body.get("position_angle_deg") not in (None, "") else 250.0) % 360.0,
        "peak_snr": snr,
        "detectors": dets,
        "seed": int(body.get("seed") or 1),
    }
    if p["start_dec"] is not None and not -90 <= p["start_dec"] <= 90:
        raise BadRequest("start_dec must be -90..90")
    return p


def track(p: dict, mjd: float) -> tuple[float, float]:
    """Straight track from (start_ra, start_dec) at t0 along the position angle."""
    off = p["rate_arcsec_per_day"] * (mjd - p["t0_mjd"])
    pa = math.radians(p["position_angle_deg"])
    dx, dy = off * math.sin(pa), off * math.cos(pa)  # east, north (arcsec)
    dec = p["start_dec"] + dy / 3600.0
    ra = p["start_ra"] + dx / 3600.0 / max(1e-6, math.cos(math.radians(p["start_dec"])))
    return ra % 360.0, dec


def robust_sigma(img: np.ndarray) -> float:
    v = img[np.isfinite(img)]
    if v.size < 10:
        return float("nan")
    med = np.median(v)
    s = 1.4826 * float(np.median(np.abs(v - med)))
    return s if s > 0 else float(np.std(v))


def add_gaussian(img: np.ndarray, x: float, y: float, amplitude: float, sigma_pix: float) -> None:
    """Add a 2-D Gaussian (peak = amplitude) at grid pixel (x, y), in place, NaNs kept."""
    n_y, n_x = img.shape
    r = int(math.ceil(5 * sigma_pix))
    x0, x1 = max(0, int(x) - r), min(n_x, int(x) + r + 2)
    y0, y1 = max(0, int(y) - r), min(n_y, int(y) + r + 2)
    if x0 >= x1 or y0 >= y1:
        return
    yy, xx = np.mgrid[y0:y1, x0:x1]
    g = amplitude * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma_pix**2))
    img[y0:y1, x0:x1] += g.astype(img.dtype)


# ------------------------------------------------------------------ sources of frames
def _synthetic(p: dict) -> tuple[dict, dict]:
    """Pure synthetic set (no IRSA): noise frames + static stars, 2 passes of several visits."""
    rng = np.random.default_rng(p["seed"])
    ra0 = p["start_ra"] if p["start_ra"] is not None else 150.0
    dec0 = p["start_dec"] if p["start_dec"] is not None else 2.0
    w, n, pix = reproject.make_grid_wcs(ra0, dec0, 4.0, 2)
    stars = [(rng.uniform(5, n - 5), rng.uniform(5, n - 5), rng.uniform(15, 150)) for _ in range(10)]
    sig = FWHM_ARCSEC / 2.355 / pix
    visits = [(0, 61000.0), (0, 61006.0), (0, 61013.0), (0, 61021.0), (1, 61190.0)]
    imgs, vars_, frames = [], [], []
    for e, mjd in visits:
        for d in (1, 2, 3, 4, 5, 6):
            img = rng.normal(0, 1.0, (n, n)).astype(np.float32)
            for sx, sy, a in stars:
                add_gaussian(img, sx, sy, a * (0.6 + 0.1 * d), sig)
            imgs.append(img)
            vars_.append(np.ones((n, n), np.float32))
            frames.append({"index": len(frames), "epoch": e, "detector": d, "obs_id": f"synthetic_{len(frames)}",
                           "mjd": mjd + d * 0.01, "wavelength_um": None, "flags_at_target": [], "url": ""})
    manifest = {
        "set_id": "synthetic", "source": "SIMULATED", "collections": ["synthetic"], "frames": frames,
        "request": {"ra": ra0, "dec": dec0, "fov_arcmin": 4.0}, "center": coord_info(ra0, dec0),
        "grid": {"n": n, "pix_arcsec": pix, "fov_arcmin": 4.0, "upsample": 2, "wcs": dict(w.to_header())},
        "units": "arbitrary (noise sigma = 1)", "epochs": [], "skipped": [], "complete": True,
        "counts": {"kept": len(frames), "search_results": len(frames), "selected": len(frames)}, "timings_s": {},
    }
    return {"frames": np.stack(imgs), "variance": np.stack(vars_)}, manifest


def _defaults_from_set(p: dict, manifest: dict) -> dict:
    """Start at the field centre at the beginning of the longest survey pass (most visits to test)."""
    p = dict(p)
    req = manifest.get("request") or {}
    if p["start_ra"] is None:
        p["start_ra"] = float(req.get("ra", manifest["grid"]["wcs"]["CRVAL1"]))
    if p["start_dec"] is None:
        p["start_dec"] = float(req.get("dec", manifest["grid"]["wcs"]["CRVAL2"]))
    if p["t0_mjd"] is None:
        fr = [f for f in manifest["frames"] if f["detector"] in p["detectors"]] or manifest["frames"]
        by: dict[int, list[float]] = {}
        for f in fr:
            by.setdefault(int(f.get("epoch", 0)), []).append(f["mjd"])
        longest = max(by.values(), key=lambda m: (max(m) - min(m), len(m)))
        p["t0_mjd"] = float(min(longest))
    return p


# ------------------------------------------------------------------ the test
def sim_id_for(p: dict) -> str:
    return "sim" + hashlib.sha256(json.dumps({**p, "v": config.CODE_VERSION}, sort_keys=True).encode()).hexdigest()[:13]


def inject(arrays: dict, manifest: dict, p: dict) -> tuple[np.ndarray, list[dict]]:
    """Copy the frames and add the fake object; returns (new frames, truth table)."""
    w = views.grid_wcs(manifest)
    pix = manifest["grid"]["pix_arcsec"]
    sigma_pix = FWHM_ARCSEC / 2.355 / pix
    cube = np.array(arrays["frames"], dtype=np.float32, copy=True)
    n = cube.shape[-1]
    truth = []
    for i, f in enumerate(manifest["frames"]):
        ra, dec = track(p, f["mjd"])
        x, y = (float(v) for v in w.world_to_pixel_values(ra, dec))
        inside = -1 <= x <= n and -1 <= y <= n
        injected = inside and f["detector"] in p["detectors"]
        amp = 0.0
        if injected:
            sig = robust_sigma(cube[i])
            amp = p["peak_snr"] * sig if np.isfinite(sig) else 0.0
            add_gaussian(cube[i], x, y, amp, sigma_pix)
        truth.append({"frame": i, "mjd": f["mjd"], "ra": ra, "dec": dec, "x": x, "y": y, "detector": f["detector"],
                      "inside": inside, "injected": injected, "amplitude": amp})
    return cube, truth


def evaluate(arrays_sim: dict, manifest_sim: dict, p: dict) -> dict:
    """Run the normal mover detector on consecutive visits and compare with the truth."""
    band = ",".join(str(d) for d in p["detectors"]) if len(p["detectors"]) > 1 else str(p["detectors"][0])
    view = views.build_view(arrays_sim, manifest_sim, band, "visit", background="mesh")
    w = views.grid_wcs(manifest_sim)
    n = manifest_sim["grid"]["n"]
    pix = manifest_sim["grid"]["pix_arcsec"]
    visits = []
    for g in view.groups:
        ra, dec = track(p, g["mjd"])
        x, y = (float(v) for v in w.world_to_pixel_values(ra, dec))
        inside = EDGE_PIX <= x <= n - 1 - EDGE_PIX and EDGE_PIX <= y <= n - 1 - EDGE_PIX
        visits.append({"index": g["index"], "label": g["label"], "mjd": g["mjd"], "date": g["date"], "n_frames": g["n_frames"],
                       "truth_ra": ra, "truth_dec": dec, "truth_x": x, "truth_y": y, "in_field": inside})
    pairs = []
    todo = list(zip(visits[:-1], visits[1:]))
    # Longest baseline inside each run of in-field visits: a bigger shift separates the two lobes
    # of the dipole (at 500 AU, consecutive visits 3 days apart give only ~8″ = 1.4 native pixels).
    run_: list[dict] = []
    for v in visits + [{"in_field": False}]:
        if v["in_field"]:
            run_.append(v)
            continue
        if len(run_) >= 3:
            todo.append((run_[0], run_[-1]))
        run_ = []
    for a, b in todo:
        dt_days = b["mjd"] - a["mjd"]
        expected = angular_sep_deg(a["truth_ra"], a["truth_dec"], b["truth_ra"], b["truth_dec"]) * 3600.0
        row = {"a": a["index"], "b": b["index"], "a_label": a["label"], "b_label": b["label"], "dt_days": dt_days,
               "expected_shift_arcsec": expected, "tested": False, "recovered": False,
               "long_baseline": b["index"] - a["index"] > 1}
        if not (a["in_field"] and b["in_field"]):
            row["reason"] = (f"leaves the field: it moves {expected:.0f}″ in {dt_days:.0f} days, the field is "
                             f"{manifest_sim['grid']['fov_arcmin'] * 60:.0f}″ across")
            pairs.append(row)
            continue
        if expected < MIN_SHIFT_PIX * pix:
            row["reason"] = f"too slow for these visits: {expected:.1f}″ is under {MIN_SHIFT_PIX} pixels"
            pairs.append(row)
            continue
        row["tested"] = True
        diff, _ = views.combine(view, [b["index"]], [a["index"]])
        res = motion.find_movers(diff, pix_arcsec=pix, wcs=w, threshold=5.0, max_shift_arcsec=expected * 1.3 + 30.0,
                                 dt_days=dt_days, img_a=view.images[a["index"]], img_b=view.images[b["index"]])
        best = None
        for q in res["pairs"]:
            ea = math.hypot(q["from"]["x"] - a["truth_x"], q["from"]["y"] - a["truth_y"]) * pix
            eb = math.hypot(q["to"]["x"] - b["truth_x"], q["to"]["y"] - b["truth_y"]) * pix
            if ea <= MATCH_TOL_ARCSEC and eb <= MATCH_TOL_ARCSEC and (best is None or ea + eb < best[0] + best[1]):
                best = (ea, eb, q)
        row["other_candidates"] = len(res["pairs"]) - (1 if best else 0)
        if best:
            ea, eb, q = best
            row.update({"recovered": True, "position_error_arcsec": (ea + eb) / 2, "measured_shift_arcsec": q["shift_arcsec"],
                        "snr": q["significance"], "detection": {"from": {"x": q["from"]["x"], "y": q["from"]["y"]},
                                                                "to": {"x": q["to"]["x"], "y": q["to"]["y"]}}})
        else:
            row["reason"] = "not recovered: no mover pair at the injected positions (too faint, or blended)"
        pairs.append(row)
    tested = [r for r in pairs if r["tested"]]
    rec = [r for r in tested if r["recovered"]]
    if rec:
        err = float(np.mean([r["position_error_arcsec"] for r in rec]))
        msg = f"Injected object recovered in {len(rec)} of {len(tested)} visit pair{'s' if len(tested) != 1 else ''}, mean position error {err:.1f}″"
    elif tested:
        err, msg = None, "Not recovered – too faint for these epochs"
    else:
        err = None
        slow = any("too slow" in (r.get("reason") or "") for r in pairs)
        msg = "Not recovered – " + ("too slow for these epochs" if slow else "the object leaves the field between visits, so no pair could be tested")
    return {"visits": visits, "pairs": pairs, "band": band,
            "summary": {"n_pairs": len(pairs), "n_tested": len(tested), "n_recovered": len(rec), "mean_position_error_arcsec": err, "message": msg}}


def run(body: dict, *, store: bool = True) -> dict:
    p = normalize(body)
    if p["mode"] == "real":
        loaded = sets.load_manifest(p["set_id"])
        if loaded is None:
            raise NotFound(f"Set {p['set_id']} is not built. Build it in the Blink Explorer first.")
        arrays, manifest = sets.load_stack(p["set_id"])
    else:
        arrays, manifest = _synthetic(p)
    p = _defaults_from_set(p, manifest)
    cube, truth = inject(arrays, manifest, p)
    sim_id = sim_id_for(p)
    manifest_sim = {**manifest, "set_id": sim_id, "simulated": True, "source": "SIMULATED", "label": LABEL,
                    "parent_set_id": p["set_id"], "injection": p, "truth": truth,
                    "created": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    arrays_sim = {"frames": cube, "variance": np.asarray(arrays["variance"], np.float32)}
    ev = evaluate(arrays_sim, manifest_sim, p)
    manifest_sim["injection_result"] = ev["summary"]
    if store:
        cache = cache_mod.get_cache()
        extra = {k: v for k, v in arrays.items() if k not in ("frames", "variance")}
        cache.save_arrays(sets.stack_key(sim_id), {**arrays_sim, **extra}, meta=manifest_sim)
        cache.set_json(sets.manifest_key(sim_id), manifest_sim, ttl=config.TTL_MANIFEST)
    return {"simulated": True, "label": LABEL, "source": "SIMULATED", "sim_set_id": sim_id if store else None,
            "parent_set_id": p["set_id"], "params": p, "grid": {k: manifest["grid"][k] for k in ("n", "pix_arcsec", "fov_arcmin")},
            "start": coord_info(p["start_ra"], p["start_dec"]),
            "truth": [t for t in truth if t["inside"]], **ev}


SWEEP_SNR = (3, 5, 8, 12)
SWEEP_DIST = (300, 500, 800)


def sweep(body: dict) -> dict:
    rows = []
    for d in SWEEP_DIST:
        for s in SWEEP_SNR:
            b = {**body, "distance_au": d, "peak_snr": s, "rate_arcsec_per_day": None}
            r = run(b, store=False)
            sm = r["summary"]
            rows.append({"distance_au": d, "peak_snr": s, "rate_arcsec_per_day": r["params"]["rate_arcsec_per_day"],
                         "n_tested": sm["n_tested"], "n_recovered": sm["n_recovered"],
                         "mean_position_error_arcsec": sm["mean_position_error_arcsec"], "message": sm["message"]})
    return {"simulated": True, "label": LABEL, "snr_values": list(SWEEP_SNR), "distances_au": list(SWEEP_DIST), "rows": rows}
