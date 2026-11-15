import { FlaskConical, Grid3x3, Play, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiUrl, ApiError, planetx, type InjectPair, type InjectParams, type InjectResult, type SweepResult } from "../api/client";
import { Banner, CoordTable, KV, Panel, ProvChip, Spinner, cx } from "../components/ui";
import { fmtDate, parseDecInput, parseRAInput } from "../lib/coords";
import { useWorkspace } from "../state/workspace";

export const PLANETX_BANNER =
  "No Planet X data exists in NASA archives. This lab injects a SIMULATED test object into real SPHEREx images to test whether COSMIC Space Blink AI could detect one. Results here are not discoveries.";

const autoRate = (d: number) => (2.5 * 206265) / d / 365;

function Num({ label, value, onChange, min, max, step = 1, suffix, disabled }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; suffix?: string; disabled?: boolean }) {
  return (
    <label className="block">
      <span className="cap">{label}</span>
      <div className="mt-1 flex items-center gap-2">
        <input type="range" className="min-w-0 flex-1" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
        <input type="number" className="field num" style={{ width: 76 }} min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
        {suffix && <span className="text-ink-3" style={{ fontSize: 12, width: 30 }}>{suffix}</span>}
      </div>
    </label>
  );
}

/** One simulated image with the truth (dotted track, dashed circles) and the recovered detection (solid circles). */
function SimImage({ src, title, n, track, truthA, truthB, det, kind }: { src: string; title: string; n: number; track: [number, number][]; truthA?: [number, number]; truthB?: [number, number]; det?: InjectPair["detection"]; kind: "a" | "b" | "diff" }) {
  const S = 300;
  const U = S / n;
  const disp = (x: number, y: number): [number, number] => [(x + 0.5) * U, (n - 1 - y + 0.5) * U];
  const r = Math.max(9, 2.2 * U);
  const pts = track.map(([x, y]) => disp(x, y).join(",")).join(" ");
  return (
    <figure className="min-w-0">
      <div className="relative mx-auto aspect-square w-full" style={{ maxWidth: S, background: "#000", border: "1px solid var(--line)" }}>
        <img src={src} alt={title} className="absolute inset-0 h-full w-full" style={{ imageRendering: "pixelated" }} />
        <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${S} ${S}`} style={{ pointerEvents: "none" }}>
          {track.length > 1 && <polyline points={pts} fill="none" stroke="#ff5a5a" strokeWidth={1.4} strokeDasharray="2 4" opacity={0.9} />}
          {truthA && kind !== "b" && <circle cx={disp(...truthA)[0]} cy={disp(...truthA)[1]} r={r} fill="none" stroke="#ffb347" strokeWidth={1.3} strokeDasharray="3 3" />}
          {truthB && kind !== "a" && <circle cx={disp(...truthB)[0]} cy={disp(...truthB)[1]} r={r} fill="none" stroke="#ff5a5a" strokeWidth={1.3} strokeDasharray="3 3" />}
          {det && kind !== "b" && <circle cx={disp(det.from.x, det.from.y)[0]} cy={disp(det.from.x, det.from.y)[1]} r={r + 4} fill="none" stroke="#5ad1ff" strokeWidth={2} />}
          {det && kind !== "a" && <circle cx={disp(det.to.x, det.to.y)[0]} cy={disp(det.to.x, det.to.y)[1]} r={r + 4} fill="none" stroke="#5ad1ff" strokeWidth={2} />}
        </svg>
        <div className="absolute left-1.5 top-1.5">
          <ProvChip kind="simulated" force />
        </div>
      </div>
      <figcaption className="mt-1 text-center text-ink-2" style={{ fontSize: 12 }}>{title}</figcaption>
    </figure>
  );
}

function PairRow({ p, active, onClick }: { p: InjectPair; active: boolean; onClick: () => void }) {
  const color = p.recovered ? "var(--ok)" : p.tested ? "var(--bad)" : "var(--ink-3)";
  return (
    <button onClick={onClick} disabled={!p.tested} className={cx("w-full border-b px-2 py-1.5 text-left", )} style={{ background: active ? "color-mix(in srgb, var(--sel) 14%, transparent)" : undefined, borderColor: "var(--line)", fontSize: 12.5, opacity: p.tested ? 1 : 0.7 }}>
      <div className="flex items-center gap-2">
        <span style={{ width: 8, height: 8, borderRadius: 8, background: color, flex: "none" }} />
        <span className="font-semibold">
          {p.a_label} → {p.b_label}
        </span>
        {p.long_baseline && <span className="text-ink-3">(longest baseline)</span>}
        <span className="num ml-auto text-ink-3">{p.dt_days.toFixed(1)} d · {p.expected_shift_arcsec.toFixed(1)}″</span>
      </div>
      <div className="pl-4 text-ink-2">
        {p.recovered
          ? `Recovered: position error ${p.position_error_arcsec?.toFixed(1)}″, measured shift ${p.measured_shift_arcsec?.toFixed(1)}″ (injected ${p.expected_shift_arcsec.toFixed(1)}″), S/N ${p.snr?.toFixed(1)}`
          : p.reason}
      </div>
    </button>
  );
}

export default function PlanetXPage() {
  const { state } = useWorkspace();
  const wsSet = state.phase === "ready" ? state.setId : null;
  const wsName = state.target?.name ?? null;

  const [mode, setMode] = useState<"real" | "synthetic">(wsSet ? "real" : "synthetic");
  const [setId, setSetId] = useState(wsSet ?? "");
  const [raText, setRaText] = useState("");
  const [decText, setDecText] = useState("");
  const [dist, setDist] = useState(500);
  const [rateOverride, setRateOverride] = useState(false);
  const [rate, setRate] = useState(+autoRate(500).toFixed(2));
  const [pa, setPa] = useState(250);
  const [snr, setSnr] = useState(10);
  const [dets, setDets] = useState<number[]>([4, 5, 6]);
  const [seed, setSeed] = useState(1);

  const [busy, setBusy] = useState<"inject" | "sweep" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<InjectResult | null>(null);
  const [sweep, setSweep] = useState<SweepResult | null>(null);
  const [sel, setSel] = useState<number>(0);

  const ra = parseRAInput(raText);
  const dec = parseDecInput(decText);
  const startBad = (raText.trim() !== "" && ra.deg === null) || (decText.trim() !== "" && dec.deg === null) || (raText.trim() === "") !== (decText.trim() === "");

  const params = (): InjectParams => ({
    mode,
    set_id: mode === "real" ? setId.trim() : null,
    start_ra: raText.trim() ? ra.deg : null,
    start_dec: decText.trim() ? dec.deg : null,
    distance_au: dist,
    rate_arcsec_per_day: rateOverride ? rate : null,
    position_angle_deg: pa,
    peak_snr: snr,
    detectors: dets,
    seed,
  });

  const run = async (what: "inject" | "sweep") => {
    setBusy(what);
    setErr(null);
    try {
      if (what === "inject") {
        const r = await planetx.inject(params());
        setRes(r);
        const first = r.pairs.findIndex((p) => p.recovered);
        setSel(first >= 0 ? first : Math.max(0, r.pairs.findIndex((p) => p.tested)));
      } else {
        setSweep(await planetx.sweep(params()));
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const canRun = !busy && dets.length > 0 && !startBad && (mode === "synthetic" || setId.trim() !== "");
  const pair = res?.pairs[sel];
  const n = res?.grid.n ?? 0;
  const visit = (i: number) => res?.visits.find((v) => v.index === i);
  const track = useMemo(() => (res ? res.visits.filter((v) => v.in_field).map((v) => [v.truth_x, v.truth_y] as [number, number]) : []), [res]);
  const img = (index: number) => apiUrl(`/api/sets/${res!.sim_set_id}/image.png?`) + new URLSearchParams({ index: String(index), band: res!.band, group_by: "visit", stretch: "asinh", pmin: "1", pmax: "99.5", upscale: "4" });
  const diffUrl = (a: number, b: number) => apiUrl(`/api/sets/${res!.sim_set_id}/combine.png?`) + new URLSearchParams({ plus: String(b), minus: String(a), band: res!.band, group_by: "visit", tail: "3", cmap: "RdBu_r", upscale: "4" });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1400px] space-y-4 p-4">
        {/* always visible */}
        <div role="alert" className="flex items-start gap-3 border px-3 py-2.5" style={{ borderColor: "color-mix(in srgb, var(--bad) 55%, transparent)", background: "color-mix(in srgb, var(--bad) 9%, var(--panel))", borderRadius: 6 }}>
          <TriangleAlert size={18} style={{ color: "var(--bad)", flex: "none", marginTop: 1 }} />
          <div style={{ fontSize: 13.5, lineHeight: "20px" }}>
            <b style={{ color: "var(--bad)" }}>SIMULATED · </b>
            {PLANETX_BANNER}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <Panel title={<span className="flex items-center gap-2"><FlaskConical size={15} /> Injection test</span>} right={<ProvChip kind="simulated" force />}>
            <div className="space-y-3">
              <div className="seg flex w-full [&>button]:flex-1">
                <button aria-pressed={mode === "real"} onClick={() => setMode("real")}>Real SPHEREx field</button>
                <button aria-pressed={mode === "synthetic"} onClick={() => setMode("synthetic")}>Pure synthetic</button>
              </div>
              {mode === "real" ? (
                <div>
                  <span className="cap">Set (real frames are copied, never changed)</span>
                  <input className="field num mt-1" value={setId} placeholder="set id, e.g. s75acf0d653c1934" onChange={(e) => setSetId(e.target.value)} />
                  {wsSet ? (
                    <div className="mt-1 text-ink-3" style={{ fontSize: 12 }}>
                      Workspace: {wsName ?? "field"} ({wsSet}){setId !== wsSet && <button className="ml-2 underline" onClick={() => setSetId(wsSet)}>use it</button>}
                    </div>
                  ) : (
                    <div className="mt-1 text-ink-3" style={{ fontSize: 12 }}>
                      No field loaded. <Link className="underline" to="/explorer">Build one in the Blink Explorer</Link>, or use pure synthetic mode.
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-ink-3" style={{ fontSize: 12 }}>Noise images (σ = 1) with 10 static stars, 4 visits over 3 weeks plus one 6 months later. Nothing from IRSA.</div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="cap">Start RA</span>
                  <input className={cx("field num mt-1")} value={raText} placeholder="field centre" onChange={(e) => setRaText(e.target.value)} />
                </label>
                <label className="block">
                  <span className="cap">Start Dec</span>
                  <input className={cx("field num mt-1")} value={decText} placeholder="field centre" onChange={(e) => setDecText(e.target.value)} />
                </label>
              </div>
              {startBad && <div style={{ color: "var(--bad)", fontSize: 12 }}>Give both RA and Dec (e.g. 08 55 10.8 / −07 14 43), or leave both empty.</div>}

              <Num label="Distance" value={dist} min={300} max={1000} step={10} suffix="AU" onChange={(v) => { setDist(v); if (!rateOverride) setRate(+autoRate(v).toFixed(2)); }} />
              <div>
                <label className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
                  <input type="checkbox" checked={rateOverride} onChange={(e) => { setRateOverride(e.target.checked); if (!e.target.checked) setRate(+autoRate(dist).toFixed(2)); }} />
                  Override rate (auto: <span className="num">{autoRate(dist).toFixed(2)}″/day</span>)
                </label>
                {rateOverride && <Num label="Rate" value={rate} min={0.1} max={30} step={0.1} suffix="″/d" onChange={setRate} />}
              </div>
              <Num label="Direction (position angle, E of N)" value={pa} min={0} max={359} suffix="°" onChange={setPa} />
              <Num label="Peak S/N per frame" value={snr} min={3} max={50} suffix="σ" onChange={setSnr} />
              <div>
                <span className="cap">Detectors to inject into</span>
                <div className="seg mt-1 flex w-full [&>button]:flex-1">
                  {[1, 2, 3, 4, 5, 6].map((d) => (
                    <button key={d} aria-pressed={dets.includes(d)} onClick={() => setDets((s) => (s.includes(d) ? s.filter((x) => x !== d) : [...s, d].sort()))}>
                      D{d}
                    </button>
                  ))}
                </div>
                <div className="mt-1 text-ink-3" style={{ fontSize: 11.5 }}>A cold distant planet is brightest at 3–5 µm (D4–D6).</div>
              </div>
              <label className="block">
                <span className="cap">Seed</span>
                <input type="number" className="field num mt-1" style={{ width: 100 }} value={seed} onChange={(e) => setSeed(Math.max(1, Number(e.target.value) || 1))} />
              </label>

              <div className="flex flex-wrap gap-2 pt-1">
                <button className="btn btn-primary" disabled={!canRun} onClick={() => run("inject")}>
                  <Play size={14} /> Run injection test
                </button>
                <button className="btn" disabled={!canRun} onClick={() => run("sweep")} title="peak S/N 3, 5, 8, 12 × distance 300, 500, 800 AU">
                  <Grid3x3 size={14} /> Sensitivity sweep
                </button>
              </div>
              {busy && <Spinner label={busy === "inject" ? "Injecting and running the mover detector…" : "Running 12 injection tests (can take a minute)…"} />}
              {err && <Banner tone="bad" title="Test failed">{err}</Banner>}
            </div>
          </Panel>

          <div className="min-w-0 space-y-4">
            {!res && !busy && (
              <Panel title="How the test works">
                <ol className="list-decimal space-y-1.5 pl-5 text-ink-2" style={{ fontSize: 13 }}>
                  <li>The frames of the chosen field are copied into a new <b>SIMULATED</b> set (the real set is never changed).</li>
                  <li>A Gaussian (FWHM 6.5″) is added at the object&rsquo;s position at each frame&rsquo;s time, with peak = S/N × that frame&rsquo;s noise.</li>
                  <li>Frames are grouped into visits (gaps over 2 days). Six months between survey passes move a 500 AU object ~500″, more than the 4′ field, so pairs inside one pass are tested.</li>
                  <li>The normal mover detector runs on each pair and its result is compared with the truth.</li>
                </ol>
              </Panel>
            )}

            {res && (
              <>
                <Panel title="Result" right={<ProvChip kind="simulated" force />}>
                  <div className="flex items-start gap-3">
                    <span style={{ width: 12, height: 12, borderRadius: 12, marginTop: 5, flex: "none", background: res.summary.n_recovered ? "var(--ok)" : "var(--bad)" }} />
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 600 }}>{res.summary.message}</div>
                      <div className="mt-0.5 text-ink-3" style={{ fontSize: 12 }}>
                        {res.label}. {res.params.mode === "real" ? `Injected into copies of real set ${res.parent_set_id}` : "Pure synthetic frames"} as {res.sim_set_id}.
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                    <KV k="Distance" v={`${res.params.distance_au} AU`} />
                    <KV k="Rate" v={`${(res.params.rate_arcsec_per_day ?? 0).toFixed(2)}″/day${res.params.rate_auto ? " (auto)" : ""}`} />
                    <KV k="Direction" v={`PA ${res.params.position_angle_deg.toFixed(0)}°`} />
                    <KV k="Peak S/N" v={`${res.params.peak_snr} per frame`} />
                    <KV k="Detectors" v={res.params.detectors.map((d) => `D${d}`).join(", ")} />
                    <KV k="Track start" v={fmtDate(res.params.t0_mjd)} />
                  </div>
                  <div className="mt-3">
                    <span className="cap">Simulated start position</span>
                    <CoordTable ra={res.start.ra} dec={res.start.dec} />
                  </div>
                </Panel>

                <Panel title="Visit pairs" right={<span className="text-ink-3" style={{ fontSize: 12 }}>{res.summary.n_tested} tested · {res.summary.n_recovered} recovered</span>}>
                  <div className="max-h-[260px] overflow-y-auto">
                    {res.pairs.map((p, i) => (
                      <PairRow key={`${p.a}-${p.b}`} p={p} active={i === sel} onClick={() => setSel(i)} />
                    ))}
                  </div>
                </Panel>

                {pair?.tested && res.sim_set_id && (
                  <Panel title={`${pair.a_label} → ${pair.b_label}`} right={<span className="text-ink-3" style={{ fontSize: 12 }}>band {res.band.replace(/(\d)/g, "D$1")}</span>}>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <SimImage kind="a" n={n} src={img(pair.a)} title={`A · ${pair.a_label}`} track={track} truthA={[visit(pair.a)!.truth_x, visit(pair.a)!.truth_y]} det={pair.detection} />
                      <SimImage kind="b" n={n} src={img(pair.b)} title={`B · ${pair.b_label}`} track={track} truthB={[visit(pair.b)!.truth_x, visit(pair.b)!.truth_y]} det={pair.detection} />
                      <SimImage kind="diff" n={n} src={diffUrl(pair.a, pair.b)} title="B − A (dipole: dark = old, bright = new)" track={track} truthA={[visit(pair.a)!.truth_x, visit(pair.a)!.truth_y]} truthB={[visit(pair.b)!.truth_x, visit(pair.b)!.truth_y]} det={pair.detection} />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-ink-3" style={{ fontSize: 12 }}>
                      <span><span style={{ color: "#ff5a5a" }}>┄┄</span> true track (SIMULATED)</span>
                      <span><span style={{ color: "#ffb347" }}>◌</span> true position in A</span>
                      <span><span style={{ color: "#ff5a5a" }}>◌</span> true position in B</span>
                      <span><span style={{ color: "#5ad1ff" }}>◯</span> recovered by the detector</span>
                    </div>
                  </Panel>
                )}
              </>
            )}

            {sweep && (
              <Panel title="Sensitivity sweep" right={<ProvChip kind="simulated" force />}>
                <div className="overflow-x-auto">
                  <table className="w-full num" style={{ fontSize: 12.5, borderCollapse: "collapse" }}>
                    <thead>
                      <tr className="text-ink-3">
                        <th className="px-2 py-1 text-left">Distance</th>
                        {sweep.snr_values.map((s) => (
                          <th key={s} className="px-2 py-1 text-center">S/N {s}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sweep.distances_au.map((d) => (
                        <tr key={d} style={{ borderTop: "1px solid var(--line)" }}>
                          <td className="px-2 py-1.5">
                            {d} AU <span className="text-ink-3">({autoRate(d).toFixed(1)}″/d)</span>
                          </td>
                          {sweep.snr_values.map((s) => {
                            const r = sweep.rows.find((x) => x.distance_au === d && x.peak_snr === s)!;
                            const frac = r.n_tested ? r.n_recovered / r.n_tested : 0;
                            return (
                              <td key={s} className="px-2 py-1.5 text-center" title={r.message} style={{ background: r.n_tested ? `color-mix(in srgb, var(--ok) ${Math.round(frac * 45)}%, transparent)` : undefined }}>
                                {r.n_tested ? `${r.n_recovered}/${r.n_tested}` : "–"}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-2 text-ink-3" style={{ fontSize: 12 }}>Visit pairs recovered / tested. “–”: no testable pair. Other parameters as in the form.</div>
              </Panel>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
