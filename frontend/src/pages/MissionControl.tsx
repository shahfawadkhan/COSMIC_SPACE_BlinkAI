import { ArrowRight, Loader2, MapPin, Search } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Identify } from "../api/client";
import { AladinMap, SURVEYS, type SurveyId } from "../components/AladinMap";
import { useTargets } from "../components/CommandPanel";
import { formatDec, formatDeg, formatRA, parseDecInput, parseRAInput, splitCoordPair } from "../lib/coords";
import { explorerPath } from "../lib/url";
import { useWorkspace } from "../state/workspace";

const FIELDS = [2, 3, 4, 5, 6, 8, 10, 15];
const STEPS: [string, string, string][] = [
  ["1", "Choose a place in the sky", "Type a name or RA/Dec, pick a test object, or click the sky map."],
  ["2", "Pick a field of view", "Bigger fields catch faster movers but take longer to download."],
  ["3", "Watch it like a video", "Real SPHEREx images of that patch, one frame per survey pass, blinked in place."],
  ["4", "Look for the red rings", "Stars stay put. Things that moved are ringed and named from SIMBAD / Gaia when known."],
];
const DEMO = { name: "Barnard's Star", ra: 269.4521, dec: 4.69336, pmra: -798.58, pmdec: 10328.12, epoch: 2000, fov: 4 };

type Mode = "name" | "coords";

