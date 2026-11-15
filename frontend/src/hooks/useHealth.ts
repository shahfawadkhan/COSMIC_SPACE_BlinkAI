import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Health } from "../api/client";

export interface HealthState {
  online: boolean | null; // null = first check pending
  ms: number | null;
  health: Health | null;
  failures: number; // consecutive failed checks
  recheck: () => void;
}

const Ctx = createContext<HealthState | null>(null);

/** One shared backend check (every 15 s) for the masthead, banners and assistant. */
export function HealthProvider({ children, intervalMs = 15000 }: { children: ReactNode; intervalMs?: number }) {
  const [s, setS] = useState<Omit<HealthState, "recheck">>({ online: null, ms: null, health: null, failures: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tick = useCallback(async () => {
    clearTimeout(timer.current);
    const t0 = performance.now();
    try {
      const h = await api.health();
      setS({ online: true, ms: Math.round(performance.now() - t0), health: h, failures: 0 });
    } catch {
      setS((p) => ({ online: false, ms: null, health: null, failures: p.failures + 1 }));
    }
    timer.current = setTimeout(tick, intervalMs);
  }, [intervalMs]);
  useEffect(() => {
    tick();
    return () => clearTimeout(timer.current);
  }, [tick]);
  return createElement(Ctx.Provider, { value: { ...s, recheck: tick } }, children);
}

export function useHealth(): HealthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("HealthProvider missing");
  return v;
}
