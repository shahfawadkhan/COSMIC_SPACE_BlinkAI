import { useEffect, useRef, useState } from "react";

/** Global keyboard shortcuts; ignored while typing in a field. */
export function useKeys(handlers: Record<string, (e: KeyboardEvent) => void>) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key === " " ? "Space" : e.key;
      const h = ref.current[key] ?? ref.current[key.toLowerCase()];
      if (h) {
        e.preventDefault();
        h(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Seconds since `start` (ms epoch), ticking once per second. */
export function useElapsed(start: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!start) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [start]);
  return start ? Math.max(0, Math.round((now - start) / 1000)) : 0;
}
