// View state: how the current set is shown. Reset (epochs A/B) whenever the set changes.

import { createContext, useContext, useMemo, useReducer, type ReactNode } from "react";

export type Mode = "single" | "blink" | "side" | "swipe" | "diff";
export const MODES: { id: Mode; label: string; key: string }[] = [
  { id: "single", label: "Single", key: "1" },
  { id: "blink", label: "Blink", key: "2" },
  { id: "side", label: "Side by side", key: "3" },
  { id: "swipe", label: "Swipe", key: "4" },
  { id: "diff", label: "Difference", key: "5" },
];
export const STRETCHES = ["linear", "sqrt", "asinh", "log"] as const;
export const IMAGE_CMAPS = ["gray", "inferno", "viridis", "magma"] as const;
export const DIFF_CMAPS = ["RdBu_r", "coolwarm", "gray"] as const;
export const TAILS = [
  { k: 0, label: "Raw" },
  { k: 2, label: "±2σ" },
  { k: 3, label: "±3σ" },
  { k: 5, label: "±5σ" },
];
export const SPEEDS = [
  { ms: 1000, label: "Slow" },
  { ms: 500, label: "Normal" },
  { ms: 250, label: "Fast" },
];

export interface ViewState {
  mode: Mode;
  a: number; // reference epoch
  b: number; // current epoch
  band: string; // "all" | "1".."6"
  stretch: string;
  cmap: string;
  diffCmap: string;
  tail: number;
  pmin: number;
  pmax: number;
  playing: boolean;
  speedMs: number;
  zoom: number; // CSS scale on top of the 4x-upscaled PNG
  fitToken: number; // bump to request "fit to window"
  swipe: number; // 0..1
  tool: "pan" | "measure"; // measure: click records a position for the Discovery Log
  overlays: { movers: boolean; gaia: boolean; simbad: boolean; grid: boolean; predict: boolean; field: boolean; crosshair: boolean };
}

export const initialView: ViewState = {
  mode: "blink",
  a: 0,
  b: 0,
  band: "all",
  stretch: "asinh",
  cmap: "gray",
  diffCmap: "RdBu_r",
  tail: 3,
  pmin: 1,
  pmax: 99.5,
  playing: false,
  speedMs: 500,
  zoom: 1,
  fitToken: 0,
  swipe: 0.5,
  tool: "pan",
  overlays: { movers: true, gaia: false, simbad: true, grid: true, predict: true, field: false, crosshair: true },
};

type Action =
  | { type: "set"; patch: Partial<ViewState> }
  | { type: "reset"; nEpochs: number }
  | { type: "step"; delta: number; n: number; skip?: number }
  | { type: "overlay"; key: keyof ViewState["overlays"] }
  | { type: "zoom"; factor: number }
  | { type: "fit" };

function reducer(s: ViewState, a: Action): ViewState {
  switch (a.type) {
    case "set":
      return { ...s, ...a.patch };
    case "reset":
      // New set: A = first epoch, B = last; Blink mode starts blinking right away.
      return { ...s, a: 0, b: Math.max(0, a.nEpochs - 1), playing: s.mode === "blink", fitToken: s.fitToken + 1 };
    case "step": {
      if (a.n <= 0) return s;
      let b = (((s.b + a.delta) % a.n) + a.n) % a.n;
      // Comparison modes never step B onto A (B − A would be empty).
      if (a.skip !== undefined && b === a.skip && a.n > 1) b = (((b + a.delta) % a.n) + a.n) % a.n;
      return b === s.b ? s : { ...s, b };
    }
    case "overlay":
      return { ...s, overlays: { ...s.overlays, [a.key]: !s.overlays[a.key] } };
    case "zoom":
      return { ...s, zoom: Math.min(16, Math.max(0.25, s.zoom * a.factor)) };
    case "fit":
      return { ...s, fitToken: s.fitToken + 1 };
  }
}

const Ctx = createContext<{ view: ViewState; dispatch: React.Dispatch<Action> } | null>(null);

export function ViewProvider({ children }: { children: ReactNode }) {
  const [view, dispatch] = useReducer(reducer, initialView);
  const value = useMemo(() => ({ view, dispatch }), [view]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useView() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useView outside ViewProvider");
  return v;
}
