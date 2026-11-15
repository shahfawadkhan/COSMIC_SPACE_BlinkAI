import { ChevronDown, Maximize2, Minimize2, RotateCcw, Send, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { apiUrl } from "../../api/client";
import { AssistantError, streamAssistant } from "../../lib/sse";
import { useDock, useLive } from "../../state/assistantStore";
import { useView } from "../../state/view";
import { useWorkspace } from "../../state/workspace";
import { targetFromInfo, useTargets } from "../CommandPanel";
import { contextFor, SUGGESTIONS, think, type Chip, type Effect, type Snapshot } from "./brain";
import { Markdown } from "./Markdown";
import { RobotIcon, type RobotMood } from "./RobotIcon";

interface Source {
  id: string;
  document: string;
  page?: number | null;
  section?: string | null;
  url?: string | null;
  cited: boolean;
}
interface Msg {
  id: string;
  role: "user" | "assistant";
  text: string;
  kind: "scripted" | "ai" | "error";
  basis?: string;
  sources?: Source[];
  chips?: Chip[];
  pending?: boolean;
  retryText?: string;
  facts?: Fact[];
}

/** Only questions about the screen get the screen context: extra text made the AI service's
 * document search miss, so plain SPHEREx questions are sent exactly as typed. */
const SCREEN_Q = /(this|these|that|here|my|current|screen|image|field|ring|rings|mover|movers|target|epoch|epochs|detector|band|looking|see|seeing|shown|showing)/i;
interface Fact {
  id: string;
  text: string;
  source: string;
  url: string;
  contradicted: boolean;
}
interface AiStatus {
  configured: boolean;
  service: "ok" | "waking" | "down";
  llm_configured: boolean | null;
}

const LS_SESSION = "cosmic.assistant.session";
const LS_SIZE = "cosmic.assistant.size";
const MIN_W = 320;
const MIN_H = 380;

function loadSize(): { w: number; h: number } {
  try {
    const v = JSON.parse(localStorage.getItem(LS_SIZE) ?? "null");
    if (v && v.w >= MIN_W && v.h >= MIN_H) return { w: v.w, h: v.h };
  } catch {
    /* ignore */
  }
  return { w: 420, h: 620 };
}
const uid = () => Math.random().toString(36).slice(2, 10);

function sessionId(): string {
  try {
    let s = localStorage.getItem(LS_SESSION);
    if (!s) {
      s = `cosmic_${uid()}${uid()}`;
      localStorage.setItem(LS_SESSION, s);
    }
    return s;
  } catch {
    return `cosmic_${uid()}`;
  }
}

const WELCOME: Msg = {
  id: "welcome",
  role: "assistant",
  kind: "scripted",
  text: "Hello, I'm **Cosmo**. I can explain what is on your screen, open a target (*show Barnard's Star*) or coordinates (*go to 133.79 -7.24*), and answer questions about SPHEREx.",
};

const BASIS: Record<string, string> = {
  retrieved_documentation: "from SPHEREx documentation",
  general_knowledge: "general knowledge – may be outdated",
  unverified_observation_claim: "not checked against the archive",
};


function Typing() {
  return (
    <span className="cosmo-typing inline-flex items-center gap-1 py-1" aria-label="Cosmo is thinking">
      <i />
      <i />
      <i />
    </span>
  );
}

export function Assistant() {
  const nav = useNavigate();
  const loc = useLocation();
  const ws = useWorkspace();
  const { dispatch } = useView();
  const live = useLive();
  const targets = useTargets();
  const dock = useDock();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([WELCOME]);
  const [size, setSize] = useState(loadSize);
  const [maxed, setMaxed] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [mood, setMood] = useState<RobotMood>("idle");
  const [unread, setUnread] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const embed = new URLSearchParams(loc.search).get("embed") === "1";

  useEffect(() => {
    try {
      localStorage.setItem(LS_SIZE, JSON.stringify(size));
    } catch {
      /* ignore */
    }
  }, [size]);

  /** Drag the left edge, top edge or top-left corner (the panel is anchored bottom-right). */
  const startResize = (dx: boolean, dy: boolean) => (e: React.PointerEvent) => {
    e.preventDefault();
    setMaxed(false);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const s0 = size;
    const move = (ev: PointerEvent) =>
      setSize({
        w: dx ? Math.max(MIN_W, Math.min(window.innerWidth - 24, s0.w + (x0 - ev.clientX))) : s0.w,
        h: dy ? Math.max(MIN_H, Math.min(window.innerHeight - 90, s0.h + (y0 - ev.clientY))) : s0.h,
      });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // AI status: checked on open (this also wakes the free-tier service), then every minute
  const checkAi = useCallback(() => {
    fetch(apiUrl("/api/assistant/status"))
      .then((r) => r.json())
      .then(setAi)
      .catch(() => setAi({ configured: false, service: "down", llm_configured: null }));
  }, []);
  useEffect(() => {
    if (!open) return;
    checkAi();
    const t = setInterval(checkAi, 60000);
    return () => clearInterval(t);
  }, [open, checkAi]);

  // every time the panel opens it starts a fresh conversation (unless an answer is still streaming)
  const busyRef = useRef(false);
  busyRef.current = busy;
  useEffect(() => {
    if (open) {
      if (!busyRef.current) {
        const sid = sessionId();
        fetch(apiUrl(`/api/assistant/chat/${sid}`), { method: "DELETE" }).catch(() => undefined);
        try {
          localStorage.removeItem(LS_SESSION);
        } catch {
          /* ignore */
        }
        setMsgs([WELCOME]);
        setInput("");
      }
      setUnread(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, open]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && open && setOpen(false);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open]);

  const snapshot: Snapshot = useMemo(
    () => ({ target: ws.state.target, phase: ws.state.phase, manifest: ws.state.manifest, identity: ws.state.identity, live, targets, path: loc.pathname }),
    [ws.state.target, ws.state.phase, ws.state.manifest, ws.state.identity, live, targets, loc.pathname],
  );

  const runEffect = useCallback(
    (e: Effect) => {
      switch (e.type) {
        case "loadTarget":
          if (!loc.pathname.startsWith("/explorer")) nav("/explorer");
          ws.load({ target: targetFromInfo(e.target), fov: e.target.fov_arcmin });
          break;
        case "loadQuery":
          if (!loc.pathname.startsWith("/explorer")) nav("/explorer");
          ws.load({ query: e.query });
          break;
        case "loadCoords":
          if (!loc.pathname.startsWith("/explorer")) nav("/explorer");
          ws.load({ target: { name: null, ra: e.ra, dec: e.dec, source: "assistant · coordinates" } });
          break;
        case "mode":
          dispatch({ type: "set", patch: { mode: e.mode, playing: e.mode === "blink" } });
          if (!loc.pathname.startsWith("/explorer")) nav("/explorer");
          break;
        case "band":
          dispatch({ type: "set", patch: { band: e.band } });
          break;
        case "navigate":
          nav(e.to);
          break;
      }
    },
    [loc.pathname, nav, ws, dispatch],
  );

  const patch = (id: string, f: (m: Msg) => Msg) => setMsgs((l) => l.map((m) => (m.id === id ? f(m) : m)));

  const askAi = useCallback(
    async (text: string) => {
      const id = uid();
      setMsgs((l) => [...l, { id, role: "assistant", kind: "ai", text: "", pending: true }]);
      setBusy(true);
      setMood("thinking");
      const ctl = new AbortController();
      abortRef.current = ctl;
      let full = "";
      try {
        const context = SCREEN_Q.test(text) ? contextFor(snapshot) || undefined : undefined;
        for await (const ev of streamAssistant({ message: text, session_id: sessionId(), context }, ctl.signal)) {
          if (ev.event === "token") {
            full += String(ev.data.content ?? "");
            patch(id, (m) => ({ ...m, text: m.text + String(ev.data.content ?? "") }));
          }
          else if (ev.event === "sources") patch(id, (m) => ({ ...m, sources: (ev.data.items as Source[]) ?? [] }));
          else if (ev.event === "done") {
            const md = (ev.data.metadata ?? {}) as { answer_basis?: string; truncated?: boolean };
            patch(id, (m) => ({ ...m, pending: false, basis: md.answer_basis, text: m.text + (md.truncated ? "\n\n*(answer was cut off)*" : "") }));
          } else if (ev.event === "error") {
            const msg = String(ev.data.message ?? "The AI stopped with an error.");
            patch(id, (m) => ({ ...m, pending: false, kind: "error", text: (m.text ? m.text + "\n\n" : "") + msg, retryText: ev.data.retryable ? text : undefined }));
          }
        }
        patch(id, (m) => ({ ...m, pending: false }));
        setMood("happy");
        // check the answer against COSMIC's verified facts (shown under it, contradictions flagged)
        fetch(apiUrl("/api/assistant/facts"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: text, answer: full }) })
          .then((r) => r.json())
          .then((j: { facts: Fact[] }) => j.facts?.length && patch(id, (m) => ({ ...m, facts: j.facts })))
          .catch(() => undefined);
        checkAi(); // an answer arrived, so the AI is up: refresh the header status
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          patch(id, (m) => ({ ...m, pending: false, text: m.text + (m.text ? "\n\n" : "") + "*(stopped)*" }));
        } else {
          const err = e instanceof AssistantError ? e : new AssistantError(0, "unknown", String(e));
          const scriptedHint =
            err.code === "ai_not_configured"
              ? "\n\nMeanwhile I can still answer about this app. Try: *What am I looking at?*, *How do I spot a moving object?*, or *show Barnard's Star*."
              : "";
          patch(id, (m) => ({ ...m, pending: false, kind: "error", text: err.message + scriptedHint, retryText: err.retryable || err.code === "ai_waking" ? text : undefined, chips: err.code === "ai_not_configured" ? SUGGESTIONS.slice(1).map((x) => ({ label: x, ask: x })) : undefined }));
          if (err.code === "ai_waking" || err.code === "ai_unreachable") checkAi();
        }
        setMood("idle");
      } finally {
        setBusy(false);
        abortRef.current = null;
        setTimeout(() => setMood("idle"), 2500);
        if (!open) setUnread(true);
      }
    },
    [snapshot, checkAi, open],
  );

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || busy) return;
      setInput("");
      setMsgs((l) => [...l, { id: uid(), role: "user", kind: "scripted", text }]);
      const reply = think(text, snapshot);
      if (reply) {
        setMood("happy");
        setTimeout(() => {
          setMsgs((l) => [...l, { id: uid(), role: "assistant", kind: "scripted", text: reply.text, chips: reply.chips }]);
          if (reply.effect) runEffect(reply.effect);
          setTimeout(() => setMood("idle"), 1800);
        }, 260);
      } else {
        askAi(text);
      }
    },
    [busy, snapshot, runEffect, askAi],
  );

  const newChat = () => {
    abortRef.current?.abort();
    const sid = sessionId();
    fetch(apiUrl(`/api/assistant/chat/${sid}`), { method: "DELETE" }).catch(() => undefined);
    try {
      localStorage.removeItem(LS_SESSION);
    } catch {
      /* ignore */
    }
    setMsgs([WELCOME]);
  };

  if (embed) return null;
  const fabHidden = !!dock.hidden && !open;

  const aiLabel = !ai
    ? "checking AI…"
    : !ai.configured
      ? "AI not connected"
      : ai.service === "ok"
        ? ai.llm_configured === false
          ? "AI model offline"
          : "SPHEREx AI online"
        : ai.service === "waking"
          ? "AI waking up…"
          : "AI offline";
  const aiOk = !!ai?.configured && ai.service === "ok" && ai.llm_configured !== false;
  const panelBottom = dock.bottom + 76;
  const showSuggestions = !busy && msgs[msgs.length - 1]?.role === "assistant" && !msgs[msgs.length - 1]?.pending;

  return (
    <>
      {open && (
        <section
          role="dialog"
          aria-label="COSMIC assistant"
          className="cosmo-panel fixed z-[60] flex flex-col overflow-hidden"
          style={{
            right: dock.right,
            bottom: panelBottom,
            width: maxed ? "min(880px, calc(100vw - 24px))" : `min(${size.w}px, calc(100vw - 24px))`,
            height: maxed ? `calc(100vh - ${panelBottom + 70}px)` : `min(${size.h}px, calc(100vh - ${panelBottom + 70}px))`,
          }}
        >
          <div className="cosmo-resize" onPointerDown={startResize(true, true)} title="Drag to resize" aria-hidden />
          <div className="cosmo-resize-l" onPointerDown={startResize(true, false)} aria-hidden />
          <div className="cosmo-resize-t" onPointerDown={startResize(false, true)} aria-hidden />
          <header className="cosmo-header flex items-center gap-2.5 px-3 py-2.5">
            <div className="cosmo-avatar flex h-10 w-10 flex-none items-center justify-center rounded-full">
              <RobotIcon size={34} mood={busy ? "thinking" : mood} />
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <div style={{ fontWeight: 800, fontSize: 15, color: "#fff" }}>Cosmo</div>
              <div className="flex items-center gap-1.5 whitespace-nowrap" style={{ fontSize: 11.5, color: "#bcd3ea" }}>
                <span>SPHEREx assistant</span>
                <span>·</span>
                <span className="inline-flex items-center gap-1" title={aiOk ? "Open questions go to the SPHEREx AI service" : "Only scripted answers right now"}>
                  <span style={{ width: 7, height: 7, borderRadius: 7, background: aiOk ? "#4cc67a" : ai?.service === "waking" ? "#f0b258" : "#8a99ab" }} />
                  {aiLabel}
                </span>
              </div>
            </div>
            <button className="cosmo-hbtn" onClick={() => setMaxed((v) => !v)} title={maxed ? "Restore size" : "Expand"} aria-label={maxed ? "Restore size" : "Expand"}>
              {maxed ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <button className="cosmo-hbtn" onClick={newChat} title="New chat" aria-label="New chat">
              <RotateCcw size={15} />
            </button>
            <button className="cosmo-hbtn" onClick={() => setOpen(false)} title="Close (Esc)" aria-label="Close assistant">
              <X size={16} />
            </button>
          </header>

          <div ref={listRef} className="cosmo-list min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" aria-live="polite">
            {msgs.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex justify-end">
                  <div className="cosmo-bubble-user max-w-[85%] whitespace-pre-wrap px-3 py-2">{m.text}</div>
                </div>
              ) : (
                <div key={m.id} className="flex items-start gap-2">
                  <div className="cosmo-mini flex h-7 w-7 flex-none items-center justify-center rounded-full">
                    <RobotIcon size={22} mood={m.kind === "error" ? "sleepy" : "idle"} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className={`cosmo-bubble px-3 py-2 ${m.kind === "error" ? "cosmo-bubble-error" : ""}`}>
                      {m.pending && !m.text ? <Typing /> : <Markdown text={m.text} />}
                      {m.pending && m.text && <span className="cosmo-caret" />}
                      {m.sources && m.sources.length > 0 && (
                        <div className="mt-2 border-t border-line pt-1.5" style={{ fontSize: 11.5 }}>
                          {m.sources.map((s) => (
                            <div key={s.id} className={s.cited ? "text-ink2" : "text-ink3"}>
                              <b>{s.id}</b>{" "}
                              {s.url ? (
                                <a className="link" href={s.url} target="_blank" rel="noreferrer">
                                  {s.document}
                                </a>
                              ) : (
                                s.document
                              )}
                              {s.section ? ` · ${s.section}` : ""}
                              {s.page ? `, p.${s.page}` : ""}
                              {!s.cited && " (related)"}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 pl-1" style={{ fontSize: 10.5 }}>
                      <span className={`cosmo-tag ${m.kind === "ai" ? "cosmo-tag-ai" : m.kind === "error" ? "cosmo-tag-err" : ""}`}>{m.kind === "ai" ? "SPHEREx AI" : m.kind === "error" ? "Not answered" : "COSMIC"}</span>
                      {m.basis && <span className="text-ink3">{BASIS[m.basis] ?? m.basis}</span>}
                      {m.retryText && (
                        <button className="link border-0 bg-transparent p-0" style={{ fontSize: 11, cursor: "pointer" }} onClick={() => send(m.retryText!)}>
                          Try again
                        </button>
                      )}
                    </div>
                    {m.facts && m.facts.length > 0 && (
                      <div className="cosmo-facts mt-1.5 px-2.5 py-2">
                        {m.facts.some((f) => f.contradicted) && (
                          <div className="mb-1" style={{ color: "var(--warn)", fontWeight: 700, fontSize: 12 }}>
                            ⚠ Part of this answer looks outdated or wrong. Checked fact:
                          </div>
                        )}
                        {!m.facts.some((f) => f.contradicted) && (
                          <div className="mb-1" style={{ color: "var(--ok)", fontWeight: 700, fontSize: 12 }}>
                            ✓ Verified facts
                          </div>
                        )}
                        {m.facts.map((f) => (
                          <div key={f.id} style={{ fontSize: 12.5 }} className="mb-0.5">
                            {f.text}{" "}
                            <a className="link" href={f.url} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
                              ({f.source})
                            </a>
                          </div>
                        ))}
                      </div>
                    )}
                    {m.chips && m.chips.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {m.chips.map((c, i) => (
                          <button key={i} className="cosmo-chip" onClick={() => (c.effect ? runEffect(c.effect) : c.ask ? send(c.ask) : undefined)}>
                            {c.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>

          {showSuggestions && (
            <div className="flex flex-none gap-1.5 overflow-x-auto px-3 pb-2 no-scrollbar">
              {SUGGESTIONS.map((sg) => (
                <button key={sg} className="cosmo-chip flex-none" onClick={() => send(sg)}>
                  {sg}
                </button>
              ))}
            </div>
          )}

          <form
            className="cosmo-input flex flex-none items-end gap-2 border-t border-line px-3 py-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(110, e.target.scrollHeight)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder={busy ? "Cosmo is answering…" : "Ask about SPHEREx or this field"}
              className="field min-h-[38px] flex-1 resize-none py-2"
              style={{ height: 38, lineHeight: "20px" }}
              maxLength={4000}
              aria-label="Message"
            />
            {busy ? (
              <button type="button" className="cosmo-send" onClick={() => abortRef.current?.abort()} title="Stop" aria-label="Stop answering">
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button type="submit" className="cosmo-send" disabled={!input.trim()} title="Send (Enter)" aria-label="Send">
                <Send size={16} />
              </button>
            )}
          </form>
          <div className="flex-none px-3 pb-2 text-ink3" style={{ fontSize: 10.5 }}>
            AI answers can be wrong. Check the verified facts and sources.
          </div>
        </section>
      )}

      {!fabHidden && (
      <button
        className={`cosmo-fab fixed z-[61] flex items-center justify-center rounded-full ${open ? "is-open" : ""}`}
        style={{ right: dock.right, bottom: dock.bottom }}
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close assistant" : "Open assistant (Cosmo)"}
        aria-expanded={open}
        title={open ? "Close" : "Ask Cosmo"}
      >
        <span className="cosmo-ring" aria-hidden />
        {open ? <ChevronDown size={26} color="#fff" /> : <RobotIcon size={40} mood={busy ? "thinking" : mood} />}
        {!open && (unread || aiOk) && <span className="cosmo-dot" style={{ background: unread ? "#ff5a7a" : "#4cc67a" }} aria-hidden />}
      </button>
      )}
    </>
  );
}
