import { Check, ChevronsLeft, ChevronsRight, Copy, Hammer, Link2, Search } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api, type TargetInfo } from "../api/client";
import { useHealth } from "../hooks/useHealth";
import { embedCode, shareUrl } from "../lib/url";
import { useWorkspace, type Target } from "../state/workspace";
import { IdentityLine } from "./Inspector";
import { CoordTable, KV, Section, cx } from "./ui";

export const FIELD_SIZES = [2, 3, 4, 5, 6, 8, 10, 15, 20];

let targetsCache: TargetInfo[] | null = null;

/** The 5 test targets; fetched again as soon as the backend comes back online. */
export function useTargets() {
  const { online } = useHealth();
  const [targets, setTargets] = useState<TargetInfo[]>(targetsCache ?? []);
  useEffect(() => {
    if (targetsCache?.length) return setTargets(targetsCache);
    if (online === false) return;
    api
      .targets()
      .then((r) => {
        targetsCache = r.targets;
        setTargets(r.targets);
      })
      .catch(() => setTargets([]));
  }, [online]);
  return targets;
}

export function targetFromInfo(t: TargetInfo): Target {
  return {
    name: t.name,
    ra: t.today.ra,
    dec: t.today.dec,
    pmra: t.pmra,
    pmdec: t.pmdec,
    epoch: t.epoch,
    catRa: t.ra,
    catDec: t.dec,
    source: "built-in target · proper motion applied to today",
    kind: t.kind,
  };
}

export function CommandPanel({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const ws = useWorkspace();
  const { state, load, rebuild, setFov } = ws;
  const targets = useTargets();
  const [text, setText] = useState("");
  const [copied, setCopied] = useState<"link" | "embed" | null>(null);
  const t = state.target;
  const busy = state.phase === "resolving" || state.phase === "building";

  if (collapsed) {
    return (
      <button className="btn absolute left-3 top-3 z-20" onClick={onToggle} aria-label="Open command panel" style={{ boxShadow: "0 4px 14px rgba(0,0,0,.25)" }}>
        <ChevronsRight size={14} />
        {t?.name ?? "Target"}
      </button>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) load({ query: text.trim() });
  };
  const copy = async (what: "link" | "embed") => {
    if (!t) return;
    const value = what === "link" ? shareUrl(t, state.fov) : embedCode(t, state.fov);
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      window.prompt("Copy this:", value);
    }
    setCopied(what);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <aside className="panel absolute bottom-3 left-3 top-3 z-20 flex w-[300px] max-w-[calc(100%-24px)] flex-col overflow-hidden" aria-label="Command panel">
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <span style={{ fontWeight: 700 }}>Target</span>
        <button className="btn btn-ghost btn-icon" onClick={onToggle} aria-label="Collapse command panel" title="Collapse">
          <ChevronsLeft size={15} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Current target">
          {t ? (
            <>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{t.name ?? "Sky position"}</div>
              <CoordTable ra={t.ra} dec={t.dec} />
              {(t.pmra || t.pmdec) && <KV k="Proper motion" v={`${(Math.hypot(t.pmra ?? 0, t.pmdec ?? 0) / 1000).toFixed(2)}″/yr`} />}
              <div className="mt-1 text-ink3" style={{ fontSize: 11.5 }}>
                {t.source}
              </div>
              <div className="mt-1.5">
                <IdentityLine state={state} />
              </div>
            </>
          ) : state.phase === "resolving" ? (
            <div className="text-ink2">Resolving “{state.query}”…</div>
          ) : (
            <div className="text-ink2">No target yet. Search, pick a test object, or click the sky map.</div>
          )}
        </Section>

        <Section title="Search">
          <form onSubmit={submit} className="flex gap-1.5" role="search">
            <label className="sr-only" htmlFor="target-search">
              Name or coordinates
            </label>
            <input id="target-search" className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, or RA Dec" spellCheck={false} />
            <button className="btn btn-primary btn-icon" type="submit" disabled={!text.trim()} aria-label="Search">
              <Search size={15} />
            </button>
          </form>
          <p className="mb-0 mt-1 text-ink3" style={{ fontSize: 11.5 }}>
            e.g. Barnard&rsquo;s Star · 08 55 10.8 −07 14 42 · 133.795 −7.245
          </p>
        </Section>

        <Section title="Test objects">
          <ul className="-mx-1 m-0 list-none space-y-0.5 p-0">
            {targets.map((tg) => (
              <li key={tg.id}>
                <button onClick={() => load({ target: targetFromInfo(tg), fov: tg.fov_arcmin })} className={cx("w-full rounded px-2 py-1.5 text-left hover:bg-s2", t?.name === tg.name && "bg-s2")} style={{ border: t?.name === tg.name ? "1px solid var(--accent)" : "1px solid transparent", cursor: "pointer", background: undefined }}>
                  <div className="flex items-center justify-between gap-2">
                    <span style={{ fontWeight: 600 }}>{tg.name}</span>
                    <span className="num" style={{ fontSize: 11, color: tg.kind === "moving" ? "var(--warn)" : "var(--accent)" }}>
                      {tg.kind === "moving" ? `${tg.pm_total_arcsec_yr.toFixed(1)}″/yr` : "variable"}
                    </span>
                  </div>
                  <div className="truncate text-ink3" style={{ fontSize: 11.5 }}>
                    {tg.note}
                  </div>
                </button>
              </li>
            ))}
            {!targets.length && <li className="text-ink3">Loading from the backend…</li>}
          </ul>
        </Section>

        <Section title="Field">
          <div className="flex items-center gap-2">
            <select className="field" style={{ width: 90 }} value={state.fov} onChange={(e) => setFov(Number(e.target.value))} aria-label="Field size">
              {FIELD_SIZES.map((f) => (
                <option key={f} value={f}>
                  {f}′
                </option>
              ))}
            </select>
            <button className="btn btn-primary flex-1" onClick={rebuild} disabled={!t || busy} title="Build this field with the chosen size">
              <Hammer size={14} />
              Build
            </button>
          </div>
          <p className="mb-0 mt-1 text-ink3" style={{ fontSize: 11.5 }}>
            Bigger fields catch faster movers but take longer to download.
          </p>
        </Section>

        <Section title="Share">
          <div className="flex flex-col gap-1.5">
            <button className="btn justify-start" onClick={() => copy("link")} disabled={!t}>
              {copied === "link" ? <Check size={14} /> : <Link2 size={14} />}
              Copy shareable link
            </button>
            <button className="btn justify-start" onClick={() => copy("embed")} disabled={!t}>
              {copied === "embed" ? <Check size={14} /> : <Copy size={14} />}
              Copy embed code
            </button>
          </div>
        </Section>
      </div>
      <footer className="border-t border-line px-3 py-1.5 text-ink3" style={{ fontSize: 11.5 }}>
        Rings are candidates, not discoveries.
      </footer>
    </aside>
  );
}
