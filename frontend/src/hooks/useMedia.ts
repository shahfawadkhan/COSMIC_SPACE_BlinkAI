import { useEffect, useState } from "react";

/** true while the CSS media query matches (e.g. "(min-width: 1024px)"). */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => (typeof window !== "undefined" ? window.matchMedia(query).matches : true));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** Wide = side panels sit beside the stage; narrow = they become drawers. */
export const useWide = () => useMediaQuery("(min-width: 1024px)");
