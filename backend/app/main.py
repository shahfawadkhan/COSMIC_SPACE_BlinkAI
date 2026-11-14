"""FastAPI entry point: uvicorn app.main:app --port 8000"""
from __future__ import annotations

import logging
import threading
import time
from contextlib import asynccontextmanager

from fastapi import Body, FastAPI, Query, Response
from fastapi.middleware.cors import CORSMiddleware

from . import cache as cache_mod
from . import catalog, config, irsa, motion, render, reproject, sets, targets, views
from .errors import BadRequest, install_handlers
from .coords import coord_info
from .jobs import jobs
from .jsonutil import SafeJSONResponse, dumps
from .net import breaker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

@asynccontextmanager
async def lifespan(_app: FastAPI):
    threading.Thread(target=reproject.warmup, name="pool-warmup", daemon=True).start()
    yield
    jobs.shutdown()
    reproject.shutdown()


app = FastAPI(
    lifespan=lifespan,
    title=config.APP_NAME,
    description=config.APP_SUBTITLE,
    version=f"0.1.0+code{config.CODE_VERSION}",
    default_response_class=SafeJSONResponse,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.settings.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Data-Source", "X-Render-Stats"],
)
install_handlers(app)

from .assistant import router as assistant_router  # noqa: E402

app.include_router(assistant_router)

# Endpoints return SafeJSONResponse explicitly: FastAPI's default encoder runs before the
# response class and cannot handle numpy scalars or NaN.

_STARTED = time.time()


@app.get("/api/health")
def health():
    c = cache_mod.get_cache()
    return SafeJSONResponse({
        "status": "ok",
        "app": config.APP_NAME,
        "code_version": config.CODE_VERSION,
        "uptime_s": round(time.time() - _STARTED, 1),
        "redis": c.redis_status(),
        "cache_dir": str(c.dir),
        "services_down": {k: v for k, v in breaker.status().items() if v["open"]},
        "irsa_cutout_gate": irsa.cutout_gate.status(),
    })


@app.get("/api/config")
def get_config():
    return SafeJSONResponse(config.public_config())


@app.get("/api/observations")
def observations(
    ra: float = Query(..., description="Right Ascension, degrees (ICRS)"),
    dec: float = Query(..., description="Declination, degrees (ICRS)"),
    radius_arcsec: float = Query(60.0, gt=0, le=3600, description="Search radius, arcsec"),
):
    return SafeJSONResponse(irsa.search(ra, dec, radius_arcsec / 3600.0))


@app.get("/api/cache/stats")
def cache_stats():
    return SafeJSONResponse(cache_mod.get_cache().stats())


@app.post("/api/cache/clear")
def cache_clear(scope: str = Query("renders", description="renders | searches | all")):
    if scope not in cache_mod.CLEAR_SCOPES:
        raise BadRequest(f"scope must be one of: {', '.join(cache_mod.CLEAR_SCOPES)}")
    return SafeJSONResponse(cache_mod.get_cache().clear(scope))


@app.get("/api/resolve")
def resolve_name(q: str | None = Query(None, description="name or coordinates"),
                 name: str | None = Query(None, description="object name (alias of q)")):
    from . import resolve
    text = name if name is not None else q
    if not text:
        raise BadRequest("Give ?name= (or ?q=)")
    return SafeJSONResponse(resolve.resolve(text))


@app.get("/api/identify")
def identify(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
             radius_arcsec: float = Query(30.0, gt=0, le=600),
             mjd: float | None = Query(None, description="date to compare at (default: now)")):
    """Name a position: nearest SIMBAD objects and the nearest Gaia source."""
    jy = catalog.jyear_from_mjd(mjd) if mjd is not None else None
    return SafeJSONResponse(catalog.identify(ra, dec, radius_arcsec, jy))


@app.get("/api/cone")
def cone(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
         radius_arcsec: float = Query(120.0, gt=0, le=3600), source: str = "simbad",
         limit: int = Query(500, ge=1, le=5000)):
    if source not in ("gaia", "simbad"):
        raise BadRequest("source must be gaia or simbad")
    return SafeJSONResponse(catalog.cone(source, ra, dec, radius_arcsec, limit))


@app.get("/api/targets")
def list_targets():
    return SafeJSONResponse({"targets": targets.all_targets()})


@app.post("/api/sets")
def create_set(body: dict = Body(..., examples=[{
        "ra": 133.758, "dec": -7.242, "fov_arcmin": 4, "upsample": 2, "max_frames": 40}])):
    return SafeJSONResponse(sets.start_set(body), status_code=202)


@app.get("/api/sets/{set_id}")
def set_status(set_id: str):
    return SafeJSONResponse(sets.get_set_status(set_id))


# ---------------------------------------------------------------- views and images
def _png(data: bytes, stats: dict | None = None, source: str = irsa.SOURCE_LABEL) -> Response:
    headers = {"Cache-Control": "public, max-age=3600", "X-Data-Source": source}
    if stats is not None:
        headers["X-Render-Stats"] = dumps(stats)
    return Response(content=data, media_type="image/png", headers=headers)


