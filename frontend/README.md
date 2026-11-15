# COSMIC Space Blink AI — frontend

React 19 + Vite + TypeScript + Tailwind v4, Aladin Lite v3, Plotly. Port 3000; `/api` is proxied to
the backend on `http://127.0.0.1:8000` (start the backend first, see `../backend/README.md`).

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # typecheck + production build in dist/
```

Design: Public Sans + Source Code Pro, four themes (Light NASA/IRSA style
by default, Dark, Slate, Night = red only, images included). Every image carries a data-source chip:
NASA IRSA DATA, DERIVED, CATALOGUE, or a red SIMULATED.

## Pages

| Page | What it does |
|---|---|
| Mission Control `/` | Search by **Object name** or **Coordinates** (two boxes, live validation, parsed value in the other format, paste "RA Dec" into the RA box to split it, reverse lookup before building). Live Aladin sky map (Optical / Infrared / Near-IR, map-centre RA/Dec, click to pick), "Watch WISE 0855 move", the 5 test targets, How it works. |
| Blink Explorer `/explorer` | The stage between a floating command panel and inspector. Modes Single / Blink / Side by side / Swipe / Difference; stretch, colour swatches, ±kσ tail threshold, Levels, Overlays (named mover rings, Gaia DR3, SIMBAD, grid, catalogue proper-motion prediction, field boundary, target marker), Sky map, Measure tool, zoom, fullscreen. SVG timeline of survey passes (click = B, shift-click = A) and detector selector. |
| Image Exploration `/compare` | A and B dropdowns, Swap, A / B / blink (1–4 Hz) / B − A panels with rings, metadata table with time baseline, named movers with "Add to log". |
| AstroAnalytics `/analysis` | Astrometry / Light curve / Spectrum tabs from `/api/spectrum` (reuses the built field's images); blend and saturation warnings; CSV download. |
| Discovery Log `/candidates` | Candidates in this browser: label, RA + Dec, status you set (unvalidated / catalogued / rejected), notes, positions (from movers, the Measure tool, or typed), derived proper motion from ≥ 2 positions, SIMBAD + Gaia cross-match, CSV export. No invented confidence scores. |
| Planet X Lab `/planetx` | Injection-recovery test with a SIMULATED distant planet: form (real field or pure synthetic, distance, rate, direction, S/N, detectors, seed), result card, A / B / B − A images with the true track and recovery circles (red SIMULATED chip on each), sensitivity sweep table. |
| SPHEREx Mission `/mission` | Mission facts, the 6 detectors as a wavelength bar, how the tool works, how data is labelled. |
| Settings `/settings` | API base URL (with Test), theme, coordinate format shown first, render resolution, new-set defaults, clear cache (renders / searches / everything). |

Keys in the explorer: `Space` play · `←/→` step · `1–5` modes · `A` set reference · `+/-` zoom · `0` fit.

### Loading rule
A new target or coordinates removes the old set from the stage at once; the stage shows the sky map
of the NEW target and a loading card (name or "Resolving name…", RA/Dec, nearest known object for
coordinate builds, stage, progress, elapsed, ETA, Cancel). Late results from an older load are
dropped. After a reload, every page restores the last field.

### Links and embedding
```
/explorer?ra=269.4521&dec=4.69336&fov=4&name=Barnard%27s%20Star&pmra=-798.58&pmdec=10328.12&epoch=2000&auto=1
/explorer?name=R%20Dra&auto=1
```
`ra`/`dec` are at `epoch`; with `pmra`/`pmdec` (mas/yr, pmra = μα·cos δ) the position is moved to
today and rounded to 0.001°. Without `auto=1` the field waits for Build. `embed=1` hides the masthead
and side panels ("Copy embed code"). The address bar follows the current target.

## Cosmo, the assistant
Round robot button bottom-right (it moves left of the inspector and above the timeline in the
explorer, so it never covers a side panel). The panel has a region sky map of the current field,
suggestions ("Show me WISE 0855", "How do I spot a moving object?", "What do the red marks mean?",
"What am I looking at?") and two brains, each labelled on its answers:
- **Scripted** (always works): answers from the live state (target, RA/Dec, epochs A/B, band, mode,
  named movers, nearest catalogued object) and commands: "show Barnard's Star", "go to 133.79 -7.24",
  "switch to difference", "detector 6".
- **SPHEREx AI** for open questions, streamed word by word with cited sources, via the backend
  (`SPHEREX_AI_KEY` in `backend/.env`). Without the key Cosmo says so and stays scripted.

## Errors are always explained
Backend offline → red banner with the start command, Copy and Retry. Redis off → small dismissible
note. IRSA throttling → "IRSA is slow right now" on the loading card. No images → "No SPHEREx
coverage here (yet)" with test targets and Try again. A crash in one view → "This view crashed" with
Try again; never a blank screen.
