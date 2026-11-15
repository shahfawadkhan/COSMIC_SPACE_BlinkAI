import { Crosshair, Layers3, Map as MapIcon, Maximize2, Minimize2, Minus, Plus, SlidersHorizontal, Target as TargetIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MODES, TAILS, useView, type ViewState } from "../state/view";

const SWATCH: Record<string, string> = {
  gray: "linear-gradient(90deg,#000,#fff)",
  inferno: "linear-gradient(90deg,#000004,#781c6d,#ed6925,#fcffa4)",
  viridis: "linear-gradient(90deg,#440154,#3b528b,#21918c,#5ec962,#fde725)",
  magma: "linear-gradient(90deg,#000004,#b73779,#fcfdbf)",
  RdBu_r: "linear-gradient(90deg,#2166ac,#f7f7f7,#b2182b)",
  coolwarm: "linear-gradient(90deg,#3b4cc0,#dddddd,#b40426)",
};
const CMAPS: [string, string][] = [
  ["gray", "Grayscale"],
  ["inferno", "Inferno"],
  ["viridis", "Viridis"],
  ["magma", "Magma"],
];
const DIFF_CMAPS: [string, string][] = [
  ["RdBu_r", "Red–blue"],
  ["coolwarm", "Cool–warm"],
  ["gray", "Grayscale"],
];
const LEVELS = [
  { pmin: 1, pmax: 99.5, label: "Normal (1–99.5 %)" },
  { pmin: 0.5, pmax: 99.9, label: "Wide (0.5–99.9 %)" },
  { pmin: 5, pmax: 99, label: "Faint things (5–99 %)" },
  { pmin: 10, pmax: 97, label: "Very faint (10–97 %)" },
];
const OVERLAYS: [keyof ViewState["overlays"], string, string][] = [
  ["movers", "Mover rings (named)", "var(--mover)"],
  ["gaia", "Gaia DR3 stars", "var(--gaia)"],
  ["simbad", "SIMBAD objects", "var(--simbad)"],
  ["grid", "Coordinate grid", "#7dd3fc"],
  ["predict", "Catalogue proper-motion prediction", "var(--predict)"],
  ["field", "Field boundary", "#4aa8e8"],
  ["crosshair", "Target marker + name", "#4ade80"],
];