def _int_list(text: str | None, name: str) -> list[int]:
    if text in (None, ""):
        return []
    try:
        return [int(t) for t in str(text).split(",") if t.strip() != ""]
    except ValueError as exc:
        raise BadRequest(f"{name} must be a comma-separated list of indices") from exc


def _cached_png(parts: tuple, make) -> tuple[bytes, dict]:
    """Render PNGs once per parameter set; bytes in Redis for 1 day (stats alongside)."""
    c = cache_mod.get_cache()
    key = cache_mod.make_key(cache_mod.NS_RENDER, *parts, config.CODE_VERSION)
    data = c.get_bytes(key)
    stats = c.get_json(key + "s") if data is not None else None
    if data is not None and stats is not None:
        return data, stats
    data, stats = make()
    c.set_bytes(key, data, ttl=config.TTL_RENDER, disk=False)
    c.set_json(key + "s", stats, ttl=config.TTL_RENDER, disk=False)
    return data, stats


def _source(set_id: str) -> str:
    return "SIMULATED" if sets.is_simulated(set_id) else irsa.SOURCE_LABEL


def _stack_version(set_id: str) -> int:
    try:
        return cache_mod.get_cache().array_path(sets.stack_key(set_id)).stat().st_mtime_ns
    except FileNotFoundError:
        return 0


@app.get("/api/sets/{set_id}/view")
def set_view(set_id: str, band: str = "all", group_by: str = "epoch", background: str = "mesh"):
    v = views.get_view(set_id, band, group_by, background)
    return SafeJSONResponse(views.view_summary(v))


@app.get("/api/sets/{set_id}/image.png")
def set_image(set_id: str, index: int = 0, band: str = "all", group_by: str = "epoch",
              stretch: str = "asinh", cmap: str = "gray", pmin: float = Query(1.0, ge=0, le=100),
              pmax: float = Query(99.5, ge=0, le=100), upscale: int = 1, scale: str = "shared",
              vmin: float | None = None, vmax: float | None = None, background: str = "mesh"):
    render.check_params(stretch, cmap, upscale=upscale)
    if scale not in ("shared", "own"):
        raise BadRequest("scale must be 'shared' (same limits for every epoch) or 'own'")
    if pmin >= pmax:
        raise BadRequest("pmin must be below pmax")
    v = views.get_view(set_id, band, group_by, background)
    v.group(index)
    parts = ("image", set_id, _stack_version(set_id), v.band, group_by, background, index, stretch, cmap,
             pmin, pmax, upscale, scale, vmin, vmax)

    def make():
        lo, hi = v.limits(pmin, pmax) if scale == "shared" else (None, None)
        lo = vmin if vmin is not None else lo
        hi = vmax if vmax is not None else hi
        return render.render_image(v.images[index], vmin=lo, vmax=hi, pmin=pmin, pmax=pmax,
                                   stretch=stretch, cmap=cmap, upscale=upscale)

    data, stats = _cached_png(parts, make)
    return _png(data, stats, source=_source(set_id))


@app.get("/api/sets/{set_id}/combine.png")
def set_combine(set_id: str, plus: str = Query(..., description="group indices to add, e.g. 2 or 1,2"),
                minus: str | None = Query(None, description="group indices to subtract, e.g. 0"),
                band: str = "all", group_by: str = "epoch", tail: float = Query(3.0, ge=0, le=20),
                cmap: str | None = None, upscale: int = 1, stretch: str = "asinh",
                pmin: float = 1.0, pmax: float = 99.5, background: str = "mesh"):
    p_idx, m_idx = _int_list(plus, "plus"), _int_list(minus, "minus")
    is_diff = bool(m_idx)
    cmap = cmap or ("RdBu_r" if is_diff else "gray")
    render.check_params(None if is_diff else stretch, cmap, diff=is_diff, upscale=upscale)
    v = views.get_view(set_id, band, group_by, background)
    parts = ("combine", set_id, _stack_version(set_id), v.band, group_by, background, tuple(p_idx), tuple(m_idx),
             tail, cmap, upscale, stretch, pmin, pmax)

    def make():
        img, _ = views.combine(v, p_idx, m_idx)
        if is_diff:
            data, stats = render.render_difference(img, tail=tail, cmap=cmap, upscale=upscale)
        else:
            data, stats = render.render_image(img, pmin=pmin, pmax=pmax, stretch=stretch,
                                              cmap=cmap, upscale=upscale)
        stats.update({"plus": p_idx, "minus": m_idx, "band": v.band})
        return data, stats

    data, stats = _cached_png(parts, make)
    return _png(data, stats, source=_source(set_id))


