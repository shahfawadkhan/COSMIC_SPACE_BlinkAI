import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Manifest, MoverPair, MoversResponse, OverlayResponse, ViewResponse } from "../api/client";
import { decLabel, formatDec, formatRA, gridWcs, mjdToDate, pixToWorld, propagate, raLabel, worldToPix, type GridWcs } from "../lib/coords";
import { useView } from "../state/view";
import type { Target } from "../state/workspace";
import { ProvChip, cx } from "./ui";

export interface StageProps {
  view: ViewResponse;
  manifest: Manifest;
  target: Target | null;
  upscale: number;
  epochUrls: (string | null)[];
  diffUrl: string | null;
  ready: Set<string>;
  movers: MoversResponse | null;
  gaia: OverlayResponse | null;
  simbad: OverlayResponse | null;
  shownIndex: number; // epoch shown in single/blink
  onMoverClick?: (index: number) => void; // add that mover to the Discovery Log
  onMeasure?: (ra: number, dec: number, epochIndex: number) => void; // Measure tool
}

// ------------------------------------------------------------ coordinate grid
const NICE_ARCSEC = [5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800];
const NICE_TIME_S = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

function useGrid(w: GridWcs, n: number, U: number) {
  return useMemo(() => {
    const disp = (x: number, y: number): [number, number] => [(x + 0.5) * U, (n - 1 - y + 0.5) * U];
    const corners = [pixToWorld(w, -0.5, -0.5), pixToWorld(w, n - 0.5, -0.5), pixToWorld(w, -0.5, n - 0.5), pixToWorld(w, n - 0.5, n - 0.5)];
    const fovArcsec = n * Math.abs(w.cdelt2) * 3600;
    const decStep = NICE_ARCSEC.find((s) => fovArcsec / s <= 6) ?? 1800;
    const cosd = Math.max(0.05, Math.cos((w.crval2 * Math.PI) / 180));
    const raStepS = NICE_TIME_S.find((s) => fovArcsec / (s * 15 * cosd) <= 6) ?? 300;
    const unwrap = (r: number) => (r - w.crval1 > 180 ? r - 360 : r - w.crval1 < -180 ? r + 360 : r);
    const ras = corners.map((c) => unwrap(c[0]));
    const decs = corners.map((c) => c[1]);
    const [raMin, raMax, decMin, decMax] = [Math.min(...ras), Math.max(...ras), Math.min(...decs), Math.max(...decs)];
    const lines: { d: string; label: string; lx: number; ly: number }[] = [];
    const samples = 24;
    for (let k = Math.ceil((decMin * 3600) / decStep); k * decStep <= decMax * 3600; k++) {
      const dec = (k * decStep) / 3600;
      const pts: [number, number][] = [];
      for (let i = 0; i <= samples; i++) pts.push(disp(...worldToPix(w, raMin + ((raMax - raMin) * i) / samples, dec)));
      const left = pts.reduce((a, b) => (a[0] < b[0] ? a : b));
      lines.push({ d: "M" + pts.map((p) => p.join(",")).join("L"), label: formatDec(dec, 0).replace(/ /g, ""), lx: 3, ly: left[1] - 3 });
    }
    const raStepDeg = (raStepS * 15) / 3600;
    for (let k = Math.ceil(raMin / raStepDeg); k * raStepDeg <= raMax; k++) {
      const ra = k * raStepDeg;
      const pts: [number, number][] = [];
      for (let i = 0; i <= samples; i++) pts.push(disp(...worldToPix(w, ra, decMin + ((decMax - decMin) * i) / samples)));
      const bottom = pts.reduce((a, b) => (a[1] > b[1] ? a : b));
      lines.push({ d: "M" + pts.map((p) => p.join(",")).join("L"), label: formatRA(((ra % 360) + 360) % 360, raStepS < 1 ? 1 : 0).replace(/ /g, ""), lx: bottom[0] + 3, ly: n * U - 4 });
    }
    return lines;
  }, [w, n, U]);
}

export interface Hover {
  title: string;
  lines: string[];
  color: string;
}

function jyearFromMjd(mjd: number) {
  return 2000 + (mjd - 51544.5) / 365.25;
}

