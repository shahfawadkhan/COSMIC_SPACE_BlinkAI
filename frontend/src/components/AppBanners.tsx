import { Check, Copy, RotateCcw, ServerOff, X } from "lucide-react";
import { useState } from "react";
import { useHealth } from "../hooks/useHealth";

const START_CMD = "cd backend; .venv\\Scripts\\python -m uvicorn app.main:app --port 8000";
const REDIS_CMD = "docker run -d --name redis -p 6379:6379 redis:7 --maxmemory 512mb --maxmemory-policy allkeys-lru";

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="inline-flex items-center gap-1 rounded px-2 py-0.5"
      style={{ background: "rgba(255,255,255,.15)", border: 0, color: "inherit", cursor: "pointer", fontSize: 12 }}
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => undefined);
        setOk(true);
        setTimeout(() => setOk(false), 1400);
      }}
    >
      {ok ? <Check size={12} /> : <Copy size={12} />}
      {ok ? "Copied" : "Copy"}
    </button>
  );
}

/** Never a blank screen: say clearly when the backend is down (blocking) or Redis is off (not blocking). */
export function AppBanners() {
  const { online, health, failures, recheck } = useHealth();
  const [redisHidden, setRedisHidden] = useState(() => {
    try {
      return sessionStorage.getItem("cosmic.redisNotice") === "hidden";
    } catch {
      return false;
    }
  });
  if (online === false && failures >= 1) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2" style={{ background: "#7f1d24", color: "#fff", fontSize: 13 }}>
        <ServerOff size={16} />
        <b>COSMIC backend is offline.</b>
        <span style={{ opacity: 0.9 }}>Images and catalogues need it. Start it in a terminal:</span>
        <code className="num rounded px-2 py-0.5" style={{ background: "rgba(0,0,0,.35)", fontSize: 12 }}>
          {START_CMD}
        </code>
        <CopyBtn text={START_CMD} />
        <button className="ml-auto inline-flex items-center gap-1 rounded px-2.5 py-1" style={{ background: "#fff", color: "#7f1d24", border: 0, cursor: "pointer", fontWeight: 600, fontSize: 12.5 }} onClick={recheck}>
          <RotateCcw size={13} /> Retry
        </button>
      </div>
    );
  }
  if (health && health.redis === "down" && !redisHidden) {
    return (
      <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1" style={{ background: "color-mix(in srgb, var(--warn) 12%, var(--surface-0))", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}>
        <span className="text-ink2">
          <b className="text-ink">Redis is not running</b>: everything works from the disk cache, just a little slower. To start it:
        </span>
        <code className="num rounded px-1.5" style={{ background: "var(--surface-2)", fontSize: 11.5 }}>
          {REDIS_CMD}
        </code>
        <button
          className="ml-auto inline-flex items-center rounded p-1 text-ink3"
          style={{ border: 0, background: "transparent", cursor: "pointer" }}
          aria-label="Hide Redis notice"
          onClick={() => {
            setRedisHidden(true);
            try {
              sessionStorage.setItem("cosmic.redisNotice", "hidden");
            } catch {
              /* ignore */
            }
          }}
        >
          <X size={14} />
        </button>
      </div>
    );
  }
  return null;
}