@app.get("/api/sets/{set_id}/movers")
def set_movers(set_id: str, a: int = 0, b: int | None = None, band: str = "all",
               group_by: str = "epoch", threshold: float = Query(5.0, ge=2, le=50),
               max_shift_arcsec: float = Query(120.0, gt=0, le=3600),
               min_shift_pix: float = Query(1.5, ge=0), background: str = "mesh",
               names: bool = Query(True, description="cross-match pairs with SIMBAD / Gaia")):
    v = views.get_view(set_id, band, group_by, background)
    b = len(v.groups) - 1 if b is None else b
    v.group(a)
    v.group(b)
    if a == b:
        raise BadRequest("a and b must be different epochs")
    diff, _ = views.combine(v, [b], [a])
    ga, gb = v.groups[a], v.groups[b]
    result = motion.find_movers(diff, pix_arcsec=v.manifest["grid"]["pix_arcsec"],
                                wcs=views.grid_wcs(v.manifest), threshold=threshold,
                                max_shift_arcsec=max_shift_arcsec, min_shift_pix=min_shift_pix,
                                dt_days=gb["mjd"] - ga["mjd"],
                                img_a=v.images[a], img_b=v.images[b])
    for pair in result["pairs"]:
        for end in ("from", "to"):
            e = pair[end]
            if e["ra"] is not None:
                e["coords"] = coord_info(e["ra"], e["dec"])
    catalogue_errors = {}
    if result["pairs"] and names:
        field = catalog.field_sources(*catalog.field_centre(v.manifest))
        catalogue_errors = {k: f["error"] for k, f in field.items() if f.get("error")}
        catalog.name_pairs(result["pairs"], field, ga["mjd"], gb["mjd"])
    return SafeJSONResponse({
        "catalogue_errors": catalogue_errors,
        "set_id": set_id, "source": _source(set_id), "band": v.band, "group_by": group_by,
        "a": {k: ga[k] for k in ("index", "label", "mjd", "date")},
        "b": {k: gb[k] for k in ("index", "label", "mjd", "date")},
        "dt_days": gb["mjd"] - ga["mjd"],
        "note": "Candidates, not discoveries. Check against catalogues and by eye.",
        **result,
    })


@app.get("/api/sets/{set_id}/overlay")
def set_overlay(set_id: str, source: str = "simbad", band: str = "all", group_by: str = "epoch"):
    """Catalogue markers inside the set's field, with grid pixel positions at each epoch."""
    if source not in ("gaia", "simbad"):
        raise BadRequest("source must be gaia or simbad")
    v = views.get_view(set_id, band, group_by)
    return SafeJSONResponse(catalog.overlay_for_set(v.manifest, source, v.groups))


# ---------------------------------------------------------------- photometry: light curve / spectrum
@app.get("/api/spectrum")
def spectrum(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
             pm_ra: float = 0.0, pm_dec: float = 0.0, epoch: float = 2000.0,
             aperture_arcsec: float = 12.0, max_frames: int = 40, set_id: str | None = None):
    """Background job: call again with the same parameters to get progress, then the result."""
    from . import spectrum as spec
    return SafeJSONResponse(spec.start_or_get(dict(ra=ra, dec=dec, pm_ra=pm_ra, pm_dec=pm_dec, epoch=epoch,
                                                   aperture_arcsec=aperture_arcsec, max_frames=max_frames,
                                                   set_id=set_id)))


@app.get("/api/spectrum.csv")
def spectrum_csv(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
                 pm_ra: float = 0.0, pm_dec: float = 0.0, epoch: float = 2000.0,
                 aperture_arcsec: float = 12.0, max_frames: int = 40, set_id: str | None = None):
    from . import spectrum as spec
    from .errors import NotFound
    p = spec.normalize(dict(ra=ra, dec=dec, pm_ra=pm_ra, pm_dec=pm_dec, epoch=epoch,
                            aperture_arcsec=aperture_arcsec, max_frames=max_frames, set_id=set_id))
    res = cache_mod.get_cache().get_json(spec.result_key(spec.job_id_for(p)))
    if res is None:
        raise NotFound("Measurement not ready: call /api/spectrum first and wait until it is done")
    return Response(content=spec.to_csv(res), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="spherex_photometry_{ra:.4f}_{dec:+.4f}.csv"'})


# ---------------------------------------------------------------- Planet X Lab (SIMULATED only)
@app.post("/api/inject")
def inject(body: dict = Body(..., examples=[{"set_id": "s75acf0d653c1934", "distance_au": 500, "peak_snr": 10}])):
    """Injection-recovery test: add a SIMULATED Planet-X-like mover, run the detector, compare with truth."""
    from . import planetx
    return SafeJSONResponse(planetx.run(body))


@app.post("/api/inject/sweep")
def inject_sweep(body: dict = Body(...)):
    """Recovery table over peak_snr 3,5,8,12 and distance 300,500,800 AU (SIMULATED)."""
    from . import planetx
    return SafeJSONResponse(planetx.sweep(body))
