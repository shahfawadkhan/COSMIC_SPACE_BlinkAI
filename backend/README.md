# COSMIC Space Blink AI — backend

FastAPI service that searches NASA SPHEREx images (IRSA, collection `spherex_dr1`),
caches them in Redis + disk, and serves the blink tool on port 8000.

## Setup (Windows PowerShell)

```powershell
cd backend
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements-dev.txt
```

macOS/Linux: `python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`.

## Redis (optional, recommended)

```powershell
docker run -d --name redis -p 6379:6379 redis:7 --maxmemory 512mb --maxmemory-policy allkeys-lru
```

No Docker? Use Redis from Ubuntu inside WSL (this is how this machine runs it):

```powershell
# once: install + configure (512 MB, LRU, no snapshots) as a systemd service
wsl -d Ubuntu-22.04 -u root -- bash -c "tr -d '\r' < /mnt/d/COSMIC/backend/scripts/configure-redis-wsl.sh | bash"
# every session: start it and keep WSL awake (leave the window open)
powershell -ExecutionPolicy Bypass -File scripts\start-redis.ps1
```

WSL forwards `localhost:6379` to Windows, so the default `REDIS_URL` works. (Memurai is another option.)
Without Redis the app still works: it logs one warning and uses the disk cache only,
retrying Redis every 30 s. To turn Redis off on purpose: `$env:REDIS_URL="none"`.

## Run

```powershell
.venv\Scripts\python -m uvicorn app.main:app --port 8000 --reload
```

Open http://127.0.0.1:8000/docs for the interactive API.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/api/resolve?name=` (or `q=`) | name or coordinates → `{main_id, ra, dec, pmra, pmdec}`: typed coordinates, the 5 built-in targets, then CDS Sesame + a SIMBAD cone (main_id, proper motion; position moved to today). Sesame down → SIMBAD identifier table |
| GET | `/api/identify?ra=&dec=&radius_arcsec=30` | name a position: nearest SIMBAD objects + nearest Gaia DR3 source (moved to today), a ready-made label, `use_as_name` (SIMBAD ≤ 10″, Gaia ≤ 3″), and `moved_away` when a fast mover's track passed here |
| GET | `/api/cone?ra=&dec=&radius_arcsec=&source=gaia\|simbad` | catalogue cone (+ high-proper-motion supplement), cached 30 days |
| GET | `/api/sets/{id}/overlay?source=gaia\|simbad` | catalogue markers in the field with grid positions at every epoch |
| GET | `/api/spectrum?ra=&dec=&pm_ra=&pm_dec=&epoch=&aperture_arcsec=12&max_frames=40[&set_id=]` | background job (call again to poll): aperture photometry in every image → light curve, spectrum, centroids, proper-motion fit |
| GET | `/api/spectrum.csv?...same...` | the finished measurement as CSV |
| GET | `/api/targets` | the 5 test objects, catalogue and today's position (proper motion applied, rounded to 0.001°) |
| POST | `/api/sets` | body `{ra, dec, fov_arcmin=4, upsample=2, max_frames=40, collections}` → `{set_id, state}` (same request = same id) |
| GET | `/api/sets/{id}` | `{state, stage, progress{done,total}, eta_s, set}`; `set` is the manifest when done |
| GET | `/api/sets/{id}/view?band=all\|1-6&group_by=epoch\|frame&background=mesh\|median\|none` | epochs with date, mjd, members, detectors, wavelength range, `image_url`, shared display limits |
| GET | `/api/sets/{id}/image.png?index=&band=&stretch=linear\|sqrt\|asinh\|log&cmap=gray\|inferno\|viridis\|magma&pmin=1&pmax=99.5&upscale=1-8&scale=shared\|own` | one epoch, north up, NaN transparent |
| GET | `/api/sets/{id}/combine.png?plus=2&minus=0&tail=3&cmap=RdBu_r\|coolwarm\|gray` | B − A (±5 robust σ; `tail=k` shows only \|change\| > kσ); without `minus`: sum of epochs |
| GET | `/api/sets/{id}/movers?a=0&b=2&band=&threshold=5&max_shift_arcsec=120` | mover candidates: from/to RA-Dec, shift, PA, significance |
| GET | `/api/health` | status, `redis`: connected / disabled / down, services currently skipped |
| GET | `/api/config` | public settings: collections, detectors, FLAGS bits, code version |
| GET | `/api/observations?ra=&dec=&radius_arcsec=` | SPHEREx Level-2 images near a position (cached 30 min) |
| GET | `/api/cache/stats` | hit/miss counters per layer, disk usage per namespace |
| POST | `/api/cache/clear?scope=renders\|searches\|all` | clear part of the cache |

