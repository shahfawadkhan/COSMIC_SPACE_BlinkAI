import { useEffect, useState } from "react";
import { api, ApiError, type MoversResponse, type OverlayResponse, type ViewResponse } from "../api/client";

/** Catalogue markers for a set (positions per epoch). Fetched once per set + band + source. */
export function useOverlay(setId: string | null, source: "gaia" | "simbad", band: string, enabled: boolean) {
  const [data, setData] = useState<{ key: string; res: OverlayResponse | null; error: string | null } | null>(null);
  const key = `${setId}|${source}|${band}`;
  useEffect(() => {
    if (!setId || !enabled || data?.key === key) return;
    const ctrl = new AbortController();
    api
      .overlay(setId, source, band, ctrl.signal)
      .then((res) => setData({ key, res, error: null }))
      .catch((e) => !ctrl.signal.aborted && setData({ key, res: null, error: e instanceof ApiError ? e.message : String(e) }));
    return () => ctrl.abort();
  }, [setId, source, band, enabled, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const mine = data && data.key === key ? data : null;
  return { overlay: enabled ? (mine?.res ?? null) : null, error: mine?.error ?? null, loading: enabled && !!setId && !mine };
}

/** Epoch list + image URLs for one set and band. Cleared at once when the set changes. */
export function useSetView(setId: string | null, band: string) {
  const [data, setData] = useState<{ key: string; view: ViewResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${setId}|${band}`;
  useEffect(() => {
    setError(null);
    if (!setId) {
      setData(null);
      return;
    }
    const ctrl = new AbortController();
    api
      .view(setId, band, "epoch", ctrl.signal)
      .then((view) => setData({ key, view }))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(e instanceof ApiError ? e.message : String(e));
      });
    return () => ctrl.abort();
  }, [setId, band, key]);
  // Never hand out a view that belongs to another set/band.
  return { view: data && data.key === key ? data.view : null, error };
}

export function useMovers(setId: string | null, a: number, b: number, band: string, enabled: boolean) {
  const [data, setData] = useState<{ key: string; movers: MoversResponse } | null>(null);
  const key = `${setId}|${a}|${b}|${band}`;
  useEffect(() => {
    if (!setId || !enabled || a === b) return;
    const ctrl = new AbortController();
    api
      .movers(setId, a, b, band, ctrl.signal)
      .then((movers) => setData({ key, movers }))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [setId, a, b, band, enabled, key]);
  return data && data.key === key && enabled ? data.movers : null;
}
