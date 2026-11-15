# Tester checklist

Run this before each demo and after every merge window. Start the backend and the frontend
first (see *Quick start* in the README). The first time a field opens it downloads from IRSA
(30–60 s); later it opens in about 1 s.

Mark each line ✅ or ❌. For ❌, open a GitHub Issue with the page, the steps and a screenshot.

## 1. Smoke test (5 minutes)

| # | Steps | Expected |
|---|---|---|
| 1.1 | Open http://localhost:3000 | Top bar shows **Online** (green) and Redis status. No red error banner. |
| 1.2 | Click **Watch Barnard's Star move** | Blink Explorer opens, shows progress, then blinks images with the **NASA IRSA DATA** chip. |
| 1.3 | Click detector **3** on the timeline, then press `5` (Difference mode) | A red ring named **Barnard's Star** with an arrow pointing north; Inspector says *✓ matches catalogue motion*. |
| 1.4 | Click D1 … D6 on the timeline | Images change with each detector. |
| 1.5 | Open `/planetx`, choose *Pure synthetic*, click **Run injection test** | Red SIMULATED banner at the top; result *Injected object recovered in 4 of 4 visit pairs*. |
| 1.6 | Open Cosmo (robot button), ask *What is SPHEREx?* | Answer tagged **SPHEREx AI**, with sources and a **✓ Verified facts** box. |

## 2. Challenge objects

| Object | Steps | Expected |
|---|---|---|
| Barnard's Star | Explorer → Difference, A = first pass, B = last pass | Shift ≈ 5–7″ north, named ring, catalogue agrees within a few arcseconds. |
| WISE 0855−0714 | Explorer → detector **D5** or **D6**, Blink | Teal dashed circle (catalogue position for the shown date) moves between passes. The source is faint; no automatic ring is expected in DR1. |
| Epsilon Indi B | Explorer → D4–D6, Blink | Source near the predicted circle; small shift. |
| RW Aurigae | AstroAnalytics → Light curve | Points with error bars; brightness changes between epochs. |
| R Draconis | AstroAnalytics → Light curve and Spectrum | Brightness changes, or a clear *star saturated* message for saturated images. |

## 3. Search and coordinates

| # | Steps | Expected |
|---|---|---|
| 3.1 | Mission Control → Object name `RW Aur` | Resolves to RW Aurigae and builds. |
| 3.2 | Coordinates `08 55 10.8` / `-07 14 42` | Parsed value shown in degrees too; the field builds. |
| 3.3 | Coordinates `133.795 -7.245` pasted into the RA box | Split into RA and Dec automatically. |
| 3.4 | Invalid input `25h 00m` | Clear error message, no request sent. |
| 3.5 | Copy the explorer URL into a new tab | Same field opens. |
| 3.6 | Every coordinate on screen | Shows RA and Dec, both sexagesimal and degrees. |

## 4. Unknown objects

| # | Steps | Expected |
|---|---|---|
| 4.1 | In any field, find an **orange** ring | Label *Unidentified candidate*; Inspector shows *Unidentified candidate – needs further scientific investigation. Not a claim of Planet X.* with a link to the Planet X Lab. |
| 4.2 | Click the ring → Add to Discovery Log | Appears in `/candidates` with status *Unvalidated*. |
| 4.3 | Discovery Log → **Check SIMBAD + Gaia** | Cross-match result shown (match or none). |
| 4.4 | Measure the object in two epochs | A derived proper motion appears. |
| 4.5 | Export CSV | File opens; the header says *Candidates, not discoveries*. |

## 5. Planet X Lab

| # | Steps | Expected |
|---|---|---|
| 5.1 | Banner | Always visible at the top, red, starting *No Planet X data exists in NASA archives*. |
| 5.2 | Real field: open a field in the explorer first, then `/planetx` → *Real SPHEREx field* | The workspace set id is filled in. |
| 5.3 | Run with S/N 30 | Recovered in at least one pair; images show the dotted true track, dashed true positions and blue recovery circles; every image has a red SIMULATED chip. |
| 5.4 | Run with S/N 3 on the real field | *Not recovered – too faint for these epochs*. |
| 5.5 | Sensitivity sweep | 3 × 4 table of recovered / tested pairs. |
| 5.6 | Go back to the explorer | The real field is unchanged (no injected source). |

## 6. Cosmo assistant

| Ask | Expected |
|---|---|
| *What is SPHEREx?* | Correct: NASA MIDEX mission, launched March 2025, 0.75–5 µm, 102 bands. Verified-facts box. |
| *When did SPHEREx launch?* | 11 March 2025. If the AI says something else, the box shows ⚠ and the correct fact. |
| *What am I looking at?* (in the explorer) | Describes the current target, epochs and rings. |
| *show Barnard's Star* | Opens Barnard's Star in the explorer. |
| *go to 133.79 -7.24* | Opens those coordinates. |
| *Is this Planet X?* | Explains there is no Planet X data; points to the Planet X Lab. |
| Close and reopen the panel | Starts a fresh conversation. |
| Drag the panel's top-left corner; click the expand button | The panel resizes. |

## 7. Layout

Check `/`, `/explorer`, `/planetx` at phone width (375 px), tablet (768 px) and desktop:
nothing cut off, no sideways scrolling of the page, menus reachable.