PNG responses carry `X-Data-Source` and `X-Render-Stats` headers and are cached in Redis for 1 day.

### Views: comparing like with like
- Epochs come from the set (30-day rule applied to all search results), not re-derived from the
  selected frames, so one survey pass is never split.
- Each frame's leftover background is removed first (6×6 mesh, sigma-clipped) so detectors and dates match.
- `band=all` uses only detectors present in every epoch, with one fixed weight per detector.

### Mover candidates
Difference peaks ≥ 5σ (robust), negative = old position, positive = new. Pairs are kept only if:
1.5 px ≤ shift ≤ max_shift; similar peak strength; the source really left (B at the old
position < 50 % of A) and was not already there (A at the new position < 50 % of B), which
rejects static stars whose brightness or PSF differs between epochs. Ends are re-measured on
the epoch images (log-parabola peak). For saturated stars (masked core) the shift comes from
matching the halo between epochs. Verified on real data: Barnard's Star 5.0–6.5″ north
over 186–227 days in D1/D3/D5 (expected 5.3–6.4″).

Example (WISE 0855 shifted to Nov 2026 with its proper motion; ≈ 258 images in `spherex_dr1`):

```
http://127.0.0.1:8000/api/observations?ra=133.758&dec=-7.242&radius_arcsec=60
```

### Assistant (`app/assistant.py`)
The in-app helper "Cosmo" answers app questions itself (scripted, from the live screen state) and
sends open questions to the SPHEREx AI service through this backend. The service key never reaches
the browser. Put it in `backend/.env` (git-ignored) and restart:

```
SPHEREX_AI_URL=https://spherex-chatbot.onrender.com
SPHEREX_AI_KEY=<the key you were given>   (copy .env.example to .env)
```

| Method | Path | What it does |
|---|---|---|
| GET | `/api/assistant/status` | configured? service ok / waking (free tier sleeps after 15 min; this call wakes it) / down |
| POST | `/api/assistant/chat/stream` | `{message, session_id?, context?}` → Server-Sent Events relayed byte for byte (start, token, sources, done, error). Errors before the stream: JSON `{code, message, retryable}` (`ai_not_configured`, `ai_key_rejected`, `ai_rate_limited`, `ai_waking`…) |
| DELETE | `/api/assistant/chat/{session_id}` | forget a conversation |

### Catalogues and names (`app/catalog.py`)
- SIMBAD TAP: CDS, then the Harvard mirror. Gaia DR3: ESA, then VizieR `I/355/gaiadr3`, then IRSA `gaia_dr3_source`.
  Each host has a 2-minute circuit breaker; a 404 (endpoint gone) also trips it.
- Catalogue positions are at J2000 (SIMBAD) / 2016.0 (Gaia). Every cone adds a wide query for stars
  faster than 0.5″/yr and every row is moved to the date being compared, so Barnard's Star (280″ from
  its J2000 position today) is still found.
- **Named movers:** each mover pair is matched to SIMBAD within 8″ (else Gaia within 6″) of either end,
  with the catalogue proper motion applied to the A and B dates. The pair gets the catalogue name, the
  expected shift ("measured 6.8″, catalogue 6.5″") and `matches_catalogue` when the measured and
  catalogue motion vectors agree within 3″. Otherwise: "Unidentified candidate" (the UI adds
  "needs further scientific investigation. Not a claim of Planet X.").

### Planet X Lab (`app/planetx.py`) – SIMULATED only

