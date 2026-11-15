import { UnidentifiedNote } from "../components/UnidentifiedNote";
import { ArrowLeftRight, Pause, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { combineUrl, imageUrl, type MoverPair, type MoversResponse, type ViewEpoch } from "../api/client";
import { DETECTOR_UM, bandColor } from "../components/Timeline";
import { Banner, Panel, ProvChip, Spinner, cx } from "../components/ui";
import { usePreload } from "../hooks/usePreload";
import { useMovers, useSetView } from "../hooks/useSetView";
import { fmtDate } from "../lib/coords";
import { useCandidates } from "../state/candidates";
import { TAILS, useView } from "../state/view";
import { useWorkspace } from "../state/workspace";

const RATES = [
  { ms: 1000, label: "1 Hz" },
  { ms: 500, label: "2 Hz" },
  { ms: 250, label: "4 Hz" },
];

/** One square image with mover rings drawn in grid pixels (row 0 = south; the PNG is north up). */
function EpochImage({ url, ready, n, pairs, kind, title, tone, chip }: { url: string | null; ready: boolean; n: number; pairs: MoverPair[]; kind: "A" | "B" | "diff"; title: React.ReactNode; tone: string; chip: "irsa" | "derived" }) {
  const P = (x: number, y: number): [number, number] => [x + 0.5, n - 1 - y + 0.5];
  const r = Math.max(2.5, n / 26);
  return (
    <figure className="m-0">
      <figcaption className="mb-1 flex items-center justify-between gap-2" style={{ fontSize: 13, fontWeight: 600, color: tone }}>
        <span>{title}</span>
        <ProvChip kind={chip} force />
      </figcaption>
      <div className="checker relative aspect-square w-full overflow-hidden rounded border border-line" style={{ background: "#000" }}>
        {url && ready ? <img src={url} alt="" className="pixelated absolute inset-0 h-full w-full" /> : <div className="absolute inset-0 flex items-center justify-center text-white/70"><Spinner /></div>}
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${n} ${n}`}>
          {pairs.map((p, i) => {
            const named = p.identified !== false && !!p.name && !p.name.startsWith("Unidentified");
            const col = named ? "#ff3b3b" : "#ff9f1a";
            const [x1, y1] = P(p.from.x, p.from.y);
            const [x2, y2] = P(p.to.x, p.to.y);
            return (
              <g key={i} fill="none" stroke={col} strokeWidth={0.35}>
                {kind !== "B" && <circle cx={x1} cy={y1} r={r} strokeDasharray="1 0.7" />}
                {kind !== "A" && <circle cx={x2} cy={y2} r={r} />}
                {kind === "diff" && <line x1={x1} y1={y1} x2={x2} y2={y2} />}
              </g>
            );
          })}
        </svg>
      </div>
    </figure>
  );
}

function row(label: string, a: React.ReactNode, b: React.ReactNode) {
  return (
    <tr>
      <th className="py-1 pr-3 text-left text-ink3" style={{ fontWeight: 500 }}>
        {label}
      </th>
      <td className="num py-1 pr-3">{a}</td>
      <td className="num py-1">{b}</td>
    </tr>
  );
}

function wl(e?: ViewEpoch) {
  return e?.wavelength_um ? `${e.wavelength_um[0].toFixed(2)}–${e.wavelength_um[1].toFixed(2)} µm` : "–";
}

export default function ComparePage() {
  const { state } = useWorkspace();
  const { view: gv } = useView();
  const cands = useCandidates();
  const setId = state.phase === "ready" ? state.setId : null;
  const [band, setBand] = useState(gv.band);
  const { view, error } = useSetView(setId, band);
  const n = view?.epochs.length ?? 0;
  const [a, setA] = useState(gv.a);
  const [b, setB] = useState(gv.b);
  const [stretch, setStretch] = useState(gv.stretch);
  const [tail, setTail] = useState(gv.tail);
  const [rate, setRate] = useState(500);
  const [blinking, setBlinking] = useState(true);
  const [phase, setPhase] = useState(false);
  const [added, setAdded] = useState<string | null>(null);

  useEffect(() => {
    // keep A and B inside this set's epochs; on first load, compare the first and last pass
    if (n && (a >= n || b >= n || (a === b && n > 1))) {
      setA(0);
      setB(n - 1);
    }
  }, [n]); // eslint-disable-line react-hooks/exhaustive-deps

  const U = view ? Math.max(1, Math.min(8, Math.round(400 / view.grid.n))) : 4;
  const urlFor = (i: number) => {
    const e = view?.epochs[i];
    return e?.image_url ? imageUrl(e.image_url, { stretch, cmap: "gray", pmin: gv.pmin, pmax: gv.pmax, upscale: U }) : null;
  };
  const urlA = urlFor(a);
  const urlB = urlFor(b);
  const diff = setId && view && a !== b ? combineUrl(setId, a, b, band, tail, "RdBu_r", U) : null;
  const list = useMemo(() => [urlA, urlB, diff].filter((u): u is string => !!u), [urlA, urlB, diff]);
  const ready = usePreload(list);
  const movers: MoversResponse | null = useMovers(setId, a, b, band, true);
  const pairs = movers?.pairs ?? [];

  useEffect(() => {
    if (!blinking || !urlA || !urlB || !ready.has(urlA) || !ready.has(urlB)) return;
    const t = setInterval(() => setPhase((x) => !x), rate);
    return () => clearInterval(t);
  }, [blinking, rate, urlA, urlB, ready]);

  if (!setId) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-14">
          <h1 className="h1 m-0" style={{ fontSize: 30 }}>
            Image Exploration
          </h1>
          <p className="mt-3 text-ink2" style={{ fontSize: 15 }}>
            Compare two epochs of the field you built: side by side, blinking, and as a difference image with named movers.
          </p>
          <div className="mt-5">
            <Banner tone="info" title="No field loaded yet" action={<Link className="btn btn-primary" to="/explorer">Open Blink Explorer</Link>}>
              {state.phase === "building" || state.phase === "resolving" ? "A field is being built in the Blink Explorer. Come back when it is ready." : "Build a field in the Blink Explorer first; it then appears here."}
            </Banner>
          </div>
        </div>
      </div>
    );
  }

  const eA = view?.epochs[a];
  const eB = view?.epochs[b];
  const dt = eA && eB ? eB.mjd - eA.mjd : 0;
  const have = new Set(state.manifest?.frames.map((f) => f.detector));
  const opts = view?.epochs.map((e) => (
    <option key={e.index} value={e.index} disabled={!e.has_data}>
      {e.label} · {e.n_frames} exp.
    </option>
  ));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1300px] space-y-4 px-5 py-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="h1 m-0" style={{ fontSize: 26 }}>
              Image Exploration
            </h1>
            <div className="text-ink2">
              {state.target?.name ?? "Sky position"} · {state.manifest?.grid.fov_arcmin}′ field ·{" "}
              <Link className="link" to="/explorer">
                back to Blink Explorer
              </Link>
            </div>
          </div>
          <ProvChip kind="irsa" force />
        </div>

        <div className="panel flex flex-wrap items-end gap-3 p-3">
          <label>
            <span className="cap" style={{ color: "var(--ref)" }}>
              Epoch A
            </span>
            <select className="field mt-1" style={{ width: 210 }} value={a} onChange={(e) => setA(Number(e.target.value))}>
              {opts}
            </select>
          </label>
          <button className="btn" onClick={() => (setA(b), setB(a))} title="Swap A and B">
            <ArrowLeftRight size={14} />
            Swap A↔B
          </button>
          <label>
            <span className="cap" style={{ color: "var(--sel)" }}>
              Epoch B
            </span>
            <select className="field mt-1" style={{ width: 210 }} value={b} onChange={(e) => setB(Number(e.target.value))}>
              {opts}
            </select>
          </label>
          <div>
            <div className="cap mb-1">Detector</div>
            <div className="seg">
              <button aria-pressed={band === "all"} onClick={() => setBand("all")}>
                All
              </button>
              {[1, 2, 3, 4, 5, 6].map((d) => (
                <button key={d} aria-pressed={band === String(d)} disabled={!have.has(d)} onClick={() => setBand(String(d))} title={`${DETECTOR_UM[d][0]}–${DETECTOR_UM[d][1]} µm`}>
                  <span style={{ display: "inline-block", width: 7, height: 7, background: bandColor(d), marginRight: 4 }} />
                  {d}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="cap mb-1">Stretch</div>
            <div className="seg">
              {["linear", "sqrt", "asinh", "log"].map((s) => (
                <button key={s} aria-pressed={stretch === s} onClick={() => setStretch(s)} className="num" style={{ fontSize: 11, textTransform: "uppercase" }}>
                  {s === "linear" ? "lin" : s}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="cap mb-1">Blink</div>
            <div className="flex gap-1">
              <button className="btn btn-icon" aria-label={blinking ? "Pause blink" : "Start blink"} onClick={() => setBlinking((x) => !x)}>
                {blinking ? <Pause size={14} /> : <Play size={14} />}
              </button>
              <div className="seg">
                {RATES.map((r) => (
                  <button key={r.ms} aria-pressed={rate === r.ms} onClick={() => setRate(r.ms)}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <div className="cap mb-1">Difference shows</div>
            <div className="seg">
              {TAILS.map((t) => (
                <button key={t.k} aria-pressed={tail === t.k} onClick={() => setTail(t.k)} className="num" style={{ fontSize: 11.5 }}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {error && <Banner tone="bad" title="Could not load the view">{error}</Banner>}
        {view && (
          <>
            {a === b && <Banner tone="warn" title="A and B are the same epoch">Pick two different epochs to see change.</Banner>}
            <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
              <EpochImage url={urlA} ready={!!urlA && ready.has(urlA)} n={view.grid.n} pairs={pairs} kind="A" title={`A · ${eA?.label ?? ""}`} tone="var(--ref)" chip="irsa" />
              <EpochImage url={urlB} ready={!!urlB && ready.has(urlB)} n={view.grid.n} pairs={pairs} kind="B" title={`B · ${eB?.label ?? ""}`} tone="var(--sel)" chip="irsa" />
              <EpochImage
                url={phase ? urlA : urlB}
                ready={!!urlA && !!urlB && ready.has(urlA) && ready.has(urlB)}
                n={view.grid.n}
                pairs={pairs}
                kind={phase ? "A" : "B"}
                title={<>Blink · showing <span style={{ color: phase ? "var(--ref)" : "var(--sel)" }}>{phase ? "A" : "B"}</span></>}
                tone="var(--ink)"
                chip="irsa"
              />
              <EpochImage url={diff} ready={!!diff && ready.has(diff)} n={view.grid.n} pairs={pairs} kind="diff" title={<>B − A · <span style={{ color: "#ff6b6b" }}>red brighter</span> / <span style={{ color: "#5aa9ff" }}>blue fainter</span></>} tone="var(--ink)" chip="derived" />
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <Panel title="Epoch metadata">
                <table className="w-full border-collapse" style={{ fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th />
                      <th className="pb-1 text-left" style={{ color: "var(--ref)" }}>
                        A
                      </th>
                      <th className="pb-1 text-left" style={{ color: "var(--sel)" }}>
                        B
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {row("Dates", eA ? `${fmtDate(eA.mjd_start)} → ${fmtDate(eA.mjd_end)}` : "–", eB ? `${fmtDate(eB.mjd_start)} → ${fmtDate(eB.mjd_end)}` : "–")}
                    {row("MJD (mean)", eA?.mjd.toFixed(3), eB?.mjd.toFixed(3))}
                    {row("Exposures", eA?.n_frames, eB?.n_frames)}
                    {row("Detectors", eA?.detectors.join(", "), eB?.detectors.join(", "))}
                    {row("Wavelengths", wl(eA), wl(eB))}
                    {row("Coverage", eA ? `${Math.round(eA.coverage * 100)} %` : "", eB ? `${Math.round(eB.coverage * 100)} %` : "")}
                    {row("Flags at target", eA?.flags_at_target.join(", ") || "none", eB?.flags_at_target.join(", ") || "none")}
                  </tbody>
                </table>
                <p className="num mb-0 mt-2" style={{ fontSize: 13 }}>
                  Time baseline B − A: <b>{dt.toFixed(1)} days</b> ({(dt / 365.25).toFixed(2)} yr)
                </p>
              </Panel>
              <Panel title="Movers A → B" right={<ProvChip kind="derived" />}>
                {a === b ? (
                  <p className="m-0 text-ink2">Pick two different epochs.</p>
                ) : !movers ? (
                  <Spinner label="Finding movers and naming them…" />
                ) : pairs.length === 0 ? (
                  <p className="m-0 text-ink2">No mover above 5σ in this band between these epochs.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse" style={{ fontSize: 12.5 }}>
                      <thead>
                        <tr className="text-left text-ink3">
                          <th className="pb-1 pr-2">Name</th>
                          <th className="pb-1 pr-2">Measured</th>
                          <th className="pb-1 pr-2">Catalogue</th>
                          <th className="pb-1 pr-2">PA</th>
                          <th className="pb-1 pr-2">σ</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {pairs.map((p, i) => {
                          const named = p.identified !== false && !!p.name && !p.name.startsWith("Unidentified");
                          return (
                            <tr key={i} className="border-t border-line">
                              <td className="py-1 pr-2" style={{ color: named ? "var(--ink)" : "var(--warn)", fontWeight: 600 }}>
                                {p.name ?? "Unidentified candidate"}
                                {p.matches_catalogue && <span className="ml-1 text-ok">✓ matches</span>}
                                {!named && <UnidentifiedNote className="font-normal" />}
                              </td>
                              <td className="num py-1 pr-2">{p.shift_arcsec.toFixed(1)}″</td>
                              <td className="num py-1 pr-2">{p.expected_shift_arcsec != null ? `${p.expected_shift_arcsec.toFixed(1)}″` : "–"}</td>
                              <td className="num py-1 pr-2">{p.pa_deg.toFixed(0)}°</td>
                              <td className="num py-1 pr-2">{p.significance.toFixed(1)}</td>
                              <td className="py-1 text-right">
                                <button
                                  className={cx("btn")}
                                  style={{ height: 26, padding: "0 8px", fontSize: 12 }}
                                  onClick={() => {
                                    if (!movers) return;
                                    cands.addFromMover(p, { setId, band, mjdA: movers.a.mjd, mjdB: movers.b.mjd, targetName: state.target?.name });
                                    setAdded(p.name ?? "mover");
                                  }}
                                >
                                  Add to log
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {added && (
                  <p className="mb-0 mt-2 text-ok" style={{ fontSize: 12.5 }}>
                    Added “{added}”. <Link className="link" to="/candidates">Open Discovery Log</Link>
                  </p>
                )}
                <p className="mb-0 mt-2 text-ink3" style={{ fontSize: 12 }}>
                  Red: named (SIMBAD ≤ 8″, Gaia DR3 ≤ 6″, proper motion applied). Orange: unidentified candidate. Candidates, not discoveries.
                </p>
              </Panel>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
