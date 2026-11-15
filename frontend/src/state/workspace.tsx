// Workspace: which target, which field, which set, and the build job.
//
// LOADING RULE: choosing a new target/coordinates removes the old set at once.
// Every load gets a new generation number; results from an older generation are
// ignored, so the previous object's image can never come back while a new one loads.
// Cancel returns to the empty "choose a target" state (it restores nothing old).

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { api, ApiError, type Identify, type Manifest, type SetStatus } from "../api/client";
import { propagate, round3 } from "../lib/coords";

export interface Target {
  name: string | null;
  ra: number; // position used for the search (today, proper motion applied when known)
  dec: number;
  pmra?: number | null;
  pmdec?: number | null;
  epoch?: number | null; // epoch of the catalogue position (catRa/catDec)
  catRa?: number; // catalogue position, kept for share links of moving targets
  catDec?: number;
  source: string;
  kind?: string;
  fromCoords?: boolean; // build started from typed/clicked coordinates: identify what is there
}

export type Phase = "empty" | "resolving" | "building" | "ready" | "error";

export interface WorkspaceState {
  phase: Phase;
  gen: number;
  query: string | null; // text being resolved
  target: Target | null;
  fov: number;
  upsample: number;
  maxFrames: number;
  setId: string | null;
  job: SetStatus | null;
  manifest: Manifest | null;
  error: string | null;
  startedAt: number | null;
  /** Reverse lookup for builds started from coordinates ("Nearest known object: ..."). */
  identity: Identify | null;
  identityState: "idle" | "loading" | "done" | "error";
}

type Action =
  | { type: "resolve"; gen: number; query: string; fov: number }
  | { type: "build"; gen: number; target: Target; fov: number }
  | { type: "job"; gen: number; setId: string; job: SetStatus | null }
  | { type: "ready"; gen: number; setId: string; manifest: Manifest; target?: Target }
  | { type: "error"; gen: number; message: string }
  | { type: "cancel"; gen: number }
  | { type: "preset"; gen: number; target: Target; fov: number }
  | { type: "identifying"; gen: number }
  | { type: "identified"; gen: number; identity: Identify | null }
  | { type: "fov"; fov: number }
  | { type: "options"; upsample?: number; maxFrames?: number };

const LS_LAST = "cosmic.lastSet";
const LS_OPTS = "cosmic.options";

function loadOptions(): { upsample: number; maxFrames: number } {
  try {
    const o = JSON.parse(localStorage.getItem(LS_OPTS) ?? "{}");
    return { upsample: Number(o.upsample) || 2, maxFrames: Number(o.maxFrames) || 40 };
  } catch {
    return { upsample: 2, maxFrames: 40 };
  }
}

const initial: WorkspaceState = {
  phase: "empty",
  gen: 0,
  query: null,
  target: null,
  fov: 4,
  ...loadOptions(),
  setId: null,
  job: null,
  manifest: null,
  error: null,
  startedAt: null,
  identity: null,
  identityState: "idle",
};

const NO_IDENTITY = { identity: null, identityState: "idle" as const };