/** Debounced reverse lookup: what is at these coordinates? */
function useIdentify(ra: number | null, dec: number | null) {
  const [state, setState] = useState<{ key: string; data: Identify | null; loading: boolean; error: string | null }>({ key: "", data: null, loading: false, error: null });
  const key = ra !== null && dec !== null ? `${ra.toFixed(5)},${dec.toFixed(5)}` : "";
  useEffect(() => {
    if (!key) return;
    const ctl = new AbortController();
    setState({ key, data: null, loading: true, error: null });
    const t = setTimeout(() => {
      api
        .identify(ra!, dec!, 30, ctl.signal)
        .then((data) => setState({ key, data, loading: false, error: null }))
        .catch((e) => !ctl.signal.aborted && setState({ key, data: null, loading: false, error: (e as Error).message }));
    }, 450);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state.key === key ? state : { key, data: null, loading: !!key, error: null };
}

function CoordBox({ id, label, value, onChange, onPaste, placeholder, parsed, other }: { id: string; label: string; value: string; onChange: (v: string) => void; onPaste?: (e: React.ClipboardEvent<HTMLInputElement>) => void; placeholder: string; parsed: { deg: number | null; error: string | null }; other: string | null }) {
  const err = value.trim() && parsed.error;
  return (
    <div className="min-w-0 flex-1" style={{ flexBasis: 220 }}>
      <label htmlFor={id} className="mb-1 block" style={{ fontSize: 13, fontWeight: 600 }}>
        {label}
      </label>
      <input
        id={id}
        className="field num"
        aria-invalid={!!err}
        aria-describedby={`${id}-hint`}
        style={{ height: 44, fontSize: 15, background: "#fff", color: "#0f1923" }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPaste={onPaste}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
      />
      <div id={`${id}-hint`} className="num mt-1" style={{ fontSize: 12.5, minHeight: 18, color: err ? "#ff8a8f" : "#9fd2a8" }}>
        {err ? parsed.error : other ? `= ${other}` : " "}
      </div>
    </div>
  );
}

export default function MissionControl() {
  const nav = useNavigate();
  const targets = useTargets();
  const { state } = useWorkspace();
  const [mode, setMode] = useState<Mode>("name");
  const [name, setName] = useState("");
  const [raText, setRaText] = useState("");
  const [decText, setDecText] = useState("");
  const [fov, setFov] = useState(4);
  const [survey, setSurvey] = useState<SurveyId>("allwise"); // DSS2 looks almost black at this zoom
  const [mapPos, setMapPos] = useState({ ra: DEMO.ra, dec: DEMO.dec });
  const [mapCentre, setMapCentre] = useState({ ra: DEMO.ra, dec: DEMO.dec });

  const ra = useMemo(() => parseRAInput(raText), [raText]);
  const dec = useMemo(() => parseDecInput(decText), [decText]);
  const coordsOk = ra.deg !== null && dec.deg !== null;
  const ident = useIdentify(mode === "coords" && coordsOk ? ra.deg : null, mode === "coords" && coordsOk ? dec.deg : null);

  // the map follows valid coordinates
  useEffect(() => {
    if (mode === "coords" && ra.deg !== null && dec.deg !== null) setMapPos({ ra: ra.deg, dec: dec.deg });
  }, [mode, ra.deg, dec.deg]);

  // Both values pasted (or dropped / autofilled) into the RA box: split them into the two boxes.
  // Only when several characters arrive at once: while typing, "08 55 10.8 -0" must not split.
  const onRa = (v: string) => {
    const pair = v.length - raText.length > 2 ? splitCoordPair(v) : null;
    if (pair) {
      setRaText(pair[0]);
      setDecText(pair[1]);
    } else setRaText(v);
  };
  const onRaPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pair = splitCoordPair(e.clipboardData.getData("text"));
    if (pair) {
      e.preventDefault();
      setRaText(pair[0]);
      setDecText(pair[1]);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === "name") {
      const t = name.trim();
      if (!t) return;
      const pair = splitCoordPair(t); // coordinates typed in the name box still work
      if (pair) {
        const r = parseRAInput(pair[0]).deg!;
        const d = parseDecInput(pair[1]).deg!;
        nav(explorerPath({ ra: r, dec: d, fov }));
      } else nav(`/explorer?name=${encodeURIComponent(t)}&fov=${fov}&auto=1`);
    } else if (coordsOk) {
      nav(explorerPath({ ra: ra.deg!, dec: dec.deg!, fov }));
    }
  };

  const pickOnMap = (r: number, d: number) => {
    setMode("coords");
    setRaText(formatRA(r).replace(/[hms]/g, "").replace(/\s+/g, " ").trim());
    setDecText(formatDec(d).replace(/[°′″]/g, "").replace(/\s+/g, " ").replace("−", "-").trim());
    setMapPos({ ra: r, dec: d });
  };

  const darkInput = { height: 44, fontSize: 15, background: "#fff", color: "#0f1923" };
  return (
    <div className="h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      <section className="hero-space relative overflow-hidden" style={{ color: "#f2f5f8" }}>
        <div className="hero-stars" aria-hidden />
        <div className="hero-grid relative mx-auto max-w-[1240px] items-start px-6 py-10">
          <div>
            <div style={{ color: "#5db3f0", fontWeight: 600, fontSize: 13 }}>NASA Space Apps 2026 · Planet X and SPHEREx</div>
            <h1 className="h1 mb-3 mt-2" style={{ fontSize: "clamp(30px, 5vw, 46px)" }}>
              See how the infrared sky changes over time.
            </h1>
            <p style={{ fontSize: 17, color: "#c4d0dd", maxWidth: 560 }}>
              Choose a patch of sky and watch real images from NASA&rsquo;s SPHEREx telescope play back like a short film. Brown dwarfs, asteroids and nearby stars give themselves away by moving. We ring them and look up their names.
            </p>

            <form onSubmit={submit} className="mt-6 rounded-lg p-4" style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.16)" }}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="seg" role="group" aria-label="Search by" style={{ background: "rgba(255,255,255,.06)", borderColor: "rgba(255,255,255,.25)" }}>
                  <button type="button" aria-pressed={mode === "name"} onClick={() => setMode("name")} style={{ color: mode === "name" ? "#5db3f0" : "#dfe8f1" }}>
                    Object name
                  </button>
                  <button type="button" aria-pressed={mode === "coords"} onClick={() => setMode("coords")} style={{ color: mode === "coords" ? "#5db3f0" : "#dfe8f1" }}>
                    Coordinates
                  </button>
                </div>
                <select className="field" style={{ height: 34, width: 130, background: "#fff", color: "#0f1923" }} value={fov} onChange={(e) => setFov(+e.target.value)} aria-label="Field of view">
                  {FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {f}′ field
                    </option>
                  ))}
                </select>
              </div>

              {mode === "name" ? (
                <div className="flex flex-wrap gap-2">
                  <label htmlFor="home-name" className="sr-only">
                    Object name
                  </label>
                  <input id="home-name" className="field" style={{ ...darkInput, minWidth: 200, flex: "1 1 260px" }} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Barnard's Star, WISE 0855, RW Aur" spellCheck={false} />
                  <button className="btn btn-primary" style={{ height: 44, padding: "0 20px", fontSize: 15 }} type="submit" disabled={!name.trim()}>
                    <Search size={16} />
                    Search
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-3">
                    <CoordBox id="home-ra" label="RA" value={raText} onChange={onRa} onPaste={onRaPaste} placeholder="08h 55m 10.83s  or  133.7951" parsed={ra} other={ra.deg !== null ? (ra.sexagesimal ? formatDeg(ra.deg) : formatRA(ra.deg)) : null} />
                    <CoordBox id="home-dec" label="Dec" value={decText} onChange={setDecText} placeholder="−07° 14ʹ 42.5″  or  −7.2451" parsed={dec} other={dec.deg !== null ? (dec.sexagesimal ? formatDeg(dec.deg) : formatDec(dec.deg)) : null} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-h-[20px] flex-1" style={{ fontSize: 13 }} aria-live="polite">
                      {!coordsOk ? (
                        <span style={{ color: "#9fb0c3" }}>Each box takes h m s, colons, spaces or degrees. Paste both values into RA to split them.</span>
                      ) : ident.loading ? (
                        <span className="inline-flex items-center gap-1.5" style={{ color: "#c4d0dd" }}>
                          <Loader2 size={13} className="animate-spin" /> Looking up SIMBAD and Gaia…
                        </span>
                      ) : ident.data ? (
                        <span style={{ color: ident.data.nearest ? "#fff" : "#c4d0dd" }}>
                          <MapPin size={13} className="mr-1 inline" style={{ color: "#5db3f0" }} />
                          {ident.data.label}
                        </span>
                      ) : (
                        <span style={{ color: "#c4d0dd" }}>Catalogues unavailable right now ({ident.error}).</span>
                      )}
                    </div>
                    <button className="btn btn-primary" style={{ height: 44, padding: "0 20px", fontSize: 15 }} type="submit" disabled={!coordsOk}>
                      <Search size={16} />
                      Search
                    </button>
                  </div>
                </>
              )}
            </form>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Link to={explorerPath({ ra: DEMO.ra, dec: DEMO.dec, pmra: DEMO.pmra, pmdec: DEMO.pmdec, epoch: DEMO.epoch, fov: DEMO.fov, name: DEMO.name })} className="btn btn-primary" style={{ height: 44, padding: "0 20px", fontSize: 15 }}>
                Watch Barnard's Star move <ArrowRight size={16} />
              </Link>
              {state.target && (
                <Link to="/explorer" className="btn" style={{ height: 44, background: "transparent", color: "#f2f5f8", borderColor: "rgba(255,255,255,.35)" }}>
                  Continue: {state.target.name ?? "last field"}
                </Link>
              )}
            </div>
          </div>

          <div>
            <div className="overflow-hidden rounded-lg" style={{ border: "1px solid rgba(255,255,255,.18)", boxShadow: "0 12px 40px rgba(0,0,0,.45)" }}>
              <AladinMap ra={mapPos.ra} dec={mapPos.dec} viewDeg={Math.max(0.12, (fov / 60) * 3)} fieldArcmin={fov} survey={survey} showSimbad onPick={pickOnMap} onCentre={(r, d) => setMapCentre({ ra: r, dec: d })} style={{ height: 410 }} />
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" style={{ background: "#0c1016", fontSize: 12.5 }}>
                <span className="num" style={{ color: "#c4d0dd" }} title="Centre of the map">
                  RA {formatRA(mapCentre.ra)} ({formatDeg(mapCentre.ra)}) · Dec {formatDec(mapCentre.dec)} ({formatDeg(mapCentre.dec)})
                </span>
                <span className="flex gap-1">
                  {SURVEYS.map((s) => (
                    <button key={s.id} onClick={() => setSurvey(s.id)} className="rounded px-2 py-0.5" aria-pressed={survey === s.id} style={{ border: "1px solid rgba(255,255,255,.25)", background: survey === s.id ? "#5db3f0" : "transparent", color: survey === s.id ? "#06212f" : "#dfe8f1", fontSize: 12, cursor: "pointer" }}>
                      {s.label}
                    </button>
                  ))}
                </span>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2" style={{ fontSize: 12, color: "#9fb0c3" }}>
              <span>Live sky map (Aladin Lite, tiles served by IRSA). Green crosses: SIMBAD. Blue box: the {fov}′ field. Click to pick a position.</span>
              <button type="button" className="link" style={{ background: "none", border: 0, cursor: "pointer", color: "#5db3f0" }} onClick={() => nav(explorerPath({ ra: mapPos.ra, dec: mapPos.dec, fov }))}>
                Build this field →
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1240px] px-6 py-10">
        <h2 className="m-0" style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.01em" }}>
          Test objects from the challenge
        </h2>
        <p className="mb-5 mt-1 text-ink2" style={{ fontSize: 15 }}>
          Five targets named in the NASA brief. Positions are for today: moving ones are shifted with their proper motion.
        </p>
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(215px, 1fr))" }}>
          {targets.map((t) => (
            <article key={t.id} className="card flex flex-col p-4">
              <div className="text-ink3" style={{ fontSize: 12.5, fontWeight: 600 }}>
                {t.kind === "moving" ? "Moving" : "Variable star"}
              </div>
              <h3 className="m-0 mt-0.5" style={{ fontSize: 18, fontWeight: 700 }}>
                {t.name}
              </h3>
              <p className="mb-3 mt-1.5 flex-1 text-ink2" style={{ fontSize: 13.5 }}>
                {t.note}
              </p>
              <dl className="num m-0 mb-3 grid gap-0.5" style={{ fontSize: 12.5 }}>
                <div className="flex justify-between gap-2">
                  <dt className="text-ink3">RA</dt>
                  <dd className="m-0 text-right">
                    {t.today.ra_hms}
                    <div className="text-ink3">{formatDeg(t.today.ra)}</div>
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-ink3">Dec</dt>
                  <dd className="m-0 text-right">
                    {t.today.dec_dms}
                    <div className="text-ink3">{formatDeg(t.today.dec)}</div>
                  </dd>
                </div>
                <div className="flex justify-between gap-2" style={{ fontFamily: "var(--font-sans)" }}>
                  <dt className="text-ink3">Expect</dt>
                  <dd className="m-0 text-right">{t.kind === "moving" ? `${t.pm_total_arcsec_yr.toFixed(1)}″ per year` : "brightness change"}</dd>
                </div>
              </dl>
              <Link to={explorerPath({ ra: t.ra, dec: t.dec, pmra: t.pmra, pmdec: t.pmdec, epoch: t.epoch, fov: t.fov_arcmin, name: t.name })} className="btn btn-primary">
                Open in Blink Explorer <ArrowRight size={15} />
              </Link>
            </article>
          ))}
          {!targets.length && <div className="text-ink3">Loading targets from the backend…</div>}
        </div>
      </section>

      <section style={{ background: "var(--surface-0)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto max-w-[1240px] px-6 py-10">
          <h2 className="m-0 mb-5" style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.01em" }}>
            How it works
          </h2>
          <div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))" }}>
            {STEPS.map(([n, h, d]) => (
              <div key={n} className="flex gap-3">
                <div className="flex h-9 w-9 flex-none items-center justify-center rounded-full" style={{ background: "var(--accent)", color: "var(--accent-ink)", fontWeight: 700 }}>
                  {n}
                </div>
                <div>
                  <div style={{ fontWeight: 700 }}>{h}</div>
                  <div className="text-ink2" style={{ fontSize: 13.5 }}>
                    {d}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-8 grid gap-4 text-ink2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", fontSize: 13.5 }}>
            <div>
              <b className="text-ink">Real data only.</b> Images come from NASA/IPAC IRSA. Every image says where its pixels came from; test data is always labelled SIMULATED.
            </div>
            <div>
              <b className="text-ink">Candidates, not discoveries.</b> Rings mark sources that moved between two epochs. Named rings match SIMBAD or Gaia DR3; the rest are labelled &ldquo;Unidentified candidate&rdquo;.
            </div>
            <div>
              <b className="text-ink">Share any field.</b> The address bar holds the coordinates, so a link reopens the same patch of sky.
            </div>
          </div>
        </div>
      </section>

      <footer className="mx-auto max-w-[1240px] px-6 py-6 text-ink3" style={{ fontSize: 12.5 }}>
        Data: SPHEREx via NASA/IPAC Infrared Science Archive (IRSA) · Gaia DR3 (ESA) · SIMBAD and Aladin Lite (CDS Strasbourg) · DSS2, AllWISE, 2MASS tiles via IRSA.{" "}
        <a className="link" href="https://irsa.ipac.caltech.edu/Missions/spherex.html" target="_blank" rel="noreferrer">
          IRSA SPHEREx
        </a>{" "}
        ·{" "}
        <a className="link" href="http://byw.tools/wiseview" target="_blank" rel="noreferrer">
          WiseView
        </a>
      </footer>
    </div>
  );
}
