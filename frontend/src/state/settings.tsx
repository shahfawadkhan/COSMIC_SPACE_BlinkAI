import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "light" | "dark" | "slate" | "night";
export type CoordFormat = "sexagesimal" | "degrees";
export type RenderScale = "auto" | 2 | 4 | 8;

export interface Settings {
  theme: Theme;
  apiBaseUrl: string; // "" = same origin (dev proxy)
  coordFormat: CoordFormat; // which form is shown first; both are always shown
  renderScale: RenderScale; // PNG upscale requested from the backend
  showProvenance: boolean;
  reduceMotion: boolean;
}

export const DEFAULT_SETTINGS: Settings = { theme: "light", apiBaseUrl: "", coordFormat: "sexagesimal", renderScale: "auto", showProvenance: true, reduceMotion: false };
export const SETTINGS_KEY = "cosmic.settings.v1";

/** Read settings outside React (the API client needs the base URL at call time). */
export function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* storage blocked */
  }
  return DEFAULT_SETTINGS;
}

interface Ctx {
  settings: Settings;
  update: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
}
const SettingsCtx = createContext<Ctx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(readSettings);
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.classList.toggle("reduce-motion", settings.reduceMotion);
  }, [settings]);
  const value = useMemo<Ctx>(() => ({ settings, update: (k, v) => setSettings((s) => ({ ...s, [k]: v })) }), [settings]);
  return <SettingsCtx.Provider value={value}>{children}</SettingsCtx.Provider>;
}

export function useSettings() {
  const c = useContext(SettingsCtx);
  if (!c) throw new Error("SettingsProvider missing");
  return c;
}
