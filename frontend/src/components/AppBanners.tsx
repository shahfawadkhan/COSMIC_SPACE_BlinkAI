import { Check, Copy, RotateCcw, ServerOff } from "lucide-react";
import { useState } from "react";
import { useHealth } from "../hooks/useHealth";

const START_CMD = "cd backend; .venv\\Scripts\\python -m uvicorn app.main:app --port 8000";

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

/** Never a blank screen: say clearly when the backend is down. Redis is optional (the disk cache
 * takes over silently); its status is shown in Settings > Cache only. */
export function AppBanners() {
  const { online, failures, recheck } = useHealth();
  // two failed checks in a row: one slow answer on a busy machine is not "offline"
  if (online === false && failures >= 2) {
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
  return null;
}
