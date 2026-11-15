import { useEffect, useRef, useState } from "react";
import { useSettings } from "../state/settings";
import { Spinner } from "./ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
let plotlyPromise: Promise<any> | null = null;
const loadPlotly = () => (plotlyPromise ??= import("plotly.js-dist-min").then((m: any) => m.default ?? m));

/** Plotly chart themed from the CSS design tokens. Plotly is loaded only when a chart is shown. */
export function Plot({ data, layout, height = 360 }: { data: any[]; layout?: Record<string, any>; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { settings } = useSettings();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    const el = ref.current!;
    loadPlotly().then((P) => {
      if (!alive) return;
      const css = getComputedStyle(document.documentElement);
      const v = (k: string) => css.getPropertyValue(k).trim();
      const axis = { gridcolor: v("--line"), zerolinecolor: v("--line-strong"), linecolor: v("--line-strong"), color: v("--ink-2") };
      P.react(
        el,
        data,
        {
          height,
          margin: { l: 64, r: 16, t: 28, b: 52 },
          paper_bgcolor: v("--surface-0"),
          plot_bgcolor: v("--surface-0"),
          font: { family: "Public Sans, sans-serif", color: v("--ink"), size: 12 },
          legend: { orientation: "h", y: 1.12, x: 0 },
          ...layout,
          xaxis: { ...axis, ...(layout?.xaxis ?? {}) },
          yaxis: { ...axis, ...(layout?.yaxis ?? {}) },
        },
        { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["lasso2d", "select2d"] },
      );
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [data, layout, height, settings.theme]);
  useEffect(() => {
    const el = ref.current;
    return () => {
      plotlyPromise?.then((P) => el && P.purge(el));
    };
  }, []);
  return (
    <div className="relative" style={{ minHeight: height }}>
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner label="Loading chart…" />
        </div>
      )}
      <div ref={ref} />
    </div>
  );
}
