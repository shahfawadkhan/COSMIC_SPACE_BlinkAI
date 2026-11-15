// Tiny external stores shared between the pages and the assistant.
import { useSyncExternalStore } from "react";
import type { MoversResponse, ViewResponse } from "../api/client";
import type { Mode } from "./view";

function createStore<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T) => {
      value = v;
      subs.forEach((f) => f());
    },
    subscribe: (f: () => void) => {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

/** What the Blink Explorer is showing right now (for "what am I looking at?"). */
export interface LiveView {
  view: ViewResponse | null;
  movers: MoversResponse | null;
  a: number;
  b: number;
  band: string;
  mode: Mode;
}
export const liveStore = createStore<LiveView | null>(null);
export const useLive = () => useSyncExternalStore(liveStore.subscribe, liveStore.get);

/** Where the assistant button may sit without covering side panels (px from the window edge). */
export interface Dock {
  right: number;
  bottom: number;
  hidden?: boolean; // a phone-size drawer is open: the button would cover it
}
export const DEFAULT_DOCK: Dock = { right: 20, bottom: 20 };
export const dockStore = createStore<Dock>(DEFAULT_DOCK);
export const useDock = () => useSyncExternalStore(dockStore.subscribe, dockStore.get);
