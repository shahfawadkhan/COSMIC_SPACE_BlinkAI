import { Download, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, photometry, type PhotParams, type PhotResult, type PhotRow, type PhotStatus } from "../api/client";
import { Plot } from "../components/Plot";
import { Banner, CoordTable, KV, Panel, ProvChip, Spinner } from "../components/ui";
import { useWorkspace } from "../state/workspace";

type Tab = "astrometry" | "lightcurve" | "spectrum";
const BAND_HEX: Record<number, string> = { 1: "#6aa7ff", 2: "#26b3b3", 3: "#5fae3c", 4: "#d4b21c", 5: "#f09a4a", 6: "#ef6b73" };
const APERTURES = [6, 9, 12, 18];

function byDetector(rows: PhotRow[], x: (r: PhotRow) => number | string | null, xerr?: (r: PhotRow) => number | null) {
  const traces = [];
  for (let d = 1; d <= 6; d++) {
    const rs = rows.filter((r) => r.detector === d && r.status === "ok" && x(r) !== null && r.flux_mjy !== undefined);
    if (!rs.length) continue;
    traces.push({
      type: "scatter",
      mode: "markers",
      name: `D${d}`,
      x: rs.map(x),
      y: rs.map((r) => r.flux_mjy),
      error_y: { type: "data", array: rs.map((r) => r.err_mjy ?? 0), thickness: 1, width: 2, color: BAND_HEX[d] },
      ...(xerr ? { error_x: { type: "data", array: rs.map((r) => xerr(r) ?? 0), thickness: 1, width: 0, color: BAND_HEX[d] } } : {}),
      marker: { color: rs.map((r) => (r.blend ? "rgba(0,0,0,0)" : BAND_HEX[d])), size: 8, line: { color: BAND_HEX[d], width: 1.6 } },
      text: rs.map((r) => `${r.date.slice(0, 10)} · ${r.wavelength_um?.toFixed(3) ?? "?"} µm · S/N ${r.snr?.toFixed(1)}${r.blend ? ` · blended with ${r.blend[0].id} (${r.blend[0].sep_arcsec}″)` : ""}`),
      hovertemplate: "%{text}<br>%{y:.3f} mJy<extra>D" + d + "</extra>",
    });
  }
  return traces;
}

