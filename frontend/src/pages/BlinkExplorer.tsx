import { Hammer, PanelLeft, PanelRightOpen, RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { combineUrl, imageUrl } from "../api/client";
import { AladinMap, SURVEYS, type SurveyId } from "../components/AladinMap";
import { CommandPanel, targetFromInfo, useTargets } from "../components/CommandPanel";
import { IdentityLine, Inspector } from "../components/Inspector";
import { LoadingScreen } from "../components/LoadingScreen";
import { Stage } from "../components/Stage";
import { Timeline } from "../components/Timeline";
import { Toolbar } from "../components/Toolbar";
import { Banner, CoordTable } from "../components/ui";
import { useKeys } from "../hooks/useKeys";
import { useWide } from "../hooks/useMedia";
import { usePreload } from "../hooks/usePreload";
import { useMovers, useOverlay, useSetView } from "../hooks/useSetView";
import { explorerPath, readExplorerParams, shareParams } from "../lib/url";
import { Link } from "react-router-dom";
import { DEFAULT_DOCK, dockStore, liveStore } from "../state/assistantStore";
import { useCandidates } from "../state/candidates";
import { useSettings } from "../state/settings";
import { MODES, useView } from "../state/view";
import { useWorkspace, type Target } from "../state/workspace";

const DEFAULT_CENTRE = { ra: 133.758, dec: -7.242 }; // WISE 0855 today

/** Behind the loading card and the empty state: the real sky around the (new) target. */
function MapStage({ ra, dec, fov, onPick }: { ra: number; dec: number; fov: number; onPick: (ra: number, dec: number) => void }) {
  const [survey, setSurvey] = useState<SurveyId>("allwise");
  const [gaia, setGaia] = useState(false);
  const [simbad, setSimbad] = useState(true);
  return (
    <div className="absolute inset-0">
      <AladinMap ra={ra} dec={dec} viewDeg={Math.max(0.1, (fov / 60) * 3.2)} fieldArcmin={fov} survey={survey} showGaia={gaia} showSimbad={simbad} onPick={onPick} style={{ position: "absolute", inset: 0 }} />
      <div className="panel absolute bottom-3 right-3 z-10 hidden w-[250px] p-3 lg:block">
        <div style={{ fontWeight: 700 }}>Sky map</div>
        <div className="seg mt-1.5 w-full">
          {SURVEYS.map((s) => (
            <button key={s.id} className="flex-1" aria-pressed={survey === s.id} onClick={() => setSurvey(s.id)} style={{ padding: "0 6px", fontSize: 12 }}>
              {s.short}
            </button>
          ))}
        </div>
        <label className="mt-2 flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={simbad} onChange={() => setSimbad((x) => !x)} />
          SIMBAD objects
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={gaia} onChange={() => setGaia((x) => !x)} />
          Gaia DR3 stars
        </label>
        <p className="mb-0 mt-1.5 text-ink3" style={{ fontSize: 11.5 }}>
          Blue box = the {fov}′ field SPHEREx images will cover. Click the map to choose a position.
        </p>
      </div>
    </div>
  );
}

export default function BlinkExplorer({ params }: { params: URLSearchParams }) {
  const ws = useWorkspace();
  const { state } = ws;
  const { view: v, dispatch } = useView();
  const targets = useTargets();
  const [blinkOn, setBlinkOn] = useState(false);
  // Wide screens: panels beside the stage. Narrow (phones, tablets): panels are drawers, closed at first.
  const wide = useWide();
  const [cmdCollapsed, setCmdCollapsed] = useState(() => !window.matchMedia("(min-width: 1024px)").matches);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    setCmdCollapsed(!wide);
    setInspectorOpen(wide);
  }, [wide]);
  const openDrawer = (which: "cmd" | "insp") => {
    if (which === "cmd") {
      setCmdCollapsed(false);
      if (!wide) setInspectorOpen(false);
    } else {
      setInspectorOpen(true);
      if (!wide) setCmdCollapsed(true);
    }
  };
  const [mapOpen, setMapOpen] = useState(false);
  const intake = useMemo(() => readExplorerParams(params), [params]);
  const embed = params.get("embed") === "1";

  // URL intake (this component remounts whenever the search params change).
  useEffect(() => {
    const name = params.get("name");
    const auto = params.get("auto") === "1" || params.get("auto") === "true";
    if (intake) {
      const target: Target = {
        name: intake.name ?? null,
        ra: intake.ra,
        dec: intake.dec,
        pmra: intake.pmra,
        pmdec: intake.pmdec,
        epoch: intake.epoch,
        source: intake.hasPm ? "link · proper motion applied to today" : "coordinates",
      };
      if (intake.auto) ws.load({ target, fov: intake.fov, propagate: intake.hasPm });
      else ws.preset(target, intake.fov ?? state.fov, intake.hasPm);
    } else if (name && auto) {
      ws.load({ query: name, fov: Number(params.get("fov")) || undefined });
    } else if (state.phase === "empty" && !state.target) {
      ws.restoreLast();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = state.phase === "ready" && state.manifest && state.setId ? state.manifest : null;
  const setId = ready ? state.setId : null;
  const { view, error: viewError } = useSetView(setId, v.band);
  const nEpochs = view?.epochs.length ?? 0;
  const hasView = !!(ready && view && setId);

  // New set: reset A/B, fit, (re)start blinking; make the address bar point at this field.
  useEffect(() => {
    if (!ready) return;
    dispatch({ type: "reset", nEpochs: ready.epochs.length });
    if (state.target) {
      const path = explorerPath({ ...shareParams(state.target, state.fov), embed });
      if (window.location.pathname + window.location.search !== path) window.history.replaceState(window.history.state, "", path);
    }
  }, [ready?.set_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const { settings } = useSettings();
  const U = view ? (settings.renderScale === "auto" ? Math.max(1, Math.min(8, Math.round(512 / view.grid.n))) : settings.renderScale) : 4;
  const epochUrls = useMemo(
    () => (view ? view.epochs.map((e) => (e.image_url ? imageUrl(e.image_url, { stretch: v.stretch, cmap: v.cmap, pmin: v.pmin, pmax: v.pmax, upscale: U }) : null)) : []),
    [view, v.stretch, v.cmap, v.pmin, v.pmax, U],
  );
  const a = Math.min(v.a, Math.max(0, nEpochs - 1));
  const b = Math.min(v.b, Math.max(0, nEpochs - 1));
  const diffUrl = setId && view && a !== b ? combineUrl(setId, a, b, v.band, v.tail, v.diffCmap, U) : null;
  const diffUrls = useMemo(
    () => (setId && view && v.mode === "diff" ? view.epochs.filter((e) => e.index !== a && e.has_data).map((e) => combineUrl(setId, a, e.index, v.band, v.tail, v.diffCmap, U)) : []),
    [setId, view, v.mode, a, v.band, v.tail, v.diffCmap, U],
  );
  const preloadList = useMemo(() => [...epochUrls.filter((u): u is string => !!u), ...diffUrls, ...(diffUrl ? [diffUrl] : [])], [epochUrls, diffUrls, diffUrl]);
  const loaded = usePreload(preloadList);
  const allReady = epochUrls.every((u) => !u || loaded.has(u)) && diffUrls.every((u) => loaded.has(u));
  const compare = v.mode === "diff" || v.mode === "side" || v.mode === "swipe";
  const skip = compare ? a : undefined;
  const movers = useMovers(setId, a, b, v.band, true);
  const moversLoading = !!setId && a !== b && !movers;
  const gaia = useOverlay(setId, "gaia", v.band, v.overlays.gaia);
  const simbad = useOverlay(setId, "simbad", v.band, v.overlays.simbad);
  const status = (o: ReturnType<typeof useOverlay>) => (o.loading ? "loading…" : o.error ? "unavailable" : o.overlay ? String(o.overlay.count) : undefined);

  // Playback: Blink alternates A and B; other modes step B through the epochs.
  useEffect(() => {
    if (!v.playing || !allReady || nEpochs < 2) return;
    const t = setInterval(() => {
      if (v.mode === "blink") setBlinkOn((x) => !x);
      else dispatch({ type: "step", delta: 1, n: nEpochs, skip });
    }, v.speedMs);
    return () => clearInterval(t);
  }, [v.playing, v.mode, v.speedMs, allReady, nEpochs, dispatch, skip]);
  const shown = v.mode === "blink" && v.playing && blinkOn ? a : b;

  useKeys({
    Space: () => dispatch({ type: "set", patch: { playing: !v.playing } }),
    ArrowLeft: () => dispatch({ type: "step", delta: -1, n: nEpochs, skip }),
    ArrowRight: () => dispatch({ type: "step", delta: 1, n: nEpochs, skip }),
    ...Object.fromEntries(MODES.map((m) => [m.key, () => dispatch({ type: "set", patch: { mode: m.id } })])),
    a: () => dispatch({ type: "set", patch: { a: b } }),
    "+": () => dispatch({ type: "zoom", factor: 1.25 }),
    "=": () => dispatch({ type: "zoom", factor: 1.25 }),
    "-": () => dispatch({ type: "zoom", factor: 1 / 1.25 }),
    "0": () => dispatch({ type: "fit" }),
  });

  // Discovery Log: click a ring = add that mover; Measure tool = record a position on that date
  const cands = useCandidates();
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  const addMover = (i: number) => {
    const p = movers?.pairs[i];
    if (!p || !setId || !movers) return;
    const id = cands.addFromMover(p, { setId, band: v.band, mjdA: movers.a.mjd, mjdB: movers.b.mjd, targetName: state.target?.name });
    if (id) setToast(`Added “${p.name ?? "mover"}” to the Discovery Log`);
  };
  const measure = (ra: number, dec: number, epochIndex: number) => {
    const e = view?.epochs[epochIndex];
    if (!e || !setId) return;
    const m = { mjd: e.mjd, ra, dec, source: `measure tool · ${e.label}`, set_id: setId, band: v.band };
    const active = cands.list.find((c) => c.id === cands.activeId);
    if (active) {
      cands.addMeasurement(active.id, m);
      setToast(`Position on ${e.label} added to “${active.label}”`);
    } else {
      cands.add({ label: `Measured object near ${state.target?.name ?? "field"}`, ra, dec, origin: `Measure tool · set ${setId}`, measurements: [{ ...m, id: "m0" }] });
      setToast("New Discovery Log entry created. Measure the same object in other epochs to derive its motion.");
    }
  };

  // Tell the assistant what is on screen, and where its button may sit without covering panels.
  useEffect(() => {
    liveStore.set(hasView ? { view, movers, a, b, band: v.band, mode: v.mode } : null);
  }, [hasView, view, movers, a, b, v.band, v.mode]);
  useEffect(() => () => liveStore.set(null), []);
  const timelineRef = useRef<HTMLDivElement>(null);
  const [timelineH, setTimelineH] = useState(0);
  useLayoutEffect(() => {
    const el = timelineRef.current;
    if (!el) return setTimelineH(0);
    const ro = new ResizeObserver(() => setTimelineH(el.offsetHeight));
    ro.observe(el);
    setTimelineH(el.offsetHeight);
    return () => ro.disconnect();
  }, [hasView]);
  useEffect(() => {
    if (embed) return;
    const drawerOpen = !wide && (!cmdCollapsed || (hasView && inspectorOpen));
    dockStore.set(hasView ? { right: wide && inspectorOpen ? 342 + 14 : 16, bottom: timelineH + 14, hidden: drawerOpen } : { right: wide ? 20 + 250 + 14 : 16, bottom: 20, hidden: drawerOpen });
  }, [hasView, inspectorOpen, cmdCollapsed, timelineH, embed, wide]);
  useEffect(() => () => dockStore.set(DEFAULT_DOCK), []);

  const pick = (ra: number, dec: number) => ws.preset({ name: null, ra, dec, source: "sky map" }, state.fov, false);
  // on narrow screens the drawers float over the stage instead of squeezing it
  const leftPad = wide && !embed && !cmdCollapsed ? 312 : 0;
  const rightPad = wide && !embed && hasView && inspectorOpen ? 342 : 0;
  const centre = state.target ?? DEFAULT_CENTRE;

  let center: React.ReactNode;
  if (hasView) {
    center = (
      <div className="absolute inset-y-0" style={{ left: leftPad, right: rightPad }}>
        <Stage view={view!} manifest={ready!} target={state.target} upscale={U} epochUrls={epochUrls} diffUrl={diffUrl} ready={loaded} movers={v.overlays.movers ? movers : null} gaia={gaia.overlay} simbad={simbad.overlay} shownIndex={shown} onMoverClick={addMover} onMeasure={measure} />
      </div>
    );
  } else {
    // map of the NEW target (or the default field) + whatever card the phase needs
    let card: React.ReactNode = null;
    if (state.phase === "resolving" || state.phase === "building") card = <LoadingScreen state={state} onCancel={ws.cancel} />;
    else if (ready) card = viewError ? <Banner tone="bad" title="Could not load the view">{viewError}</Banner> : <LoadingScreen state={state} onCancel={ws.cancel} extra="Rendering images" />;
    else if (state.phase === "error" && /No SPHEREx images cover/i.test(state.error ?? ""))
      card = (
        <div className="panel max-w-[460px] p-4">
          <Banner tone="warn" title="No SPHEREx coverage here (yet)">
            SPHEREx has no released images that contain this position (collection spherex_dr1). The survey maps the sky in passes and data releases arrive over time, so try again after the next release, a nearby position, or one of the test objects.
          </Banner>
          <div className="mt-3 flex flex-wrap gap-2">
            {targets.slice(0, 3).map((t) => (
              <button key={t.id} className="btn" onClick={() => ws.load({ target: targetFromInfo(t), fov: t.fov_arcmin })}>
                {t.name}
              </button>
            ))}
            <button className="btn" onClick={ws.rebuild}>
              <RotateCcw size={14} /> Try again
            </button>
          </div>
        </div>
      );
    else if (state.phase === "error")
      card = (
        <div className="panel max-w-[440px] p-4">
          <Banner tone="bad" title="This field could not be built">
            {state.error}
          </Banner>
          <div className="mt-3 flex gap-2">
            {state.target && (
              <button className="btn btn-primary" onClick={ws.rebuild}>
                <RotateCcw size={14} /> Try again
              </button>
            )}
            <button className="btn" onClick={ws.cancel}>
              Choose another target
            </button>
          </div>
        </div>
      );
    else
      card = (
        <div className="panel w-[400px] max-w-full p-4">
          {state.target ? (
            <>
              <div className="cap">Ready to build</div>
              <div style={{ fontWeight: 800, fontSize: 18 }}>{state.target.name ?? "Sky position"}</div>
              <CoordTable ra={state.target.ra} dec={state.target.dec} />
              <div className="mt-1.5">
                <IdentityLine state={state} />
              </div>
              <button className="btn btn-primary mt-3 w-full" onClick={ws.rebuild}>
                <Hammer size={14} /> Build this {state.fov}′ field
              </button>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 800, fontSize: 18 }}>Choose a target</div>
              <p className="mb-2 mt-1 text-ink2">Search on the left, pick a test object, or click the sky map. We fetch every SPHEREx image of that patch and blink them.</p>
              <div className="flex flex-wrap gap-1.5">
                {targets.map((t) => (
                  <button key={t.id} className="btn" onClick={() => ws.load({ target: targetFromInfo(t), fov: t.fov_arcmin })}>
                    {t.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      );
    center = (
      <>
        <MapStage ra={centre.ra} dec={centre.dec} fov={state.fov} onPick={pick} />
        <div className="pointer-events-none absolute inset-y-0 z-10 flex items-center justify-center p-4" style={{ left: leftPad, right: wide ? 270 : 0 }}>
          <div className="pointer-events-auto">{card}</div>
        </div>
      </>
    );
  }

  return (
    <div id="explorer-root" className="flex h-full flex-col bg-bg">
      {hasView && (
        <Toolbar
          mapOpen={mapOpen}
          onMap={() => setMapOpen((o) => !o)}
          overlayStatus={{ gaia: status(gaia), simbad: status(simbad), movers: movers ? `${movers.pairs.length}` : undefined }}
          leading={
            !wide && !embed ? (
              <>
                <button className="btn" aria-pressed={!cmdCollapsed} onClick={() => (cmdCollapsed ? openDrawer("cmd") : setCmdCollapsed(true))}>
                  <PanelLeft size={14} />
                  Target
                </button>
                <button className="btn" aria-pressed={inspectorOpen} onClick={() => (inspectorOpen ? setInspectorOpen(false) : openDrawer("insp"))}>
                  <PanelRightOpen size={14} />
                  Info
                </button>
              </>
            ) : null
          }
        />
      )}
      <div className="relative min-h-0 flex-1">
        {center}
        {hasView && mapOpen && state.target && (
          <div className="panel absolute bottom-3 z-20 overflow-hidden" style={{ left: leftPad + 12, width: "min(320px, calc(100% - 24px))", height: 250 }}>
            <AladinMap
              ra={state.target.ra}
              dec={state.target.dec}
              viewDeg={Math.max(0.1, (state.fov / 60) * 3.2)}
              fieldArcmin={state.fov}
              survey="allwise"
              showSimbad
              movers={movers?.pairs.filter((p) => p.to.ra != null).map((p) => ({ ra: p.to.ra!, dec: p.to.dec!, name: p.name, identified: p.identified }))}
              style={{ position: "absolute", inset: 0 }}
            />
            <div className="absolute left-0 right-0 top-0 px-2 py-1" style={{ background: "var(--overlay-bg)", fontSize: 12, fontWeight: 600 }}>
              Where this field is on the sky (AllWISE)
            </div>
          </div>
        )}
        {toast && (
          <div className="panel absolute bottom-4 left-1/2 z-40 -translate-x-1/2 px-3 py-2" role="status">
            {toast}{" "}
            <Link to="/candidates" className="link">
              Open log
            </Link>
          </div>
        )}
        {!embed && (wide || !cmdCollapsed || !hasView) && <CommandPanel collapsed={cmdCollapsed} onToggle={() => (cmdCollapsed ? openDrawer("cmd") : setCmdCollapsed(true))} />}
        {!embed && hasView && (wide || inspectorOpen) && (inspectorOpen ? (
          <Inspector open onClose={() => setInspectorOpen(false)} state={state} view={view!} manifest={ready!} movers={movers} moversLoading={moversLoading} gaia={gaia.overlay} simbad={simbad.overlay} onAddMover={addMover} />
        ) : (
          <button className="btn absolute right-3 top-3 z-20" onClick={() => setInspectorOpen(true)} aria-label="Open inspector">
            <PanelRightOpen size={14} />
            Inspector
          </button>
        ))}
      </div>
      {hasView && (
        <div ref={timelineRef}>
          <Timeline view={view!} manifest={ready!} />
        </div>
      )}
    </div>
  );
}
