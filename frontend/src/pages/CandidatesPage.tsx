import { Download, MapPin, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { Banner, CoordTable, KV, Panel, ProvChip, Spinner, cx } from "../components/ui";
import { fmtDate, formatDec, formatDeg, formatRA, parseDecInput, parseRAInput } from "../lib/coords";
import { explorerPath } from "../lib/url";
import { derivedMotion, useCandidates, type CandStatus, type Candidate } from "../state/candidates";

const STATUS: { id: CandStatus; label: string; color: string }[] = [
  { id: "unvalidated", label: "Unvalidated", color: "var(--warn)" },
  { id: "catalogued", label: "Catalogued", color: "var(--ok)" },
  { id: "rejected", label: "Rejected", color: "var(--ink-3)" },
];

function toCsv(list: Candidate[]): string {
  const head = ["label", "status", "ra_deg", "dec_deg", "ra_hms", "dec_dms", "n_measurements", "pmra_mas_yr", "pmdec_mas_yr", "baseline_days", "notes"];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = list.map((c) => {
    const m = derivedMotion(c.measurements);
    return [c.label, c.status, c.ra.toFixed(6), c.dec.toFixed(6), formatRA(c.ra), formatDec(c.dec), c.measurements.length, m?.pmra.toFixed(0) ?? "", m?.pmdec.toFixed(0) ?? "", m?.baselineDays.toFixed(1) ?? "", c.notes].map(esc).join(",");
  });
  return [`# COSMIC Space Blink AI Discovery Log. Candidates, not discoveries. Positions from NASA SPHEREx (IRSA).`, head.join(","), ...rows].join("\n");
}

function Detail({ c }: { c: Candidate }) {
  const { update, remove, removeMeasurement, addMeasurement, activeId, setActive } = useCandidates();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mRa, setMRa] = useState("");
  const [mDec, setMDec] = useState("");
  const [mDate, setMDate] = useState("");
  const motion = derivedMotion(c.measurements);

  const xmatch = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.identify(c.ra, c.dec, 10);
      update(c.id, { xmatch: { at: new Date().toISOString(), label: r.label, nearest: r.nearest, gaia: r.gaia_nearest } });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const ra = parseRAInput(mRa);
  const dec = parseDecInput(mDec);
  const mjd = mDate ? Date.parse(mDate) / 86400000 + 40587 : NaN;
  const canAdd = ra.deg !== null && dec.deg !== null && Number.isFinite(mjd);

  return (
    <div className="space-y-4">
      <Panel
        title="Candidate"
        right={
          <span className="flex items-center gap-2">
            <ProvChip kind="derived" />
            <button className="btn btn-danger" style={{ height: 26 }} onClick={() => window.confirm(`Delete “${c.label}”?`) && remove(c.id)}>
              <Trash2 size={13} />
              Delete
            </button>
          </span>
        }
      >
        <label className="block">
          <span className="cap">Label</span>
          <input className="field mt-1" value={c.label} onChange={(e) => update(c.id, { label: e.target.value })} />
        </label>
        <div className="mt-3">
          <span className="cap">Status (your call)</span>
          <div className="seg mt-1">
            {STATUS.map((s) => (
              <button key={s.id} aria-pressed={c.status === s.id} onClick={() => update(c.id, { status: s.id })}>
                <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 7, background: s.color, marginRight: 6 }} />
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <div>
            <div className="cap mb-1">Latest position</div>
            <CoordTable ra={c.ra} dec={c.dec} />
            <div className="mt-2 flex flex-wrap gap-2">
              <Link className="btn" to={explorerPath({ ra: c.ra, dec: c.dec, fov: 4 })}>
                Open in Blink Explorer
              </Link>
              <button className={cx("btn", activeId === c.id && "btn-primary")} onClick={() => setActive(activeId === c.id ? null : c.id)} title="The Measure tool in the Blink Explorer adds positions to the active candidate">
                <MapPin size={14} />
                {activeId === c.id ? "Active for Measure" : "Make active for Measure"}
              </button>
            </div>
          </div>
          <div>
            <div className="cap mb-1">Origin</div>
            <div className="text-ink2" style={{ fontSize: 13 }}>
              {c.origin}
            </div>
            <div className="text-ink3" style={{ fontSize: 12 }}>
              Created {c.created.slice(0, 16).replace("T", " ")} UTC
            </div>
            {c.mover && (
              <div className="mt-1 text-ink2" style={{ fontSize: 13 }}>
                Mover: {c.mover.shift_arcsec.toFixed(1)}″ at PA {c.mover.pa_deg.toFixed(0)}° ({c.mover.significance.toFixed(1)}σ)
                {c.mover.expected_shift_arcsec != null && <>, catalogue {c.mover.expected_shift_arcsec.toFixed(1)}″{c.mover.matches_catalogue ? " ✓" : ""}</>}
              </div>
            )}
          </div>
        </div>
        <label className="mt-3 block">
          <span className="cap">Notes</span>
          <textarea className="field mt-1" style={{ height: 90, padding: 8 }} value={c.notes} onChange={(e) => update(c.id, { notes: e.target.value })} placeholder="What you saw, in which band, what you checked…" />
        </label>
      </Panel>

      <Panel title={`Measurements (${c.measurements.length})`}>
        {c.measurements.length === 0 ? (
          <p className="m-0 text-ink2">No positions yet. In the Blink Explorer, make this candidate active, switch on Measure and click the object in each epoch.</p>
        ) : (
          <table className="w-full border-collapse" style={{ fontSize: 12.5 }}>
            <thead className="text-left text-ink3">
              <tr>
                <th className="pb-1 pr-2">Date</th>
                <th className="pb-1 pr-2">RA</th>
                <th className="pb-1 pr-2">Dec</th>
                <th className="pb-1 pr-2">Source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {c.measurements.map((m) => (
                <tr key={m.id} className="border-t border-line">
                  <td className="num py-1 pr-2">{fmtDate(m.mjd)}</td>
                  <td className="num pr-2">
                    {formatRA(m.ra)} <span className="text-ink3">({formatDeg(m.ra)})</span>
                  </td>
                  <td className="num pr-2">
                    {formatDec(m.dec)} <span className="text-ink3">({formatDeg(m.dec)})</span>
                  </td>
                  <td className="pr-2 text-ink2">{m.source}</td>
                  <td className="text-right">
                    <button className="btn btn-ghost btn-icon" aria-label="Remove measurement" onClick={() => removeMeasurement(c.id, m.id)}>
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <details className="mt-2">
          <summary className="link cursor-pointer" style={{ fontSize: 12.5 }}>
            Add a position by hand
          </summary>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label>
              <span className="cap">Date (UTC)</span>
              <input type="date" className="field mt-1" value={mDate} onChange={(e) => setMDate(e.target.value)} />
            </label>
            <label>
              <span className="cap">RA</span>
              <input className="field num mt-1" style={{ width: 150 }} value={mRa} onChange={(e) => setMRa(e.target.value)} placeholder="08 55 10.8" aria-invalid={!!mRa && !!ra.error} />
            </label>
            <label>
              <span className="cap">Dec</span>
              <input className="field num mt-1" style={{ width: 150 }} value={mDec} onChange={(e) => setMDec(e.target.value)} placeholder="-07 14 42" aria-invalid={!!mDec && !!dec.error} />
            </label>
            <button
              className="btn btn-primary"
              disabled={!canAdd}
              onClick={() => {
                addMeasurement(c.id, { mjd, ra: ra.deg!, dec: dec.deg!, source: "typed by hand" });
                setMRa("");
                setMDec("");
              }}
            >
              <Plus size={14} /> Add
            </button>
          </div>
        </details>
        <div className="mt-3 rounded border border-line p-2.5" style={{ background: "var(--surface-1)" }}>
          <div className="cap">Derived proper motion</div>
          {motion ? (
            <div className="num mt-0.5" style={{ fontSize: 13 }}>
              μ = {(motion.total / 1000).toFixed(2)}″/yr toward PA {motion.pa.toFixed(0)}° (μα* {motion.pmra.toFixed(0)}, μδ {motion.pmdec.toFixed(0)} mas/yr) from {motion.n} positions over {motion.baselineDays.toFixed(0)} days
            </div>
          ) : (
            <div className="text-ink2" style={{ fontSize: 13 }}>
              Needs at least 2 positions on different dates.
            </div>
          )}
          <div className="text-ink3" style={{ fontSize: 11.5 }}>
            Straight-line fit, no parallax. Positions from difference peaks or clicks are good to about a pixel (6.2″ native); treat short baselines with care.
          </div>
        </div>
      </Panel>

      <Panel title="Cross-match" right={<ProvChip kind="catalogue" />}>
        <button className="btn btn-primary" onClick={xmatch} disabled={busy}>
          <Search size={14} />
          Check SIMBAD + Gaia (10″)
        </button>
        {busy && (
          <span className="ml-2">
            <Spinner label="Asking the catalogues…" />
          </span>
        )}
        {err && (
          <div className="mt-2">
            <Banner tone="bad">{err}</Banner>
          </div>
        )}
        {c.xmatch && (
          <div className="mt-2" style={{ fontSize: 13 }}>
            <div>{c.xmatch.label}</div>
            {c.xmatch.nearest && <KV k="Nearest" v={`${c.xmatch.nearest.name} · ${c.xmatch.nearest.catalogue} · ${c.xmatch.nearest.distance_arcsec.toFixed(1)}″`} />}
            {c.xmatch.gaia && <KV k="Gaia DR3" v={`${c.xmatch.gaia.id} · ${c.xmatch.gaia.distance_arcsec?.toFixed(1)}″${c.xmatch.gaia.mag != null ? ` · G ${c.xmatch.gaia.mag.toFixed(1)}` : ""}`} />}
            <div className="text-ink3" style={{ fontSize: 11.5 }}>
              Checked {c.xmatch.at.slice(0, 16).replace("T", " ")} UTC with proper motions applied to today. Setting the status is up to you.
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

export default function CandidatesPage() {
  const { list, add } = useCandidates();
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState<CandStatus | "all">("all");
  const shown = list.filter((c) => filter === "all" || c.status === filter);
  const current = list.find((c) => c.id === sel) ?? shown[0] ?? null;

  const exportCsv = () => {
    const blob = new Blob([toCsv(list)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cosmic_discovery_log.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1250px] space-y-4 px-5 py-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="h1 m-0" style={{ fontSize: 26 }}>
              Discovery Log
            </h1>
            <div className="text-ink2">Candidates you flagged, kept in this browser. Candidates, not discoveries.</div>
          </div>
          <div className="flex gap-2">
            <button className="btn" onClick={() => setSel(add({ label: "New candidate", ra: 0, dec: 0, origin: "added by hand" }))}>
              <Plus size={14} />
              New
            </button>
            <button className="btn" onClick={exportCsv} disabled={!list.length}>
              <Download size={14} />
              Export CSV
            </button>
          </div>
        </div>
        {list.length === 0 ? (
          <Banner tone="info" title="The log is empty" action={<Link className="btn btn-primary" to="/explorer">Open Blink Explorer</Link>}>
            In the Blink Explorer, click any mover ring (or “Add to Discovery Log” in the inspector) to keep it here. The Measure tool adds positions on other dates.
          </Banner>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
            <div className="panel overflow-hidden">
              <div className="seg m-2" style={{ display: "flex" }}>
                {(["all", ...STATUS.map((s) => s.id)] as const).map((f) => (
                  <button key={f} className="flex-1" aria-pressed={filter === f} onClick={() => setFilter(f)} style={{ padding: "0 6px" }}>
                    {f === "all" ? `All (${list.length})` : `${STATUS.find((s) => s.id === f)!.label} (${list.filter((c) => c.status === f).length})`}
                  </button>
                ))}
              </div>
              <ul className="m-0 max-h-[70vh] list-none overflow-y-auto p-0">
                {shown.map((c) => {
                  const st = STATUS.find((s) => s.id === c.status)!;
                  const m = derivedMotion(c.measurements);
                  return (
                    <li key={c.id}>
                      <button onClick={() => setSel(c.id)} className="w-full cursor-pointer border-0 border-t border-line px-3 py-2 text-left" style={{ background: current?.id === c.id ? "var(--surface-2)" : "transparent" }}>
                        <div className="flex items-center justify-between gap-2">
                          <span style={{ fontWeight: 600 }}>{c.label}</span>
                          <span style={{ fontSize: 11, color: st.color }}>{st.label}</span>
                        </div>
                        <div className="num text-ink3" style={{ fontSize: 11.5 }}>
                          {formatRA(c.ra)} {formatDec(c.dec)}
                        </div>
                        <div className="text-ink3" style={{ fontSize: 11.5 }}>
                          {c.measurements.length} position{c.measurements.length === 1 ? "" : "s"}
                          {m ? ` · μ ${(m.total / 1000).toFixed(2)}″/yr` : ""}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            {current && <Detail key={current.id} c={current} />}
          </div>
        )}
      </div>
    </div>
  );
}