function reducer(s: WorkspaceState, a: Action): WorkspaceState {
  switch (a.type) {
    case "resolve":
      // New request: drop the old set immediately.
      return { ...s, ...NO_IDENTITY, phase: "resolving", gen: a.gen, query: a.query, target: null, fov: a.fov, setId: null, job: null, manifest: null, error: null, startedAt: Date.now() };
    case "identifying":
      if (a.gen !== s.gen) return s;
      return { ...s, identity: null, identityState: "loading" };
    case "identified": {
      if (a.gen !== s.gen) return s;
      const id = a.identity;
      // Within 10": the position IS that object, so call it by its name.
      const rename = id?.use_as_name && id.nearest && s.target && !s.target.name;
      return {
        ...s,
        identity: id,
        identityState: id ? "done" : "error",
        target: rename && s.target ? { ...s.target, name: id!.nearest!.name, source: `${s.target.source} · named by ${id!.nearest!.catalogue}` } : s.target,
      };
    }
    case "build":
      return {
        ...s,
        ...(s.gen === a.gen ? {} : NO_IDENTITY),
        phase: "building",
        gen: a.gen,
        query: s.gen === a.gen ? s.query : null,
        target: a.target,
        fov: a.fov,
        setId: null,
        job: null,
        manifest: null,
        error: null,
        startedAt: s.gen === a.gen && s.startedAt ? s.startedAt : Date.now(),
      };
    case "job":
      if (a.gen !== s.gen || s.phase !== "building") return s;
      return { ...s, setId: a.setId, job: a.job };
    case "ready":
      if (a.gen !== s.gen) return s;
      return { ...s, phase: "ready", setId: a.setId, manifest: a.manifest, target: a.target ?? s.target, job: null, error: null };
    case "error":
      if (a.gen !== s.gen) return s;
      return { ...s, phase: "error", error: a.message, manifest: null, setId: null };
    case "cancel":
      return { ...s, ...NO_IDENTITY, phase: "empty", gen: a.gen, query: null, target: null, setId: null, job: null, manifest: null, error: null, startedAt: null };
    case "preset":
      // A link without auto=1: show the target, wait for Build. No old set stays on stage.
      return { ...s, ...NO_IDENTITY, phase: "empty", gen: a.gen, query: null, target: a.target, fov: a.fov, setId: null, job: null, manifest: null, error: null, startedAt: null };
    case "fov":
      return { ...s, fov: a.fov };
    case "options": {
      const next = { ...s, upsample: a.upsample ?? s.upsample, maxFrames: a.maxFrames ?? s.maxFrames };
      try {
        localStorage.setItem(LS_OPTS, JSON.stringify({ upsample: next.upsample, maxFrames: next.maxFrames }));
      } catch {
        /* storage blocked: fine */
      }
      return next;
    }
  }
}

export interface LoadRequest {
  query?: string; // name or coordinates text to resolve first
  target?: Target; // already-known position
  fov?: number;
  propagate?: boolean; // target.ra/dec are at target.epoch: apply proper motion to today
}

interface WorkspaceApi {
  state: WorkspaceState;
  load: (req: LoadRequest) => void;
  rebuild: () => void;
  cancel: () => void;
  preset: (target: Target, fov: number, propagate: boolean) => void;
  setFov: (fov: number) => void;
  setOptions: (o: { upsample?: number; maxFrames?: number }) => void;
  restoreLast: () => boolean;
}

