import { useEffect, useState } from "react";
import { api, apiUrl } from "../api/client";
import { Banner, Panel } from "../components/ui";
import { formatDeg, formatDec, formatRA } from "../lib/coords";
import { useSettings, type CoordFormat, type RenderScale, type Theme } from "../state/settings";
import { useWorkspace } from "../state/workspace";

const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: "light", label: "Light", hint: "NASA/IRSA style (default)" },
  { id: "dark", label: "Dark", hint: "Observatory" },
  { id: "slate", label: "Slate", hint: "Mid grey, easy on the eyes" },
  { id: "night", label: "Night", hint: "Red only, keeps dark adaptation at the telescope" },
];
const SCALES: { id: RenderScale; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: 2, label: "2×" },
  { id: 4, label: "4×" },
  { id: 8, label: "8×" },
];

export default function SettingsPage() {
  const { settings, update } = useSettings();
  const { state, setOptions } = useWorkspace();
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [msg, setMsg] = useState<{ tone: "info" | "bad"; text: string } | null>(null);
  const [base, setBase] = useState(settings.apiBaseUrl);
  const [test, setTest] = useState<string | null>(null);

  useEffect(() => {
    api.cacheStats().then(setStats).catch(() => setStats(null));
  }, [msg, settings.apiBaseUrl]);
  const ns = (stats?.disk as { namespaces?: Record<string, { bytes?: number }> } | undefined)?.namespaces;
  const disk = ns ? Object.values(ns).reduce((a, x) => a + (x.bytes ?? 0), 0) : undefined;
  const redis = (stats?.redis as { status?: string } | undefined)?.status;

  const testBase = async () => {
    const url = (base.trim().replace(/\/+$/, "") || "") + "/api/health";
    setTest("Testing…");
    const t0 = performance.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const j = await r.json();
      setTest(r.ok ? `OK · ${Math.round(performance.now() - t0)} ms · Redis ${j.redis}` : `HTTP ${r.status}`);
    } catch (e) {
      setTest(`Not reachable (${(e as Error).message})`);
    }
  };

  const clear = async (scope: "renders" | "searches" | "all") => {
    if (scope === "all" && !window.confirm("Clear EVERYTHING, including downloaded SPHEREx cutouts? The next look at every field downloads again.")) return;
    try {
      const r = (await fetch(apiUrl(`/api/cache/clear?scope=${scope}`), { method: "POST" }).then((x) => x.json())) as { redis_keys_deleted?: number; disk_files_deleted?: number };
      setMsg({ tone: "info", text: `Cleared ${scope}: ${r.disk_files_deleted ?? 0} files on disk, ${r.redis_keys_deleted ?? 0} Redis keys.` });
    } catch (e) {
      setMsg({ tone: "bad", text: `Could not clear: ${(e as Error).message}` });
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 px-6 py-8">
        <h1 className="h1 m-0" style={{ fontSize: 28 }}>
          Settings
        </h1>

        <Panel title="Backend (API base URL)">
          <div className="flex flex-wrap gap-2">
            <input className="field num" style={{ flex: "1 1 280px" }} value={base} onChange={(e) => setBase(e.target.value)} placeholder="empty = this site (dev proxy), e.g. http://127.0.0.1:8000" spellCheck={false} aria-label="API base URL" />
            <button className="btn" onClick={testBase}>
              Test
            </button>
            <button className="btn btn-primary" onClick={() => update("apiBaseUrl", base.trim())} disabled={base.trim() === settings.apiBaseUrl}>
              Save
            </button>
          </div>
          {test && (
            <p className="num mb-0 mt-1.5" style={{ fontSize: 12.5 }}>
              {test}
            </p>
          )}
          <p className="mb-0 mt-1.5 text-ink3" style={{ fontSize: 12.5 }}>
            Leave empty when the page is served with the backend. A different host must allow this site in its CORS_ORIGINS.
          </p>
        </Panel>

        <Panel title="Appearance">
          <div className="seg" role="group" aria-label="Theme">
            {THEMES.map((t) => (
              <button key={t.id} aria-pressed={settings.theme === t.id} onClick={() => update("theme", t.id)} title={t.hint}>
                {t.label}
              </button>
            ))}
          </div>
          <p className="mb-0 mt-1.5 text-ink3" style={{ fontSize: 12.5 }}>
            {THEMES.find((t) => t.id === settings.theme)?.hint}. Sky images always stay on black.
          </p>
          <label className="mt-3 flex items-center gap-2">
            <input type="checkbox" checked={settings.showProvenance} onChange={(e) => update("showProvenance", e.target.checked)} />
            Show data-source chips on panels (images always keep theirs)
          </label>
          <label className="mt-1 flex items-center gap-2">
            <input type="checkbox" checked={settings.reduceMotion} onChange={(e) => update("reduceMotion", e.target.checked)} />
            Reduce animations
          </label>
        </Panel>

        <Panel title="Coordinates">
          <div className="seg" role="group" aria-label="Coordinate format shown first">
            {(["sexagesimal", "degrees"] as CoordFormat[]).map((f) => (
              <button key={f} aria-pressed={settings.coordFormat === f} onClick={() => update("coordFormat", f)}>
                {f === "sexagesimal" ? "Sexagesimal first" : "Degrees first"}
              </button>
            ))}
          </div>
          <p className="num mb-0 mt-1.5 text-ink2" style={{ fontSize: 12.5 }}>
            {settings.coordFormat === "degrees" ? `RA ${formatDeg(133.795129)} (${formatRA(133.795129)})  Dec ${formatDeg(-7.245147)} (${formatDec(-7.245147)})` : `RA ${formatRA(133.795129)} (${formatDeg(133.795129)})  Dec ${formatDec(-7.245147)} (${formatDeg(-7.245147)})`}
          </p>
          <p className="mb-0 mt-1 text-ink3" style={{ fontSize: 12.5 }}>
            Both forms are always shown; this only sets which comes first.
          </p>
        </Panel>

        <Panel title="Images">
          <div className="cap mb-1">Render resolution (PNG upscale from the backend)</div>
          <div className="seg" role="group" aria-label="Render resolution">
            {SCALES.map((s) => (
              <button key={String(s.id)} aria-pressed={settings.renderScale === s.id} onClick={() => update("renderScale", s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          <p className="mb-3 mt-1 text-ink3" style={{ fontSize: 12.5 }}>
            Auto picks about 512 pixels across. Higher is crisper when zoomed in but downloads more.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="cap">Sharpness of new sets (upsample)</span>
              <select className="field mt-1" value={state.upsample} onChange={(e) => setOptions({ upsample: Number(e.target.value) })}>
                <option value={1}>1× native 6.2″ pixels (fastest)</option>
                <option value={2}>2× (default)</option>
                <option value={4}>4× sharper, slower</option>
              </select>
            </label>
            <label className="block">
              <span className="cap">Frames per set</span>
              <select className="field mt-1" value={state.maxFrames} onChange={(e) => setOptions({ maxFrames: Number(e.target.value) })}>
                {[24, 40, 60, 90].map((n) => (
                  <option key={n} value={n}>
                    {n}
                    {n === 40 ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Panel>

        <Panel title="Cache">
          <p className="m-0">
            Redis: <span className="num">{redis ?? "–"}</span> · Disk: <span className="num">{disk !== undefined ? `${(disk / 1e6).toFixed(1)} MB` : "–"}</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button className="btn btn-danger" onClick={() => clear("renders")}>
              Clear rendered images
            </button>
            <button className="btn btn-danger" onClick={() => clear("searches")}>
              Clear IRSA searches
            </button>
            <button className="btn btn-danger" onClick={() => clear("all")}>
              Clear everything
            </button>
          </div>
          {msg && (
            <div className="mt-2">
              <Banner tone={msg.tone}>{msg.text}</Banner>
            </div>
          )}
        </Panel>

        <Panel title="Data sources">
          <ul className="m-0 space-y-1 pl-4 text-ink2">
            <li>
              Images: NASA SPHEREx, collection spherex_dr1, from the{" "}
              <a className="link" href="https://irsa.ipac.caltech.edu/Missions/spherex.html" target="_blank" rel="noreferrer">
                NASA/IPAC Infrared Science Archive
              </a>
              .
            </li>
            <li>Names and objects: CDS Sesame and SIMBAD (CDS, Harvard mirror).</li>
            <li>Stars: Gaia DR3 (ESA, VizieR, IRSA).</li>
            <li>Sky map: Aladin Lite (CDS) with DSS2, AllWISE and 2MASS tiles served by IRSA.</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}
