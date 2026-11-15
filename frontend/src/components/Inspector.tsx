import { UnidentifiedNote } from "./UnidentifiedNote";
import { ExternalLink, MapPin, PanelRightClose } from "lucide-react";
import type { Manifest, MoversResponse, OverlayResponse, ViewResponse } from "../api/client";
import { fmtDate } from "../lib/coords";
import { useView } from "../state/view";
import type { WorkspaceState } from "../state/workspace";
import { CoordTable, KV, ProvChip, Section, Spinner } from "./ui";

export function IdentityLine({ state }: { state: WorkspaceState }) {
  if (state.identityState === "idle") return null;
  if (state.identityState === "loading")
    return (
      <div style={{ fontSize: 12.5 }}>
        <Spinner label="Looking up SIMBAD and Gaia…" />
      </div>
    );
  const id = state.identity;
  return (
    <div className="flex items-start gap-1.5" style={{ fontSize: 12.5 }}>
      <MapPin size={13} className="mt-0.5 flex-none text-accent" />
      <span className={id?.nearest ? "text-ink" : "text-ink2"}>{id ? id.label : "Catalogues did not answer; position kept as typed."}</span>
    </div>
  );
}

function EpochSection({ tag, view, manifest, index }: { tag: "A" | "B"; view: ViewResponse; manifest: Manifest; index: number }) {
  const e = view.epochs[index];
  if (!e) return null;
  const frames = e.members.map((i) => manifest.frames[i]).filter(Boolean);
  const col = tag === "A" ? "var(--ref)" : "var(--sel)";
  return (
    <Section
      title={
        <span>
          <b style={{ color: col }}>{tag}</b> · {e.label}
        </span>
      }
    >
      <KV k="Dates" v={`${fmtDate(e.mjd_start)} → ${fmtDate(e.mjd_end)}`} />
      <KV k="Exposures" v={e.n_frames} />
      <KV k="Detectors" v={e.detectors.join(", ") || "–"} />
      <KV k="Wavelengths" v={e.wavelength_um ? `${e.wavelength_um[0].toFixed(2)}–${e.wavelength_um[1].toFixed(2)} µm` : "–"} />
      <KV k="Flags at target" v={e.flags_at_target.length ? e.flags_at_target.join(", ") : "none"} mono={false} />
      <KV k="Coverage" v={`${Math.round(e.coverage * 100)} %`} />
      <details className="mt-1">
        <summary className="link cursor-pointer" style={{ fontSize: 12.5 }}>
          IRSA source files ({frames.length})
        </summary>
        <ul className="m-0 mt-1 max-h-36 list-none space-y-0.5 overflow-y-auto p-0 pr-1">
          {frames.map((f) => (
            <li key={f.index} style={{ fontSize: 11.5 }}>
              <a href={f.url} target="_blank" rel="noreferrer" className="link num inline-flex items-center gap-1" title={f.file_name}>
                <ExternalLink size={10} />D{f.detector} · {fmtDate(f.mjd)} · {f.wavelength_um ? `${f.wavelength_um.toFixed(3)} µm` : "–"}
              </a>
              {f.flags_at_target.filter((x) => x !== "SOURCE").length > 0 && <span className="ml-1 text-warn">⚠ {f.flags_at_target.filter((x) => x !== "SOURCE").join(", ")}</span>}
            </li>
          ))}
        </ul>
      </details>
    </Section>
  );
}

