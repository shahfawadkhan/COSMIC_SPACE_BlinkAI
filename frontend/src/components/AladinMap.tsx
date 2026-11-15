import A from "aladin-lite";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../api/client";

/** Survey tiles are loaded BY URL from IRSA's mirror of the CDS HiPS: resolving a CDS id needs the
 * CDS registry, which is sometimes down (the map then stays grey). */
export const SURVEYS = [
  { id: "dss2", label: "Optical (DSS2)", short: "Optical", url: "https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color" },
  { id: "allwise", label: "Infrared (AllWISE)", short: "Infrared", url: "https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1" },
  { id: "2mass", label: "Near-IR (2MASS)", short: "Near-IR", url: "https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color" },
] as const;
export type SurveyId = (typeof SURVEYS)[number]["id"];

export interface MapMover {
  ra: number;
  dec: number;
  name?: string;
  identified?: boolean;
}

export interface AladinMapProps {
  ra: number;
  dec: number;
  viewDeg?: number; // map size
  fieldArcmin?: number; // SPHEREx field drawn as a box
  survey?: SurveyId;
  showSimbad?: boolean;
  showGaia?: boolean;
  movers?: MapMover[];
  onPick?: (ra: number, dec: number) => void;
  onCentre?: (ra: number, dec: number) => void;
  className?: string;
  style?: CSSProperties;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Al = any;
let initPromise: Promise<void> | null = null;
const ready = () => (initPromise ??= A.init as Promise<void>);
const hipsUrl = (id?: string) => (SURVEYS.find((s) => s.id === id) ?? SURVEYS[0]).url;

/**
 * Aladin Lite v3 (CDS Strasbourg). Background tiles are real survey images (DSS2 / AllWISE / 2MASS)
 * streamed from IRSA. SIMBAD and Gaia markers come from OUR backend (/api/cone), which falls back
 * across mirrors, so the map keeps working when CDS is down.
 */
export function AladinMap(p: AladinMapProps) {
  const host = useRef<HTMLDivElement>(null);
  const al = useRef<Al | null>(null);
  const overlay = useRef<Al | null>(null);
  const cats = useRef<{ simbad: Al | null; gaia: Al | null }>({ simbad: null, gaia: null });
  const cb = useRef({ pick: p.onPick, centre: p.onCentre });
  cb.current = { pick: p.onPick, centre: p.onCentre };
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState("");

  useEffect(() => {
    let dead = false;
    const el = host.current!;
    ready()
      .then(() => {
        if (dead) return;
        el.innerHTML = "";
        const inner = document.createElement("div");
        inner.style.cssText = "width:100%;height:100%";
        el.appendChild(inner);
        const a = A.aladin(inner, {
          survey: hipsUrl(p.survey),
          fov: p.viewDeg ?? 0.25,
          target: `${p.ra} ${p.dec}`,
          cooFrame: "ICRS",
          showReticle: false,
          showZoomControl: false,
          showFullscreenControl: false,
          showLayersControl: false,
          showGotoControl: false,
          showShareControl: false,
          showSimbadPointerControl: false,
          showCooGridControl: false,
          showSettingsControl: false,
          showFrame: false,
          showCooGrid: false,
          showStatusBar: false,
          showContextMenu: false,
          showProjectionControl: false,
          showCooLocation: false,
          showFov: false,
        });
        al.current = a;
        a.on("click", (e: { ra: number; dec: number; isDragging?: boolean }) => {
          if (!e.isDragging && Number.isFinite(e.ra)) cb.current.pick?.(e.ra, e.dec);
        });
        let t: ReturnType<typeof setTimeout> | undefined;
        a.on("positionChanged", (e: { ra: number; dec: number }) => {
          clearTimeout(t);
          t = setTimeout(() => cb.current.centre?.(e.ra, e.dec), 120);
        });
        overlay.current = A.graphicOverlay({ color: "#4aa8e8", lineWidth: 2 });
        a.addOverlay(overlay.current);
        setState("ready");
      })
      .catch((e: unknown) => {
        if (!dead) {
          setState("error");
          setErr(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      dead = true;
      al.current = null;
      overlay.current = null;
      cats.current = { simbad: null, gaia: null };
      el.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // survey
  useEffect(() => {
    const a = al.current;
    if (state !== "ready" || !a) return;
    try {
      a.setBaseImageLayer(A.imageHiPS ? A.imageHiPS(hipsUrl(p.survey)) : hipsUrl(p.survey));
    } catch (e) {
      console.warn("aladin survey", e);
    }
  }, [state, p.survey]);

  // centre + zoom. A HiPS given by URL loads its properties asynchronously and can reset the
  // zoom on first load, so re-apply setFoV at 400, 1200 and 2500 ms.
  useEffect(() => {
    const a = al.current;
    if (state !== "ready" || !a) return;
    a.gotoRaDec(p.ra, p.dec);
    if (p.viewDeg) {
      const v = p.viewDeg;
      a.setFoV(v);
      const timers = [400, 1200, 2500].map((ms) => setTimeout(() => al.current === a && a.setFoV(v), ms));
      return () => timers.forEach(clearTimeout);
    }
  }, [state, p.ra, p.dec, p.viewDeg]);

  // field box + movers
  useEffect(() => {
    const a = al.current;
    const o = overlay.current;
    if (state !== "ready" || !a || !o) return;
    o.removeAll();
    if (p.fieldArcmin) {
      const h = p.fieldArcmin / 60 / 2;
      const w = h / Math.max(0.05, Math.cos((p.dec * Math.PI) / 180));
      o.add(A.polygon([[p.ra - w, p.dec - h], [p.ra + w, p.dec - h], [p.ra + w, p.dec + h], [p.ra - w, p.dec + h]], { color: "#4aa8e8", lineWidth: 2 }));
    }
    const r = Math.max(0.0015, (p.fieldArcmin ?? 3) / 60 / 22);
    p.movers?.forEach((m) => o.add(A.circle(m.ra, m.dec, r, { color: m.identified === false ? "#ff9f1a" : "#ff3b3b", lineWidth: 3 })));
  }, [state, p.ra, p.dec, p.fieldArcmin, p.movers]);

  // catalogue layers through our backend
  useEffect(() => {
    const a = al.current;
    if (state !== "ready" || !a) return;
    const ctl = new AbortController();
    (["simbad", "gaia"] as const).forEach((k) => {
      if (cats.current[k]) {
        try {
          a.removeLayer?.(cats.current[k]);
        } catch {
          /* layer already gone */
        }
        cats.current[k] = null;
      }
    });
    const radius = Math.min(900, Math.max(60, (p.viewDeg ?? 0.25) * 0.75 * 3600));
    const layer = (key: "simbad" | "gaia", opts: Record<string, unknown>, limit: number) =>
      api
        .cone({ ra: p.ra, dec: p.dec, radius_arcsec: radius, source: key, limit }, ctl.signal)
        .then((res) => {
          if (ctl.signal.aborted || al.current !== a) return;
          const cat = A.catalog({ name: key === "simbad" ? "SIMBAD" : "Gaia DR3", onClick: "showPopup", ...opts });
          a.addCatalog(cat);
          cat.addSources(
            res.sources
              .filter((s) => Number.isFinite(s.ra) && Number.isFinite(s.dec))
              .map((s) => A.source(s.ra, s.dec, { name: s.id, type: s.otype ?? "", mag: s.mag ?? "" })),
          );
          cats.current[key] = cat;
        })
        .catch(() => undefined);
    if (p.showSimbad) layer("simbad", { shape: "cross", color: "#9fe870", sourceSize: 12 }, 300);
    if (p.showGaia) layer("gaia", { shape: "circle", color: "#f0b030", sourceSize: 8 }, 800);
    return () => ctl.abort();
  }, [state, p.showSimbad, p.showGaia, p.ra, p.dec, p.viewDeg]);

  return (
    <div className={p.className} style={{ position: "relative", background: "#000", ...p.style }}>
      <div ref={host} style={{ position: "absolute", inset: 0 }} />
      {state === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center text-white/70">
          <Loader2 size={18} className="animate-spin" />
        </div>
      )}
      {state === "error" && (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-white/80" style={{ fontSize: 13 }}>
          Sky map could not start: {err}
        </div>
      )}
    </div>
  );
}