function Pop({ icon, label, children, active }: { icon: ReactNode; label: string; children: ReactNode; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", h);
    window.addEventListener("keydown", k);
    return () => {
      window.removeEventListener("pointerdown", h);
      window.removeEventListener("keydown", k);
    };
  }, [open]);
  // fixed position: the toolbar scrolls sideways on phones and would clip an absolute popover
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 268)), top: r.bottom + 4 });
    setOpen((o) => !o);
  };
  return (
    <div ref={ref} className="relative shrink-0">
      <button className="btn" aria-pressed={open || active} aria-expanded={open} aria-haspopup="true" onClick={toggle}>
        {icon}
        <span>{label}</span>
      </button>
      {open && pos && (
        <div className="panel fixed z-[70] max-h-[70vh] w-[260px] overflow-y-auto p-3" style={{ background: "var(--surface-1)", left: pos.left, top: pos.top }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function Toolbar({ mapOpen, onMap, overlayStatus, leading }: { mapOpen: boolean; onMap: () => void; overlayStatus: Partial<Record<keyof ViewState["overlays"], string>>; leading?: ReactNode }) {
  const { view: v, dispatch } = useView();
  const set = (patch: Partial<ViewState>) => dispatch({ type: "set", patch });
  const diff = v.mode === "diff";
  const cm = diff ? DIFF_CMAPS : CMAPS;
  const cur = diff ? v.diffCmap : v.cmap;
  const [fs, setFs] = useState(false);
  useEffect(() => {
    const h = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);

  return (
    <div role="toolbar" aria-label="Image controls" className="no-scrollbar flex items-center gap-x-2.5 gap-y-1.5 overflow-x-auto border-b border-line bg-s0 px-3 py-1.5 lg:flex-wrap lg:overflow-visible [&>*]:shrink-0">
      {leading}
      <div className="seg" role="group" aria-label="Comparison mode">
        {MODES.map((m) => (
          <button key={m.id} aria-pressed={v.mode === m.id} title={`${m.label} (key ${m.key})`} onClick={() => set({ mode: m.id })}>
            {m.label}
          </button>
        ))}
      </div>
      {!diff && (
        <div className="seg" role="group" aria-label="Stretch">
          {(["linear", "sqrt", "asinh", "log"] as const).map((s) => (
            <button key={s} aria-pressed={v.stretch === s} onClick={() => set({ stretch: s })} title={`${s} stretch`} className="num" style={{ textTransform: "uppercase", fontSize: 11 }}>
              {s === "linear" ? "lin" : s}
            </button>
          ))}
        </div>
      )}
      <div className="seg" role="group" aria-label="Colour map">
        {cm.map(([id, label]) => (
          <button key={id} aria-pressed={cur === id} title={label} aria-label={label} onClick={() => set(diff ? { diffCmap: id } : { cmap: id })} style={{ padding: "0 6px" }}>
            <span style={{ display: "block", width: 30, height: 10, background: SWATCH[id], border: "1px solid var(--line-strong)" }} />
          </button>
        ))}
      </div>
      {diff && (
        <div className="seg" role="group" aria-label="Show only change above" title="Only changes beyond ±kσ of the difference noise are coloured">
          {TAILS.map((t) => (
            <button key={t.k} aria-pressed={v.tail === t.k} onClick={() => set({ tail: t.k })} className="num" style={{ fontSize: 11.5 }}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      <Pop icon={<SlidersHorizontal size={14} />} label="Levels" active={v.pmin !== 1 || v.pmax !== 99.5}>
        <div className="cap mb-1">Clip interval (percentile)</div>
        {LEVELS.map((l) => (
          <button key={l.label} className="btn mb-1 w-full justify-start" aria-pressed={v.pmin === l.pmin && v.pmax === l.pmax} onClick={() => set({ pmin: l.pmin, pmax: l.pmax })}>
            {l.label}
          </button>
        ))}
        <p className="mb-0 mt-1 text-ink3" style={{ fontSize: 11.5 }}>
          Every epoch uses the same brightness scale, so blinking compares like with like.
        </p>
      </Pop>
      <Pop icon={<Layers3 size={14} />} label="Overlays">
        {OVERLAYS.map(([k, label, col]) => (
          <label key={k} className="flex cursor-pointer items-center gap-2 py-1">
            <input type="checkbox" checked={v.overlays[k]} onChange={() => dispatch({ type: "overlay", key: k })} />
            <span style={{ width: 10, height: 10, background: col, borderRadius: 2, flex: "none" }} />
            <span className="flex-1">{label}</span>
            {overlayStatus[k] && (
              <span className="text-ink3" style={{ fontSize: 11 }}>
                {overlayStatus[k]}
              </span>
            )}
          </label>
        ))}
        <p className="mb-0 mt-2 text-ink3" style={{ fontSize: 11.5 }}>
          Red ring = named from SIMBAD / Gaia, orange = unidentified. Teal dashed circle = where the catalogue says the target should be on the shown date. Hover a marker for its name.
        </p>
      </Pop>
      <button className="btn" aria-pressed={v.tool === "measure"} onClick={() => set({ tool: v.tool === "measure" ? "pan" : "measure" })} title="Measure: click an object to record its position on the shown date (Discovery Log)">
        <Crosshair size={14} />
        Measure
      </button>
      <div className="flex items-center gap-1.5 lg:ml-auto">
        <button className="btn" aria-pressed={mapOpen} onClick={onMap} title="Where this field is on the sky (Aladin)">
          <MapIcon size={14} />
          Sky map
        </button>
        <button className="btn btn-icon" aria-label="Zoom out (−)" title="Zoom out (−)" onClick={() => dispatch({ type: "zoom", factor: 1 / 1.25 })}>
          <Minus size={14} />
        </button>
        <button className="btn num" style={{ minWidth: 62 }} onClick={() => dispatch({ type: "fit" })} title="Fit to window (0)">
          {Math.round(v.zoom * 100)}%
        </button>
        <button className="btn btn-icon" aria-label="Zoom in (+)" title="Zoom in (+)" onClick={() => dispatch({ type: "zoom", factor: 1.25 })}>
          <Plus size={14} />
        </button>
        <button className="btn btn-icon" aria-label="Fit to window (0)" title="Fit (0)" onClick={() => dispatch({ type: "fit" })}>
          <TargetIcon size={14} />
        </button>
        <button
          className="btn btn-icon"
          aria-label={fs ? "Exit fullscreen" : "Fullscreen"}
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void document.getElementById("explorer-root")?.requestFullscreen?.();
          }}
        >
          {fs ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </div>
    </div>
  );
}
