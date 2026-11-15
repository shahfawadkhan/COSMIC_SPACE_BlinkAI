import { useEffect, useState } from "react";

/** Download and decode every URL up front so switching epochs never flickers.
 * Returns the set of URLs that are ready to paint. URLs stay "ready" once decoded
 * (the browser keeps them cached), so toggling back to an earlier image is instant. */
export function usePreload(urls: string[]): Set<string> {
  const [ready, setReady] = useState<Set<string>>(new Set());
  const joined = urls.join("\n");
  useEffect(() => {
    let alive = true;
    const list = joined ? joined.split("\n") : [];
    list.forEach((u) => {
      const img = new Image();
      img.src = u;
      img
        .decode()
        .catch(() => undefined)
        .then(() => {
          if (alive) setReady((prev) => (prev.has(u) ? prev : new Set(prev).add(u)));
        });
    });
    return () => {
      alive = false;
    };
  }, [joined]);
  return ready;
}