export default function AnalysisPage() {
  const { state } = useWorkspace();
  const t = state.target;
  const setId = state.phase === "ready" ? state.setId : null;
  const [tab, setTab] = useState<Tab>("lightcurve");
  const [aperture, setAperture] = useState(12);
  const [status, setStatus] = useState<PhotStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState(0);

  const params: PhotParams | null = useMemo(() => {
    if (!t) return null;
    const hasCat = t.catRa !== undefined && t.catDec !== undefined && !!t.epoch;
    return {
      ra: hasCat ? t.catRa! : t.ra,
      dec: hasCat ? t.catDec! : t.dec,
      pm_ra: hasCat ? (t.pmra ?? 0) : 0,
      pm_dec: hasCat ? (t.pmdec ?? 0) : 0,
      epoch: hasCat ? t.epoch! : 2000,
      aperture_arcsec: aperture,
      max_frames: 40,
      set_id: setId,
    };
  }, [t, aperture, setId]);

  // background job: ask, then poll every second until done (same params = same job)
  useEffect(() => {
    if (!params) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setStatus(null);
    setError(null);
    const poll = async () => {
      try {
        const s = await photometry.get(params, ctl.signal);
        setStatus(s);
        if (s.state === "error") setError(s.error?.message ?? "Measurement failed");
        else if (s.state !== "done") timer = setTimeout(poll, 1000);
      } catch (e) {
        if (!ctl.signal.aborted) setError(e instanceof ApiError ? e.message : String(e));
      }
    };
    poll();
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, [params, run]);

  const res: PhotResult | null = status?.result ?? null;
  const rows = res?.rows ?? [];
  const lc = useMemo(() => byDetector(rows, (r) => r.date), [rows]);
  const sp = useMemo(() => byDetector(rows, (r) => r.wavelength_um, (r) => (r.bandwidth_um ? r.bandwidth_um / 2 : null)), [rows]);
  const astro = useMemo(() => {
    const ok = rows.filter((r) => r.dra_arcsec !== undefined);
    const mk = (key: "dra_arcsec" | "ddec_arcsec", name: string, color: string) => ({
      type: "scatter",
      mode: "markers",
      name,
      x: ok.map((r) => r.date),
      y: ok.map((r) => r[key]),
      marker: { color: ok.map((r) => (r.blend ? "rgba(0,0,0,0)" : color)), size: 8, line: { color, width: 1.6 } },
      text: ok.map((r) => `D${r.detector}${r.blend ? ` · blended (${r.blend[0].sep_arcsec}″ from ${r.blend[0].id})` : ""}`),
      hovertemplate: "%{x}<br>%{y:.2f}″ · %{text}<extra>" + name + "</extra>",
    });
    return [mk("dra_arcsec", "ΔRA·cos δ", "#1566b8"), mk("ddec_arcsec", "ΔDec", "#d9534f")];
  }, [rows]);

  if (!t) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-14">
          <h1 className="h1 m-0" style={{ fontSize: 30 }}>
            AstroAnalytics
          </h1>
          <p className="mt-3 text-ink2" style={{ fontSize: 15 }}>
            Astrometry, light curve and spectrum of one object from every SPHEREx image of it.
          </p>
          <div className="mt-5">
            <Banner tone="info" title="No target yet" action={<Link className="btn btn-primary" to="/explorer">Open Blink Explorer</Link>}>
              Choose a target in the Blink Explorer (building its field first makes this instant: the images are reused).
            </Banner>
          </div>
        </div>
      </div>
    );
  }

  const s = res?.summary;
  const prog = status?.progress;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1250px] space-y-4 px-5 py-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="h1 m-0" style={{ fontSize: 26 }}>
              AstroAnalytics
            </h1>
            <div className="text-ink2">{t.name ?? "Sky position"}</div>
          </div>
          <div className="seg" role="tablist" aria-label="Analysis">
            {(
              [
                ["astrometry", "Astrometry"],
                ["lightcurve", "Light curve"],
                ["spectrum", "Spectrum"],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} aria-pressed={tab === id} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="space-y-4">
            <Panel title="Source" right={<ProvChip kind="irsa" />}>
              <CoordTable ra={t.ra} dec={t.dec} />
              {(t.pmra || t.pmdec) && <KV k="Catalogue μ" v={`${(t.pmra ?? 0).toFixed(0)}, ${(t.pmdec ?? 0).toFixed(0)} mas/yr`} />}
              <div className="mt-2">
                <div className="cap mb-1">Aperture radius</div>
                <div className="seg">
                  {APERTURES.map((a) => (
                    <button key={a} aria-pressed={aperture === a} onClick={() => setAperture(a)} className="num">
                      {a}″
                    </button>
                  ))}
                </div>
              </div>
              <p className="mb-0 mt-2 text-ink3" style={{ fontSize: 12 }}>
                Position moved to each image&rsquo;s date with the proper motion; sky from a local annulus; wavelength from the detector&rsquo;s WCS-WAVE table. Fluxes are aperture fluxes (no aperture correction). {setId ? "Images reused from the built field (no second download)." : "No field built: small cutouts are downloaded."}
              </p>
            </Panel>
            {s && (
              <Panel title="Measurements">
                <KV k="Images" v={s.n_images} />
                <KV k="Measured" v={s.n_measured} />
                <KV k="Detected (S/N ≥ 5)" v={s.n_detected} />
                <KV k="Saturated" v={s.n_saturated} />
                <KV k="Blended with a Gaia star" v={s.n_blended} />
                {s.n_masked + s.n_outside > 0 && <KV k="Masked / off edge" v={`${s.n_masked} / ${s.n_outside}`} />}
                <p className="mb-2 mt-1 text-ink3" style={{ fontSize: 11.5 }}>
                  Blends: {s.blend_check}. Hollow markers = blended.
                </p>
                <div className="flex gap-2">
                  <a className="btn btn-primary" href={photometry.csvUrl(params!)} download>
                    <Download size={14} />
                    CSV
                  </a>
                  <button className="btn" onClick={() => setRun((x) => x + 1)} title="Ask again">
                    <RotateCcw size={14} />
                  </button>
                </div>
              </Panel>
            )}
          </div>

          <div className="space-y-3">
            {error && <Banner tone="bad" title="Measurement failed">{error}</Banner>}
            {!res && !error && (
              <div className="panel p-5">
                <Spinner label={status?.state === "running" ? `${status.message ?? "Measuring"}${prog?.total ? ` · ${prog.done} of ${prog.total}` : ""}` : "Starting measurement…"} />
                <div className="scanbar mt-3" />
              </div>
            )}
            {s?.message && (
              <Banner tone="warn" title={s.n_measured === 0 ? "No usable measurement – star saturated" : "Some images saturated"}>
                {s.n_measured === 0
                  ? "This star is so bright that its centre is masked (OVERFLOW / NONLINEAR) in every SPHEREx image, so its flux cannot be measured here. Its motion can still be seen in the Blink Explorer (halo matching)."
                  : s.message}
              </Banner>
            )}
            {s?.blend_message && <Banner tone="warn" title="Neighbouring star in the aperture">{s.blend_message} Try a smaller aperture.</Banner>}

            {res && tab === "lightcurve" && (
              <Panel title="Light curve: flux vs date" right={<ProvChip kind="derived" />}>
                {lc.length ? <Plot data={lc} layout={{ xaxis: { title: { text: "Date (UTC)" } }, yaxis: { title: { text: "Aperture flux (mJy)" } } }} /> : <p className="m-0 text-ink2">No measured points.</p>}
                <p className="mb-0 mt-1 text-ink3" style={{ fontSize: 12 }}>
                  Colours are detectors (bands). Different wavelengths are different colours of the object: compare like with like (one detector) when looking for variability.
                </p>
              </Panel>
            )}
            {res && tab === "spectrum" && (
              <Panel title="Spectrum: flux vs wavelength" right={<ProvChip kind="derived" />}>
                {sp.length ? <Plot data={sp} layout={{ xaxis: { title: { text: "Wavelength (µm)" }, range: [0.7, 5.05] }, yaxis: { title: { text: "Aperture flux (mJy)" } } }} /> : <p className="m-0 text-ink2">No measured points.</p>}
                <p className="mb-0 mt-1 text-ink3" style={{ fontSize: 12 }}>
                  Each point is one exposure; its wavelength depends on where the object fell on the detector&rsquo;s linear variable filter. Horizontal bars: half the channel bandwidth. Points from different dates mix any variability into the spectrum.
                </p>
              </Panel>
            )}
            {res && tab === "astrometry" && (
              <Panel title="Astrometry: centroid minus catalogue prediction" right={<ProvChip kind="derived" />}>
                {astro[0].x.length ? (
                  <Plot data={astro} layout={{ xaxis: { title: { text: "Date (UTC)" } }, yaxis: { title: { text: "Offset (arcsec)" }, zeroline: true } }} />
                ) : (
                  <p className="m-0 text-ink2">No centroids: astrometry needs S/N ≥ 5 and an unmasked core.</p>
                )}
                {res.motion_fit ? (
                  <div className="num mt-2" style={{ fontSize: 13 }}>
                    Measured proper motion from {res.motion_fit.n} unblended images over {res.motion_fit.baseline_yr.toFixed(2)} yr: μα* = {res.motion_fit.pmra_mas_yr.toFixed(0)} ± {res.motion_fit.pmra_err_mas_yr.toFixed(0)}, μδ = {res.motion_fit.pmdec_mas_yr.toFixed(0)} ± {res.motion_fit.pmdec_err_mas_yr.toFixed(0)} mas/yr
                    {(t.pmra || t.pmdec) && (
                      <span className="text-ink3">
                        {" "}
                        (catalogue {(t.pmra ?? 0).toFixed(0)}, {(t.pmdec ?? 0).toFixed(0)})
                      </span>
                    )}
                  </div>
                ) : (
                  <p className="mb-0 mt-2 text-ink3" style={{ fontSize: 12.5 }}>
                    No proper-motion fit: it needs at least 3 clean (unblended, S/N ≥ 5) centroids spread over time.
                  </p>
                )}
                <p className="mb-0 mt-1 text-ink3" style={{ fontSize: 12 }}>
                  Zero = exactly where the catalogue proper motion predicts. A drift means the catalogue motion is off, or the centroid is pulled by a neighbour.
                </p>
              </Panel>
            )}
            {res && (
              <details className="panel p-3">
                <summary className="link cursor-pointer">Data table ({rows.length} images)</summary>
                <div className="mt-2 max-h-80 overflow-auto">
                  <table className="w-full border-collapse" style={{ fontSize: 12 }}>
                    <thead className="text-left text-ink3">
                      <tr>
                        {["Date", "Det", "λ (µm)", "Flux (mJy)", "S/N", "Status"].map((h) => (
                          <th key={h} className="sticky top-0 bg-s0 pb-1 pr-2">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i} className="border-t border-line">
                          <td className="num py-0.5 pr-2">{r.date.slice(0, 10)}</td>
                          <td className="num pr-2">D{r.detector}</td>
                          <td className="num pr-2">{r.wavelength_um?.toFixed(3) ?? "–"}</td>
                          <td className="num pr-2">{r.flux_mjy !== undefined ? `${r.flux_mjy.toFixed(3)} ± ${r.err_mjy?.toFixed(3)}` : "–"}</td>
                          <td className="num pr-2">{r.snr?.toFixed(1) ?? "–"}</td>
                          <td className={r.status === "ok" ? (r.blend ? "text-warn" : "") : "text-bad"}>{r.status === "ok" ? (r.blend ? `blended (${r.blend[0].sep_arcsec}″)` : "ok") : r.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