const Ctx = createContext<WorkspaceApi | null>(null);

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new DOMException("aborted", "AbortError"));
    });
  });

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const newGeneration = () => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    genRef.current += 1;
    return { gen: genRef.current, signal: abortRef.current.signal };
  };

  const pollSet = useCallback(async (gen: number, signal: AbortSignal, target: Target, fov: number) => {
    const s = stateRef.current;
    const created = await api.createSet({ ra: target.ra, dec: target.dec, fov_arcmin: fov, upsample: s.upsample, max_frames: s.maxFrames }, signal);
    const setId = created.set_id;
    for (;;) {
      if (signal.aborted || gen !== genRef.current) return;
      const st = await api.getSet(setId, signal);
      if (gen !== genRef.current) return;
      if (st.state === "done" && st.set) {
        dispatch({ type: "ready", gen, setId, manifest: st.set });
        try {
          localStorage.setItem(LS_LAST, JSON.stringify({ setId, target, fov }));
        } catch {
          /* ignore */
        }
        return;
      }
      if (st.state === "error") {
        dispatch({ type: "error", gen, message: st.error?.message ?? "The set could not be built" });
        return;
      }
      dispatch({ type: "job", gen, setId, job: st });
      await sleep(1000, signal);
    }
  }, []);

  const identify = useCallback((gen: number, signal: AbortSignal, t: Target) => {
    dispatch({ type: "identifying", gen });
    api
      .identify(t.ra, t.dec, 30, signal)
      .then((identity) => dispatch({ type: "identified", gen, identity }))
      .catch(() => dispatch({ type: "identified", gen, identity: null }));
  }, []);

  const load = useCallback(
    (req: LoadRequest) => {
      const { gen, signal } = newGeneration();
      const fov = req.fov ?? stateRef.current.fov;
      const run = async () => {
        let target = req.target;
        if (!target) {
          dispatch({ type: "resolve", gen, query: req.query ?? "", fov });
          const r = await api.resolve(req.query ?? "", signal);
          if (gen !== genRef.current) return;
          target = {
            name: r.main_id ?? r.name,
            ra: r.ra,
            dec: r.dec,
            pmra: r.pmra,
            pmdec: r.pmdec,
            epoch: r.epoch,
            catRa: r.catalog_ra,
            catDec: r.catalog_dec,
            source: r.source,
            kind: r.kind,
          };
          if (!target.name) target = { ...target, fromCoords: true };
          const f = req.fov ?? r.fov_arcmin ?? fov;
          dispatch({ type: "build", gen, target, fov: f });
          if (target.fromCoords) identify(gen, signal, target);
          await pollSet(gen, signal, target, f);
          return;
        }
        // Catalogue position + proper motion (URL intake): shift to today, round for stable caching.
        if (req.propagate && target.epoch && (target.pmra || target.pmdec)) {
          const [ra, dec] = propagate(target.ra, target.dec, target.pmra ?? 0, target.pmdec ?? 0, target.epoch);
          target = { ...target, catRa: target.ra, catDec: target.dec, ra: round3(ra), dec: round3(dec) };
        }
        if (!target.name) target = { ...target, fromCoords: true };
        dispatch({ type: "build", gen, target, fov });
        // Started from coordinates: ask the catalogues what is there, at the same time as the build.
        if (target.fromCoords) identify(gen, signal, target);
        await pollSet(gen, signal, target, fov);
      };
      run().catch((e: unknown) => {
        if ((e as Error).name === "AbortError" || gen !== genRef.current) return;
        dispatch({ type: "error", gen, message: e instanceof ApiError ? e.message : String((e as Error).message ?? e) });
      });
    },
    [pollSet, identify],
  );

  const rebuild = useCallback(() => {
    const t = stateRef.current.target;
    if (t) load({ target: t, fov: stateRef.current.fov });
  }, [load]);

  const cancel = useCallback(() => {
    const { gen } = newGeneration();
    dispatch({ type: "cancel", gen });
  }, []);

  const restoreLast = useCallback(() => {
    let saved: { setId: string; target: Target; fov: number } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(LS_LAST) ?? "null");
    } catch {
      saved = null;
    }
    if (!saved?.setId || !saved.target) return false;
    const { gen, signal } = newGeneration();
    const target = saved.target;
    dispatch({ type: "build", gen, target, fov: saved.fov ?? 4 });
    api
      .getSet(saved.setId, signal)
      .then((st) => {
        if (st.state === "done" && st.set) dispatch({ type: "ready", gen, setId: st.set.set_id, manifest: st.set, target });
        else pollSet(gen, signal, target, saved!.fov ?? 4).catch(() => dispatch({ type: "cancel", gen }));
      })
      .catch(() => {
        if (gen === genRef.current) dispatch({ type: "cancel", gen });
      });
    return true;
  }, [pollSet]);

  const preset = useCallback(
    (target: Target, fov: number, propagateNow: boolean) => {
      const { gen, signal } = newGeneration();
      let t = target;
      if (propagateNow && t.epoch && (t.pmra || t.pmdec)) {
        const [ra, dec] = propagate(t.ra, t.dec, t.pmra ?? 0, t.pmdec ?? 0, t.epoch);
        t = { ...t, catRa: t.ra, catDec: t.dec, ra: round3(ra), dec: round3(dec) };
      }
      if (!t.name) t = { ...t, fromCoords: true };
      dispatch({ type: "preset", gen, target: t, fov });
      if (t.fromCoords) identify(gen, signal, t); // name the position before anything is built
    },
    [identify],
  );

  const setFov = useCallback((fov: number) => dispatch({ type: "fov", fov }), []);
  const setOptions = useCallback((o: { upsample?: number; maxFrames?: number }) => dispatch({ type: "options", ...o }), []);

  // After a reload on ANY page (Image Exploration, AstroAnalytics...), bring back the last field.
  // Child effects run first: if a page already started a load (explorer URL intake), gen > 0 and we skip.
  // (No abort-on-unmount: this provider lives as long as the app. In dev, StrictMode's simulated
  // unmount would otherwise abort the restore and leave every page empty after a reload.)
  useEffect(() => {
    if (genRef.current === 0) restoreLast();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo(
    () => ({ state, load, rebuild, cancel, preset, setFov, setOptions, restoreLast }),
    [state, load, rebuild, cancel, preset, setFov, setOptions, restoreLast],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace outside WorkspaceProvider");
  return v;
}