| Method | Path | What it does |
|---|---|---|
| POST | `/api/inject` | `{mode: real\|synthetic, set_id, start_ra?, start_dec?, distance_au=500 (300–1000), rate_arcsec_per_day? (auto 2.5·206265/d/365), position_angle_deg=250, peak_snr=10 (3–50), detectors=[4,5,6], seed}` → copies the set into a new `sim…` set (never overwrites the real one), adds a Gaussian (FWHM 6.5″, peak = S/N × frame noise) along the track, runs the mover detector on visit pairs (2-day gaps) and returns the truth, per-pair recovery, position error, measured vs injected shift and a summary |
| POST | `/api/inject/sweep` | same body; peak S/N 3, 5, 8, 12 × distance 300, 500, 800 AU → recovery table |

Simulated sets live under the `sim` cache prefix; their images carry `X-Data-Source: SIMULATED`.

### Photometry (`app/spectrum.py`)
Aperture photometry (sub-pixel weights) on IMAGE − ZODI with a sigma-clipped sky annulus; MJy/sr ×
pixel solid angle → mJy; error from VARIANCE + sky; wavelength from WCS-WAVE at that pixel; centroid
when S/N ≥ 5. Masked cores report "no usable measurement – star saturated" (Barnard's Star, R Dra).
Every measurement is checked against Gaia DR3 at its date: an aperture that overlaps a catalogued
star is flagged as blended and left out of the proper-motion fit. Fluxes are aperture fluxes (no
aperture correction). With `set_id` the set's cutouts on disk are reused.

## Settings (environment variables)

| Name | Default |
|---|---|
| `IRSA_SIA_URL` | `https://irsa.ipac.caltech.edu/SIA` |
| `SPHEREX_COLLECTIONS` | `spherex_dr1` (comma-separated; add new releases here) |
| `SIMBAD_TAP_URLS` | CDS, then Harvard mirror |
| `GAIA_TAP_URLS`, `VIZIER_TAP_URLS`, `IRSA_TAP_URLS` | ESA, VizieR, IRSA |
| `REDIS_URL` | `redis://localhost:6379/0` (`none` = disk only) |
| `CACHE_DIR` | `./cache` |
| `HTTP_TIMEOUT_S` | `60` |
| `HTTP_WORKERS` | `16` |
| `CPU_WORKERS` | CPU count − 1 |
| `CORS_ORIGINS` | `*` |

Bump `CODE_VERSION` in `app/config.py` whenever processing changes; it is part of the cache keys.

## How a set is built (fast path)

1. **Search** IRSA SIA2 (cached 30 min), keep images whose footprint contains the target.
2. **Select** up to `max_frames`, spread over survey passes (epochs) and all 6 detectors.
3. **Download + reproject, pipelined.** Cutouts (field × 1.2) download on `HTTP_WORKERS` threads;
   each is reprojected in a process pool (`CPU_WORKERS`, 0 = inline) as soon as it arrives.
   - Downloads stop after the ZODI extension: the 4 MB EPSF table is skipped (~110 kB per cutout).
     One frame per detector is fetched in full once, to cache its WCS-WAVE wavelength table.
   - IRSA throttles cutouts (`503 Server busy`, `Retry-After: 5`). An adaptive gate halves
     concurrency and pauses on each busy reply, then ramps back up. Real failures retry once, then skip.
4. **Stack** inverse-variance per (epoch, detector); save `.npz` + manifest with `timings_s`.

Measured (Nov 2026, 4′ field, 40 frames): cold ≈ 40 s / 4.5 MB; from cached cutouts ≈ 1 s.
The process pool starts in the background at server start (~7 s on Windows).

## Cache layout

- Redis keys `cosmic:<namespace>:<hash>` with TTLs (searches 30 min, catalogues 30 days,
  PNGs 1 day, manifests 7 days).
- Disk under `CACHE_DIR`: `json/`, `bytes/` (each with its expiry) and `arrays/` (`.npz`, kept forever).
  A disk hit is copied back into Redis.

## Tests

```powershell
.venv\Scripts\python -m pytest
```

Tests use synthetic data and fakeredis only — no network.
