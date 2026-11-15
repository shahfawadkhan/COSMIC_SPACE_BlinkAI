import { Loader2, X } from "lucide-react";
import type { SetStatus } from "../api/client";
import { useElapsed } from "../hooks/useKeys";
import type { WorkspaceState } from "../state/workspace";
import { IdentityLine } from "./Inspector";
import { CoordTable, fmtSeconds } from "./ui";

function stageText(phase: WorkspaceState["phase"], job: SetStatus | null): string {
  if (phase === "resolving") return "Resolving name…";
  if (!job) return "Starting…";
  const { stage, progress } = job;
  switch (stage) {
    case "queued":
      return "Waiting to start";
    case "searching":
      return "Searching IRSA";
    case "downloading":
      return progress.total ? `Downloading ${progress.done} of ${progress.total}` : "Downloading";
    case "reprojecting":
      return "Reprojecting";
    case "rendering":
      return "Rendering";
    default:
      return "Finishing";
  }
}

function overall(job: SetStatus | null): number {
  if (!job) return 0.02;
  const f = job.progress.total ? job.progress.done / job.progress.total : 0;
  switch (job.stage) {
    case "queued":
      return 0.01;
    case "searching":
      return 0.04;
    case "downloading":
      return 0.06 + 0.84 * f;
    case "reprojecting":
      return 0.9 + 0.05 * f;
    case "rendering":
      return 0.96;
    default:
      return 1;
  }
}

/** Loading card for the NEW target. Never shows the previous object's image. */
export function LoadingScreen({ state, onCancel, extra }: { state: WorkspaceState; onCancel: () => void; extra?: string }) {
  const elapsed = useElapsed(state.startedAt);
  const t = state.target;
  const job = state.job;
  const pct = Math.round(overall(job) * 100);
  return (
    <div className="flex h-full items-center justify-center p-6" role="status" aria-live="polite">
      <div className="panel w-full max-w-[460px] p-5">
        <div className="flex items-center gap-2 text-accent" style={{ fontSize: 12.5, fontWeight: 600 }}>
          <Loader2 size={14} className="animate-spin" /> Loading new field
        </div>
        <div className="mt-1.5" style={{ fontSize: 20, fontWeight: 800 }}>
          {t ? (t.name ?? "Sky position") : state.phase === "resolving" ? "Resolving name…" : "…"}
        </div>
        {state.phase === "resolving" && state.query && <div className="text-ink2">“{state.query}”</div>}
        {t && (
          <div className="mt-2">
            <CoordTable ra={t.ra} dec={t.dec} />
          </div>
        )}
        <div className="mt-2">
          <IdentityLine state={state} />
        </div>
        <div className="mt-4 flex items-baseline justify-between">
          <span style={{ fontWeight: 600 }}>{extra ?? stageText(state.phase, job)}</span>
          <span className="num text-ink2">{pct}%</span>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-s2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: "var(--accent)" }} />
        </div>
        <div className="num mt-1.5 flex justify-between text-ink2" style={{ fontSize: 12 }}>
          <span>Elapsed {fmtSeconds(elapsed)}</span>
          <span>ETA {fmtSeconds(job?.eta_s ?? null)}</span>
        </div>
        {(() => {
          const gate = (job?.detail?.irsa_gate ?? null) as { busy_replies?: number; limit?: number } | null;
          const busy = gate?.busy_replies ?? 0;
          const slow = job?.stage === "downloading" && elapsed > 60;
          if (!busy && !slow) return null;
          return (
            <div className="mt-3 rounded border px-2.5 py-1.5" style={{ fontSize: 12.5, borderColor: "color-mix(in srgb, var(--warn) 50%, transparent)", background: "color-mix(in srgb, var(--warn) 8%, var(--surface-0))" }}>
              <b style={{ color: "var(--warn)" }}>IRSA is slow right now.</b>{" "}
              {busy > 0 ? `It answered “server busy” ${busy} time${busy > 1 ? "s" : ""}, so we wait and fetch ${Math.max(1, Math.floor(gate?.limit ?? 1))} at a time. ` : ""}
              Keep waiting or cancel: every image already downloaded is kept, so the next try is faster.
            </div>
          );
        })()}
        <p className="mb-0 mt-3 text-ink3" style={{ fontSize: 12 }}>
          A first look downloads SPHEREx cutouts from NASA IRSA. When IRSA asks us to slow down, we wait and retry. A second look is instant.
        </p>
        <div className="mt-3 flex justify-end">
          <button className="btn btn-danger" onClick={onCancel}>
            <X size={14} /> Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