export function Inspector({ open, onClose, state, view, manifest, movers, moversLoading, gaia, simbad, onAddMover }: { open: boolean; onClose: () => void; state: WorkspaceState; view: ViewResponse; manifest: Manifest; movers: MoversResponse | null; moversLoading: boolean; gaia: OverlayResponse | null; simbad: OverlayResponse | null; onAddMover?: (i: number) => void }) {
  const { view: v } = useView();
  if (!open) return null;
  const t = state.target;
  const tm = manifest.timings_s;
  return (
    <aside className="panel absolute bottom-3 right-3 top-3 z-20 flex w-[330px] max-w-[calc(100%-24px)] flex-col overflow-hidden" aria-label="Inspector">
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <span style={{ fontWeight: 700 }}>Inspector</span>
        <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close inspector" title="Close inspector">
          <PanelRightClose size={15} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {t && (
          <Section title="Target" right={<ProvChip kind={state.identity?.nearest ? "catalogue" : "irsa"} />}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{t.name ?? "Sky position"}</div>
            <CoordTable ra={t.ra} dec={t.dec} />
            {(t.pmra || t.pmdec) && <KV k="Proper motion" v={`${(Math.hypot(t.pmra ?? 0, t.pmdec ?? 0) / 1000).toFixed(2)}″/yr`} />}
            <div className="mt-1">
              <IdentityLine state={state} />
            </div>
          </Section>
        )}
        <Section title={`Movers A → B`} right={<ProvChip kind="derived" />}>
          {v.a === v.b ? (
            <p className="m-0 text-ink2" style={{ fontSize: 12.5 }}>
              Pick two different epochs: click = B, shift-click = A.
            </p>
          ) : moversLoading || !movers ? (
            <Spinner label="Finding movers and naming them…" />
          ) : movers.pairs.length === 0 ? (
            <p className="m-0 text-ink2" style={{ fontSize: 12.5 }}>
              No mover above 5σ between {view.epochs[v.a]?.label} and {view.epochs[v.b]?.label}
              {v.band === "all" ? ". Try a single detector: faint red objects show best at 4–5 µm (detectors 5–6)." : "."}
            </p>
          ) : (
            <ul className="m-0 list-none space-y-2 p-0">
              {movers.pairs.slice(0, 10).map((p, i) => {
                const named = p.identified !== false && !!p.name && !p.name.startsWith("Unidentified");
                return (
                  <li key={i} className="border-l-2 pl-2" style={{ borderColor: named ? "var(--mover)" : "var(--mover-unknown)" }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: named ? "var(--ink)" : "var(--warn)" }}>{p.name ?? "Unidentified candidate"}</div>
                    <div className="num" style={{ fontSize: 12 }}>
                      measured {p.shift_arcsec.toFixed(1)}″{p.expected_shift_arcsec != null && <>, catalogue {p.expected_shift_arcsec.toFixed(1)}″</>} · PA {p.pa_deg.toFixed(0)}°
                    </div>
                    <div style={{ fontSize: 12 }} className={p.matches_catalogue ? "text-ok" : "text-ink3"}>
                      {p.matches_catalogue ? "✓ matches catalogue motion" : named ? `differs from catalogue by ${(p.motion_disagreement_arcsec ?? 0).toFixed(1)}″` : "no SIMBAD / Gaia DR3 match"}
                      {p.saturated ? " · saturated star" : ""}
                    </div>
                    <div className="num text-ink3" style={{ fontSize: 11.5 }}>
                      {p.significance.toFixed(1)}σ{p.rate_arcsec_per_yr !== undefined ? ` · ${p.rate_arcsec_per_yr.toFixed(1)}″/yr` : ""}
                      {p.catalogue ? ` · ${p.catalogue}` : ""}
                    </div>
                    {!named && <UnidentifiedNote className="mt-0.5" />}
                    {onAddMover && (
                      <button className="link mt-0.5 cursor-pointer border-0 bg-transparent p-0" style={{ fontSize: 12 }} onClick={() => onAddMover(i)}>
                        + Add to Discovery Log
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {movers?.catalogue_errors && Object.keys(movers.catalogue_errors).length > 0 && (
            <p className="mb-0 mt-1 text-warn" style={{ fontSize: 11.5 }}>
              Catalogue not reachable: {Object.keys(movers.catalogue_errors).join(", ")}. Names may be missing.
            </p>
          )}
          <p className="mb-0 mt-1.5 text-ink3" style={{ fontSize: 11.5 }}>
            Candidates, not discoveries. Names: SIMBAD ≤ 8″ or Gaia DR3 ≤ 6″, proper motion applied.
          </p>
        </Section>
        <EpochSection tag="B" view={view} manifest={manifest} index={v.b} />
        {v.a !== v.b && <EpochSection tag="A" view={view} manifest={manifest} index={v.a} />}
        <Section title="Set" right={<ProvChip kind="irsa" />}>
          <KV k="Collection" v={manifest.collections.join(", ")} />
          <KV k="Field" v={`${manifest.grid.fov_arcmin}′ · ${manifest.grid.n}² px of ${manifest.grid.pix_arcsec.toFixed(2)}″`} />
          <KV k="Exposures" v={`${manifest.counts.kept} used / ${manifest.counts.search_results} found`} />
          <KV k="Band view" v={view.band === "all" ? `detectors ${view.detectors_used.join(",")}` : `detector ${view.band}`} />
          {view.detectors_excluded.length > 0 && <KV k="Left out" v={`${view.detectors_excluded.join(",")} (missing in an epoch)`} />}
          {(gaia || simbad) && <KV k="Catalogue markers" v={`${simbad ? `${simbad.count} SIMBAD` : ""}${gaia && simbad ? " · " : ""}${gaia ? `${gaia.count} Gaia` : ""}`} />}
          <details className="mt-1">
            <summary className="link cursor-pointer" style={{ fontSize: 12.5 }}>
              Pipeline timings
            </summary>
            {Object.entries(tm).map(([k, s]) => (
              <KV key={k} k={k} v={`${s.toFixed(s < 10 ? 2 : 1)} s`} />
            ))}
          </details>
          {manifest.skipped.length > 0 && (
            <details className="mt-1">
              <summary className="link cursor-pointer" style={{ fontSize: 12.5 }}>
                Skipped frames ({manifest.skipped.length})
              </summary>
              {manifest.skipped.map((s, i) => (
                <div key={i} className="text-ink2" style={{ fontSize: 11.5 }}>
                  D{s.detector} · {fmtDate(s.mjd)}: {s.reason}
                </div>
              ))}
            </details>
          )}
        </Section>
      </div>
    </aside>
  );
}
