import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Manifest, ViewResponse } from "../api/client";
import { fmtDate } from "../lib/coords";
import { SPEEDS, useView } from "../state/view";
import { ProvChip } from "./ui";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const DETECTOR_UM: Record<number, [number, number]> = { 1: [0.75, 1.09], 2: [1.1, 1.62], 3: [1.63, 2.41], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.0] };
export const bandColor = (d: number) => `var(--band-${d})`;

export function Timeline({ view, manifest }: { view: ViewResponse; manifest: Manifest }) {
  const { view: v, dispatch } = useView();
  const ref = useRef<SVGSVGElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const ep = view.epochs;
  const n = ep.length;
  const lo = Math.min(...ep.map((e) => e.mjd_start)) - 10;
  const hi = Math.max(...ep.map((e) => e.mjd_end)) + 10;
  const pad = 40;
  const x = (m: number) => pad + ((m - lo) / Math.max(1, hi - lo)) * (w - 2 * pad);
  const months = useMemo(() => {
    const out: { m: number; label: string }[] = [];
    const c = new Date((lo - 40587) * 86400000);
    c.setUTCDate(1);
    c.setUTCMonth(c.getUTCMonth() + 1);
    const end = (hi - 40587) * 86400000;
    while (c.getTime() <= end) {
      out.push({ m: c.getTime() / 86400000 + 40587, label: c.getUTCMonth() === 0 ? `Jan ${c.getUTCFullYear()}` : MONTHS[c.getUTCMonth()] });
      c.setUTCMonth(c.getUTCMonth() + 1);
    }
    return out;
  }, [lo, hi]);
  const every = Math.max(1, Math.ceil(months.length / Math.max(1, (w - 2 * pad) / 46)));
  const skip = v.mode === "diff" || v.mode === "side" || v.mode === "swipe" ? v.a : undefined;
  const have = new Set(manifest.frames.map((f) => f.detector));
  const A = ep[v.a];
  const B = ep[v.b];
  const hov = hover !== null ? ep[hover] : null;

  return (
    <div className="border-t border-line bg-s0" role="group" aria-label="Observation timeline">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pt-2">
        <div className="flex items-center gap-1">
          <button className="btn btn-icon" aria-label="Previous epoch (←)" title="Previous (←)" onClick={() => dispatch({ type: "step", delta: -1, n, skip })}>
            <ChevronLeft size={15} />
          </button>
          <button className="btn btn-icon btn-primary" aria-label={v.playing ? "Pause (Space)" : "Play (Space)"} title={v.mode === "blink" ? "Blink A ↔ B (Space)" : "Play through epochs (Space)"} onClick={() => dispatch({ type: "set", patch: { playing: !v.playing } })} disabled={n < 2}>
            {v.playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button className="btn btn-icon" aria-label="Next epoch (→)" title="Next (→)" onClick={() => dispatch({ type: "step", delta: 1, n, skip })}>
            <ChevronRight size={15} />
          </button>
        </div>
        <div className="seg" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button key={s.ms} aria-pressed={v.speedMs === s.ms} onClick={() => dispatch({ type: "set", patch: { speedMs: s.ms } })}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="num flex items-baseline gap-3" style={{ fontSize: 12.5 }}>
          <span>
            <b style={{ color: "var(--ref)" }}>A </b>
            {A ? A.label : "–"}
          </span>
          <span>
            <b style={{ color: "var(--sel)" }}>B </b>
            {B ? B.label : "–"}
          </span>
          {A && B && A !== B && <span className="text-ink3">Δt {Math.abs(B.mjd - A.mjd).toFixed(0)} d</span>}
        </div>
        <div className="ml-auto seg" role="group" aria-label="Detector (band)">
          <button aria-pressed={v.band === "all"} onClick={() => dispatch({ type: "set", patch: { band: "all" } })} title="All detectors, like with like">
            All
          </button>
          {[1, 2, 3, 4, 5, 6].map((d) => (
            <button key={d} aria-pressed={v.band === String(d)} disabled={!have.has(d)} onClick={() => dispatch({ type: "set", patch: { band: String(d) } })} title={`Detector ${d}: ${DETECTOR_UM[d][0]}–${DETECTOR_UM[d][1]} µm`}>
              <span style={{ display: "inline-block", width: 7, height: 7, background: bandColor(d), marginRight: 5 }} />
              {d}
              <span className="ml-1 hidden text-ink3 2xl:inline" style={{ fontSize: 11 }}>
                {DETECTOR_UM[d][0]}–{DETECTOR_UM[d][1]}µm
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="relative pb-1 pt-1">
        <svg ref={ref} width="100%" height="66" role="list" aria-label="Epochs: click = B, shift-click = A" style={{ display: "block" }}>
          <line x1={pad - 16} x2={w - pad + 16} y1={30} y2={30} stroke="var(--line-strong)" />
          {months.map((mo, i) => {
            const px = x(mo.m);
            if (px < 6 || px > w - 6) return null;
            const labelled = i % every === 0 || mo.label.startsWith("Jan");
            return (
              <g key={mo.m}>
                <line x1={px} x2={px} y1={30} y2={labelled ? 37 : 34} stroke="var(--line-strong)" />
                {labelled && (
                  <text x={px + 2} y={47} fontSize="10" fill="var(--ink-3)" fontFamily="Source Code Pro, monospace">
                    {mo.label}
                  </text>
                )}
              </g>
            );
          })}
          {ep.map((e) => {
            const isA = e.index === v.a;
            const isB = e.index === v.b;
            const col = isB ? "var(--sel)" : isA ? "var(--ref)" : "var(--ink-2)";
            const x0 = x(e.mjd_start);
            const x1 = Math.max(x(e.mjd_end), x0 + 3);
            const xm = x(e.mjd);
            return (
              <g
                key={e.index}
                role="listitem"
                tabIndex={0}
                aria-label={`Epoch ${e.label}${isB ? ", B" : ""}${isA ? ", A (reference)" : ""}`}
                style={{ cursor: e.has_data ? "pointer" : "not-allowed", opacity: e.has_data ? 1 : 0.35 }}
                onClick={(ev) => e.has_data && dispatch({ type: "set", patch: ev.shiftKey ? { a: e.index } : { b: e.index } })}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  dispatch({ type: "set", patch: { a: e.index } });
                }}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") dispatch({ type: "set", patch: { b: e.index } });
                  if (ev.key.toLowerCase() === "a") dispatch({ type: "set", patch: { a: e.index } });
                }}
                onPointerEnter={() => setHover(e.index)}
                onPointerLeave={() => setHover(null)}
              >
                <rect x={x0 - 8} y={2} width={x1 - x0 + 16} height={60} fill="transparent" />
                <rect x={x0} y={25} width={x1 - x0} height={10} rx={3} fill={col} fillOpacity={isA || isB ? 0.35 : 0.18} stroke={col} strokeWidth={isA || isB ? 1.6 : 1} />
                <circle cx={xm} cy={30} r={isB ? 6 : isA ? 5.5 : 4} fill={isB || isA ? col : "var(--surface-0)"} stroke={col} strokeWidth={1.6} />
                {(isA || isB) && (
                  <text x={xm} y={14} textAnchor="middle" fontSize="11" fontWeight="700" fill={col}>
                    {isA && isB ? "A=B" : isB ? "B" : "A"}
                  </text>
                )}
                <text x={xm} y={60} textAnchor="middle" fontSize="10.5" fill={isB ? "var(--sel)" : isA ? "var(--ref)" : "var(--ink-2)"} fontFamily="Source Code Pro, monospace">
                  {e.label}
                </text>
              </g>
            );
          })}
        </svg>
        {hov && (
          <div className="panel pointer-events-none absolute z-20 px-2.5 py-1.5" style={{ left: Math.min(Math.max(x(hov.mjd) - 105, 6), w - 220), bottom: 70, width: 214, background: "var(--surface-1)" }}>
            <div className="num" style={{ fontSize: 12 }}>
              {fmtDate(hov.mjd_start)} → {fmtDate(hov.mjd_end)}
            </div>
            <div className="text-ink2" style={{ fontSize: 11.5 }}>
              {hov.n_frames} exposure{hov.n_frames === 1 ? "" : "s"} · detectors {hov.detectors.join(", ")}
            </div>
            <div className="num text-ink2" style={{ fontSize: 11.5 }}>
              {hov.wavelength_um ? `${hov.wavelength_um[0].toFixed(2)}–${hov.wavelength_um[1].toFixed(2)} µm` : "no wavelength"}
            </div>
            <div className="mt-0.5 text-ink3" style={{ fontSize: 11 }}>
              click: B · shift-click / right-click: A
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-1 text-ink3" style={{ fontSize: 11.5 }}>
        <span className="num">
          {n} epoch{n === 1 ? "" : "s"} (survey passes) · {manifest.counts.kept} exposures used of {manifest.counts.search_results} found<span className="hidden md:inline"> · Space play · ←/→ step · 1–5 modes · A reference · 0 fit</span>
        </span>
        <ProvChip kind="irsa" />
      </div>
    </div>
  );
}
