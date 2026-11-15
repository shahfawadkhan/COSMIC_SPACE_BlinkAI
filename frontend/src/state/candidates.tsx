// Discovery Log: candidates kept in this browser (localStorage).
// Status is set by the user. Proper motion is derived only from >= 2 recorded positions.
// No invented confidence scores.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Identify, MoverPair } from "../api/client";

export type CandStatus = "unvalidated" | "catalogued" | "rejected";

export interface Measurement {
  id: string;
  mjd: number;
  ra: number;
  dec: number;
  source: string; // "mover A", "mover B", "measure tool"
  set_id?: string;
  band?: string;
}

export interface Candidate {
  id: string;
  label: string;
  ra: number; // latest known position
  dec: number;
  status: CandStatus;
  notes: string;
  created: string;
  origin: string;
  mover?: { shift_arcsec: number; pa_deg: number; significance: number; name?: string; catalogue?: string | null; matches_catalogue?: boolean; expected_shift_arcsec?: number | null };
  measurements: Measurement[];
  xmatch?: { at: string; label: string; nearest: Identify["nearest"]; gaia: Identify["gaia_nearest"] } | null;
}

const KEY = "cosmic.candidates.v1";
const uid = () => Math.random().toString(36).slice(2, 10);

function load(): Candidate[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Least-squares linear motion from >= 2 measurements (pmra* and pmdec, mas/yr). */
export function derivedMotion(ms: Measurement[]): { n: number; baselineDays: number; pmra: number; pmdec: number; total: number; pa: number } | null {
  const pts = [...ms].sort((a, b) => a.mjd - b.mjd);
  if (pts.length < 2) return null;
  const t0 = pts[0].mjd;
  const span = pts[pts.length - 1].mjd - t0;
  if (span < 1) return null;
  const dec0 = pts[0].dec;
  const cosd = Math.cos((dec0 * Math.PI) / 180);
  const ts = pts.map((p) => (p.mjd - t0) / 365.25);
  const xs = pts.map((p) => ((((p.ra - pts[0].ra + 540) % 360) - 180) * cosd * 3600));
  const ys = pts.map((p) => (p.dec - dec0) * 3600);
  const slope = (v: number[]) => {
    const n = ts.length;
    const mt = ts.reduce((a, b) => a + b, 0) / n;
    const mv = v.reduce((a, b) => a + b, 0) / n;
    const num = ts.reduce((s, t, i) => s + (t - mt) * (v[i] - mv), 0);
    const den = ts.reduce((s, t) => s + (t - mt) ** 2, 0);
    return den > 0 ? num / den : 0;
  };
  const pmra = slope(xs) * 1000;
  const pmdec = slope(ys) * 1000;
  return { n: pts.length, baselineDays: span, pmra, pmdec, total: Math.hypot(pmra, pmdec), pa: ((Math.atan2(pmra, pmdec) * 180) / Math.PI + 360) % 360 };
}

interface Ctx {
  list: Candidate[];
  activeId: string | null;
  setActive: (id: string | null) => void;
  add: (c: Omit<Candidate, "id" | "created" | "status" | "notes" | "measurements"> & Partial<Pick<Candidate, "measurements" | "notes" | "status">>) => string;
  addFromMover: (p: MoverPair, ctx: { setId: string; band: string; mjdA: number; mjdB: number; targetName?: string | null }) => string | null;
  update: (id: string, patch: Partial<Candidate>) => void;
  remove: (id: string) => void;
  addMeasurement: (id: string, m: Omit<Measurement, "id">) => void;
  removeMeasurement: (id: string, mid: string) => void;
}

const CandCtx = createContext<Ctx | null>(null);

export function CandidatesProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Candidate[]>(load);
  const [activeId, setActive] = useState<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
      /* storage full or blocked */
    }
  }, [list]);

  const add: Ctx["add"] = useCallback((c) => {
    const id = uid();
    setList((l) => [{ status: "unvalidated", notes: "", measurements: [], ...c, id, created: new Date().toISOString() }, ...l]);
    setActive(id);
    return id;
  }, []);

  const addFromMover: Ctx["addFromMover"] = useCallback(
    (p, ctx) => {
      if (p.from.ra == null || p.to.ra == null || p.from.dec == null || p.to.dec == null) return null;
      const named = p.identified && p.name && !p.name.startsWith("Unidentified");
      return add({
        label: named ? p.name! : `Mover near ${ctx.targetName ?? "field"} (${p.shift_arcsec.toFixed(1)}″)`,
        ra: p.to.ra,
        dec: p.to.dec,
        origin: `Blink Explorer · set ${ctx.setId} · band ${ctx.band}`,
        status: named ? "catalogued" : "unvalidated",
        mover: { shift_arcsec: p.shift_arcsec, pa_deg: p.pa_deg, significance: p.significance, name: p.name, catalogue: p.catalogue, matches_catalogue: p.matches_catalogue, expected_shift_arcsec: p.expected_shift_arcsec },
        measurements: [
          { id: uid(), mjd: ctx.mjdA, ra: p.from.ra, dec: p.from.dec!, source: "mover A (difference peak)", set_id: ctx.setId, band: ctx.band },
          { id: uid(), mjd: ctx.mjdB, ra: p.to.ra, dec: p.to.dec!, source: "mover B (difference peak)", set_id: ctx.setId, band: ctx.band },
        ],
      });
    },
    [add],
  );

  const update = useCallback((id: string, patch: Partial<Candidate>) => setList((l) => l.map((c) => (c.id === id ? { ...c, ...patch } : c))), []);
  const remove = useCallback((id: string) => setList((l) => l.filter((c) => c.id !== id)), []);
  const addMeasurement = useCallback(
    (id: string, m: Omit<Measurement, "id">) =>
      setList((l) =>
        l.map((c) => {
          if (c.id !== id) return c;
          const ms = [...c.measurements, { ...m, id: uid() }].sort((a, b) => a.mjd - b.mjd);
          const last = ms[ms.length - 1];
          return { ...c, measurements: ms, ra: last.ra, dec: last.dec };
        }),
      ),
    [],
  );
  const removeMeasurement = useCallback((id: string, mid: string) => setList((l) => l.map((c) => (c.id === id ? { ...c, measurements: c.measurements.filter((m) => m.id !== mid) } : c))), []);

  const value = useMemo(() => ({ list, activeId, setActive, add, addFromMover, update, remove, addMeasurement, removeMeasurement }), [list, activeId, add, addFromMover, update, remove, addMeasurement, removeMeasurement]);
  return <CandCtx.Provider value={value}>{children}</CandCtx.Provider>;
}

export function useCandidates() {
  const c = useContext(CandCtx);
  if (!c) throw new Error("CandidatesProvider missing");
  return c;
}