interface OverlayProps {
  manifest: Manifest;
  view: ViewResponse;
  target: Target | null;
  U: number;
  zoom: number;
  movers: MoversResponse | null;
  gaia: OverlayResponse | null;
  simbad: OverlayResponse | null;
  epochIndex: number;
  onHover: (h: Hover | null) => void;
}

function Overlay({ manifest, view, target, U, zoom, movers, gaia, simbad, epochIndex, onHover }: OverlayProps) {
  const { view: vs } = useView();
  const n = view.grid.n;
  const w = useMemo(() => gridWcs(manifest.grid.wcs), [manifest]);
  const grid = useGrid(w, n, U);
  const size = n * U;
  const disp = (x: number, y: number): [number, number] => [(x + 0.5) * U, (n - 1 - y + 0.5) * U];
  const fs = 11 / zoom; // constant on-screen text size
  const ringR = Math.max(9 / view.grid.pix_arcsec, 2.5) * U;
  const c = disp((n - 1) / 2, (n - 1) / 2);
  const epoch = view.epochs[epochIndex];
  const hit = { pointerEvents: "visiblePainted" as const, cursor: "help" };

  // catalogue proper-motion prediction: where the target should be on the shown date
  let predicted: [number, number] | null = null;
  if (vs.overlays.predict && target && epoch && target.catRa !== undefined && target.catDec !== undefined && target.epoch && (target.pmra || target.pmdec)) {
    const [pra, pdec] = propagate(target.catRa, target.catDec, target.pmra ?? 0, target.pmdec ?? 0, target.epoch, jyearFromMjd(epoch.mjd));
    predicted = disp(...worldToPix(w, pra, pdec));
  }

  const markers = (res: OverlayResponse | null, kind: "gaia" | "simbad") => {
    if (!res) return null;
    const col = kind === "gaia" ? "var(--gaia)" : "var(--simbad)";
    const k = res.epochs.indexOf(epochIndex);
    const s = (kind === "gaia" ? 2.2 : 3.2) * U;
    return res.sources.map((src) => {
      const p = src.pix[k >= 0 ? k : 0];
      if (!p) return null;
      const [x, y] = disp(p[0], p[1]);
      if (x < -s || y < -s || x > size + s || y > size + s) return null;
      const info: Hover = {
        title: src.id,
        color: kind === "gaia" ? "#f0b030" : "#9fe870",
        lines: [
          kind === "gaia" ? `Gaia DR3${src.mag != null ? ` · G = ${src.mag.toFixed(1)}` : ""}` : `SIMBAD${src.otype ? ` · ${src.otype}` : ""}`,
          src.pmra != null || src.pmdec != null ? `μ = ${(Math.hypot(src.pmra ?? 0, src.pmdec ?? 0) / 1000).toFixed(3)}″/yr` : "no proper motion",
          `position on ${epoch ? mjdToDate(epoch.mjd).toISOString().slice(0, 10) : "this date"}`,
        ],
      };
      return (
        <g key={`${kind}-${src.id}`} style={hit} onPointerEnter={() => onHover(info)} onPointerLeave={() => onHover(null)}>
          <circle cx={x} cy={y} r={s * 1.6} fill="transparent" />
          {kind === "gaia" ? (
            <circle cx={x} cy={y} r={s} fill="none" stroke={col} strokeWidth={1.3} vectorEffect="non-scaling-stroke" />
          ) : (
            <path d={`M${x - s},${y}H${x + s}M${x},${y - s}V${y + s}`} stroke={col} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
          )}
        </g>
      );
    });
  };

  const moverLabel = (p: MoverPair) => p.name ?? "Unidentified candidate";
  // the target found as a named mover: its red label already says who it is
  const norm = (s?: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const targetIsNamedMover = vs.overlays.movers && !!movers?.pairs.some((p) => p.identified && norm(p.name) === norm(target?.name));

  return (
    <svg className="absolute inset-0 overflow-visible" style={{ pointerEvents: "none" }} width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <defs>
        <marker id="arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#ff3b3b" />
        </marker>
        <marker id="arrow-orange" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#ff9f1a" />
        </marker>
      </defs>
      {vs.overlays.grid &&
        grid.map((l, i) => (
          <g key={i}>
            <path d={l.d} fill="none" stroke="#7dd3fc" strokeOpacity={0.3} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <text x={l.lx} y={l.ly} fontSize={fs} fill="#bae6fd" fillOpacity={0.85} style={{ paintOrder: "stroke" }} stroke="#000" strokeWidth={3 / zoom} fontFamily="Source Code Pro, monospace">
              {l.label}
            </text>
          </g>
        ))}
      {vs.overlays.field && (
        <g stroke="#4aa8e8" fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke">
          <rect x={U * 0.5} y={U * 0.5} width={size - U} height={size - U} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
          <text x={U} y={U + fs * 1.2} fontSize={fs} fill="#4aa8e8" stroke="none">
            {view.grid.fov_arcmin}′ field
          </text>
        </g>
      )}
      {markers(simbad, "simbad")}
      {markers(gaia, "gaia")}
      {vs.overlays.crosshair && (
        <g stroke="#4ade80" strokeWidth={1.5} fill="none">
          {[0, 90, 180, 270].map((a) => {
            const r1 = ringR * 1.15;
            const r2 = ringR * 1.9;
            const rad = (a * Math.PI) / 180;
            return <line key={a} x1={c[0] + r1 * Math.cos(rad)} y1={c[1] + r1 * Math.sin(rad)} x2={c[0] + r2 * Math.cos(rad)} y2={c[1] + r2 * Math.sin(rad)} vectorEffect="non-scaling-stroke" />;
          })}
          {target?.name && !targetIsNamedMover && (
            <text x={c[0] + ringR * 2.1} y={c[1] - ringR * 1.2} fontSize={fs * 1.05} fill="#4ade80" stroke="#000" strokeWidth={3 / zoom} style={{ paintOrder: "stroke" }} fontWeight={600}>
              {target.name}
            </text>
          )}
        </g>
      )}
      {predicted && (
        <g
          style={hit}
          onPointerEnter={() => onHover({ title: "Catalogue prediction", color: "#2dd4bf", lines: [`Where ${target?.name ?? "the target"} should be on ${epoch ? mjdToDate(epoch.mjd).toISOString().slice(0, 10) : "this date"}`, "from its catalogue proper motion"] })}
          onPointerLeave={() => onHover(null)}
        >
          <circle cx={predicted[0]} cy={predicted[1]} r={ringR * 0.8} fill="transparent" />
          <circle cx={predicted[0]} cy={predicted[1]} r={ringR * 0.8} fill="none" stroke="var(--predict)" strokeWidth={1.8} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        </g>
      )}
      {vs.overlays.movers &&
        movers?.pairs.map((p, i) => {
          const named = p.identified !== false && !!p.name && !p.name.startsWith("Unidentified");
          const col = named ? "#ff3b3b" : "#ff9f1a";
          const [x1, y1] = disp(p.from.x, p.from.y);
          const [x2, y2] = disp(p.to.x, p.to.y);
          const dx = x2 - x1;
          const dy = y2 - y1;
          const L = Math.hypot(dx, dy) || 1;
          const gap = L > 2.4 * ringR ? ringR : 0;
          const info: Hover = {
            title: moverLabel(p),
            color: col,
            lines: [
              `measured ${p.shift_arcsec.toFixed(1)}″${p.expected_shift_arcsec != null ? `, catalogue ${p.expected_shift_arcsec.toFixed(1)}″` : ""} · PA ${p.pa_deg.toFixed(0)}°`,
              p.matches_catalogue ? "✓ matches catalogue motion" : named ? "differs from catalogue motion" : "no SIMBAD/Gaia match. Unidentified candidate – needs further scientific investigation. Not a claim of Planet X.",
              `${p.significance.toFixed(1)}σ · dashed = A, solid = B`,
              "click the ring: add to Discovery Log",
            ],
          };
          return (
            <g key={i} data-mover={i} style={{ ...hit, cursor: "pointer" }} onPointerEnter={() => onHover(info)} onPointerLeave={() => onHover(null)}>
              <circle cx={x2} cy={y2} r={ringR * 1.3} fill="transparent" />
              <g fill="none" stroke={col} strokeWidth={1.8}>
                <circle cx={x1} cy={y1} r={ringR} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
                <circle cx={x2} cy={y2} r={ringR} vectorEffect="non-scaling-stroke" />
                <line x1={x1 + (dx / L) * gap} y1={y1 + (dy / L) * gap} x2={x2 - (dx / L) * gap} y2={y2 - (dy / L) * gap} markerEnd={`url(#arrow-${named ? "red" : "orange"})`} vectorEffect="non-scaling-stroke" />
              </g>
              <text x={Math.max(x1, x2) + ringR * 1.15} y={Math.min(y1, y2) - ringR * 0.2} fontSize={fs} fill={col} stroke="#000" strokeWidth={3 / zoom} style={{ paintOrder: "stroke" }} fontWeight={600}>
                {moverLabel(p)}
                {p.matches_catalogue ? " ✓" : ""}
              </text>
            </g>
          );
        })}
    </svg>
  );
}

// ------------------------------------------------------------ pan/zoom
interface Xform {
  tx: number;
  ty: number;
}

function Pane({ size, xf, zoom, children }: { size: number; xf: Xform; zoom: number; children: ReactNode }) {
  return (
    <div className="absolute inset-0 overflow-hidden">
      <div className="absolute left-0 top-0 origin-top-left" style={{ width: size, height: size, transform: `translate(${xf.tx}px, ${xf.ty}px) scale(${zoom})` }}>
        {children}
      </div>
    </div>
  );
}

function Layers({ urls, shown, ready }: { urls: (string | null)[]; shown: number; ready: Set<string> }) {
  return (
    <>
      {urls.map((u, i) =>
        u && ready.has(u) ? <img key={u} src={u} alt="" draggable={false} className="pixelated absolute inset-0 h-full w-full select-none" style={{ opacity: i === shown ? 1 : 0 }} /> : null,
      )}
    </>
  );
}

function Tag({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <span className="num rounded px-1.5 py-0.5" style={{ background: "rgba(5,7,11,.78)", color: color ?? "#e8eef5", fontSize: 11.5, border: "1px solid rgba(255,255,255,.12)" }}>
      {children}
    </span>
  );
}

export function Stage({ view, manifest, target, upscale: U, epochUrls, diffUrl, ready, movers, gaia, simbad, shownIndex, onMoverClick, onMeasure }: StageProps) {
  const { view: vs, dispatch } = useView();
  const rootRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [xf, setXf] = useState<Xform>({ tx: 0, ty: 0 });
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [hover, setHover] = useState<(Hover & { x: number; y: number }) | null>(null);
  const prevZoom = useRef(vs.zoom);
  const anchor = useRef<[number, number] | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const swipeDrag = useRef(false);
  const downAt = useRef<[number, number] | null>(null);
  const mouse = useRef<[number, number]>([0, 0]);
  const n = view.grid.n;
  const size = n * U;
  const side = vs.mode === "side";
  const paneW = side ? box.w / 2 : box.w;
  const w = useMemo(() => gridWcs(manifest.grid.wcs), [manifest]);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (!paneW || !box.h) return;
    const z = Math.max(0.25, Math.min(16, (Math.min(paneW, box.h) / size) * 0.94));
    prevZoom.current = z;
    setXf({ tx: (paneW - size * z) / 2, ty: (box.h - size * z) / 2 });
    dispatch({ type: "set", patch: { zoom: z } });
  }, [paneW, box.h, size, dispatch]);
  const fitKey = `${vs.fitToken}|${manifest.set_id}|${side}|${box.w > 0}`;
  useEffect(() => {
    fit();
  }, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const z0 = prevZoom.current;
    const z1 = vs.zoom;
    if (z0 === z1) return;
    const [ax, ay] = anchor.current ?? [paneW / 2, box.h / 2];
    setXf((p) => ({ tx: ax - ((ax - p.tx) * z1) / z0, ty: ay - ((ay - p.ty) * z1) / z0 }));
    prevZoom.current = z1;
    anchor.current = null;
  }, [vs.zoom, paneW, box.h]);

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = rootRef.current!.getBoundingClientRect();
    let x = e.clientX - r.left;
    if (side && x > paneW) x -= paneW;
    return [x, e.clientY - r.top];
  };

  const onWheel = (e: React.WheelEvent) => {
    anchor.current = local(e);
    dispatch({ type: "zoom", factor: e.deltaY < 0 ? 1.2 : 1 / 1.2 });
  };
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const ring = (e.target as Element).closest?.("[data-mover]");
    if (ring && onMoverClick) {
      onMoverClick(Number(ring.getAttribute("data-mover")));
      return;
    }
    downAt.current = [e.clientX, e.clientY];
    rootRef.current?.setPointerCapture(e.pointerId);
    if (vs.mode === "swipe" && Math.abs(local(e)[0] - vs.swipe * box.w) < 14) {
      swipeDrag.current = true;
      return;
    }
    drag.current = { x: e.clientX, y: e.clientY, tx: xf.tx, ty: xf.ty };
  };
  const onMove = (e: React.PointerEvent) => {
    const r = rootRef.current!.getBoundingClientRect();
    mouse.current = [e.clientX - r.left, e.clientY - r.top];
    if (swipeDrag.current) {
      dispatch({ type: "set", patch: { swipe: Math.min(1, Math.max(0, local(e)[0] / box.w)) } });
      return;
    }
    if (drag.current) {
      const d = drag.current;
      setXf({ tx: d.tx + e.clientX - d.x, ty: d.ty + e.clientY - d.y });
    }
    const [mx, my] = local(e);
    const X = (mx - xf.tx) / vs.zoom;
    const Y = (my - xf.ty) / vs.zoom;
    if (X < 0 || Y < 0 || X > size || Y > size) return setCursor(null);
    setCursor(pixToWorld(w, X / U - 0.5, n - 1 - (Y / U - 0.5)));
  };
  const onUp = (e: React.PointerEvent) => {
    const d0 = downAt.current;
    downAt.current = null;
    if (vs.tool === "measure" && onMeasure && d0 && Math.hypot(e.clientX - d0[0], e.clientY - d0[1]) < 4) {
      const [mx, my] = local(e);
      const X = (mx - xf.tx) / vs.zoom;
      const Y = (my - xf.ty) / vs.zoom;
      if (X >= 0 && Y >= 0 && X <= size && Y <= size) {
        const [ra, dec] = pixToWorld(w, X / U - 0.5, n - 1 - (Y / U - 0.5));
        const r = rootRef.current!.getBoundingClientRect();
        const rx = e.clientX - r.left;
        const epoch = side ? (rx > paneW ? vs.b : vs.a) : vs.mode === "swipe" ? (rx / box.w > vs.swipe ? vs.b : vs.a) : vs.mode === "diff" ? vs.b : shownIndex;
        onMeasure(ra, dec, epoch);
      }
    }
    drag.current = null;
    swipeDrag.current = false;
    rootRef.current?.releasePointerCapture?.(e.pointerId);
  };
  const onMarkerHover = useCallback((h: Hover | null) => setHover(h ? { ...h, x: mouse.current[0], y: mouse.current[1] } : null), []);

  const a = vs.a;
  const b = vs.b;
  const overlayFor = (idx: number) => <Overlay manifest={manifest} view={view} target={target} U={U} zoom={vs.zoom} movers={movers} gaia={gaia} simbad={simbad} epochIndex={idx} onHover={onMarkerHover} />;
  const loading = epochUrls.filter((u) => u && !ready.has(u)).length;
  const label = (i: number) => view.epochs[i]?.label ?? "";

  return (
    <div
      id="stage-root"
      ref={rootRef}
      className={cx("sky-stage checker relative h-full w-full overflow-hidden", vs.tool === "measure" ? "cursor-crosshair" : drag.current ? "cursor-grabbing" : "cursor-grab")}
      onWheel={onWheel}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => {
        setCursor(null);
        setHover(null);
      }}
      onDoubleClick={() => dispatch({ type: "fit" })}
    >
      {(vs.mode === "single" || vs.mode === "blink") && (
        <Pane size={size} xf={xf} zoom={vs.zoom}>
          <Layers urls={epochUrls} shown={shownIndex} ready={ready} />
          {overlayFor(shownIndex)}
        </Pane>
      )}
      {vs.mode === "diff" && (
        <Pane size={size} xf={xf} zoom={vs.zoom}>
          {diffUrl && ready.has(diffUrl) && <img src={diffUrl} alt="" draggable={false} className="pixelated absolute inset-0 h-full w-full select-none" />}
          {overlayFor(b)}
        </Pane>
      )}
      {vs.mode === "swipe" && (
        <>
          <Pane size={size} xf={xf} zoom={vs.zoom}>
            <Layers urls={epochUrls} shown={a} ready={ready} />
          </Pane>
          <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${vs.swipe * 100}%)` }}>
            <Pane size={size} xf={xf} zoom={vs.zoom}>
              <Layers urls={epochUrls} shown={b} ready={ready} />
              {overlayFor(b)}
            </Pane>
          </div>
          <div className="pointer-events-none absolute inset-y-0 w-0.5" style={{ left: `${vs.swipe * 100}%`, background: "var(--sky)" }}>
            <div className="absolute top-1/2 -ml-2.5 h-9 w-5 -translate-y-1/2 rounded" style={{ background: "var(--sky)" }} />
          </div>
          <div className="pointer-events-none absolute left-2 top-10">
            <Tag color="#f0a84a">A · {label(a)}</Tag>
          </div>
          <div className="pointer-events-none absolute right-2 top-10">
            <Tag color="#6fd0c5">B · {label(b)}</Tag>
          </div>
        </>
      )}
      {side && (
        <>
          <div className="absolute inset-y-0 left-0 w-1/2" style={{ borderRight: "1px solid #2a3a4f" }}>
            <Pane size={size} xf={xf} zoom={vs.zoom}>
              <Layers urls={epochUrls} shown={a} ready={ready} />
              {overlayFor(a)}
            </Pane>
            <div className="pointer-events-none absolute left-2 top-10">
              <Tag color="#f0a84a">A · {label(a)}</Tag>
            </div>
          </div>
          <div className="absolute inset-y-0 right-0 w-1/2">
            <Pane size={size} xf={xf} zoom={vs.zoom}>
              <Layers urls={epochUrls} shown={b} ready={ready} />
              {overlayFor(b)}
            </Pane>
            <div className="pointer-events-none absolute left-2 top-10">
              <Tag color="#6fd0c5">B · {label(b)}</Tag>
            </div>
          </div>
        </>
      )}

      <div className="pointer-events-none absolute left-2 top-2 flex flex-wrap items-center gap-2">
        <ProvChip kind={manifest.set_id.startsWith("sim") ? "simulated" : vs.mode === "diff" ? "derived" : "irsa"} force />
        {(vs.mode === "single" || vs.mode === "blink") && <Tag color={shownIndex === a && a !== b ? "#f0a84a" : "#6fd0c5"}>{(shownIndex === a && a !== b ? "A · " : "B · ") + label(shownIndex)}</Tag>}
        {vs.mode === "diff" && (
          <Tag>
            B − A: {label(b)} − {label(a)} · <span style={{ color: "#ff8a8f" }}>red brighter now</span> / <span style={{ color: "#7cc4ff" }}>blue fainter</span>
          </Tag>
        )}
        {(gaia || simbad) && <ProvChip kind="catalogue" force />}
      </div>
      <div className="pointer-events-none absolute bottom-2 right-2">
        <Tag>N ↑ E ←</Tag>
      </div>
      <div className="pointer-events-none absolute bottom-2 left-2 flex flex-col items-start gap-1">
        {loading > 0 && <Tag>Loading images {epochUrls.length - loading} of {epochUrls.length}…</Tag>}
        {cursor && (
          <Tag>
            {raLabel(cursor[0])} · {decLabel(cursor[1])}
          </Tag>
        )}
      </div>
      {hover && (
        <div className="pointer-events-none absolute z-30 rounded px-2.5 py-1.5" style={{ left: Math.min(hover.x + 14, box.w - 260), top: Math.max(4, hover.y - 10), width: 250, background: "rgba(5,7,11,.92)", border: `1px solid ${hover.color}`, color: "#e8eef5" }}>
          <div style={{ fontWeight: 700, color: hover.color, fontSize: 13 }}>{hover.title}</div>
          {hover.lines.map((l, i) => (
            <div key={i} style={{ fontSize: 11.5, color: "#c4d0dd" }}>
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
