import { AlertTriangle, Info, Loader2 } from "lucide-react";
import { Component, type ButtonHTMLAttributes, type ErrorInfo, type ReactNode } from "react";
import { decLabel, formatDec, formatDeg, formatRA, raLabel } from "../lib/coords";
import { useSettings } from "../state/settings";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; variant?: "default" | "ghost" | "primary" | "danger"; icon?: boolean };

export function Btn({ active, variant = "default", icon, className, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      aria-pressed={active === undefined ? rest["aria-pressed"] : active}
      className={cx("btn", variant === "primary" && "btn-primary", variant === "danger" && "btn-danger", variant === "ghost" && "btn-ghost", icon && "btn-icon", className)}
    />
  );
}

export type Provenance = "irsa" | "catalogue" | "derived" | "simulated";
const PROV: Record<Provenance, { label: string; color: string; help: string }> = {
  irsa: { label: "NASA IRSA data", color: "var(--ok)", help: "Real SPHEREx pixels from the NASA/IPAC Infrared Science Archive." },
  catalogue: { label: "Catalogue", color: "var(--accent)", help: "Positions from SIMBAD / Gaia DR3, moved to the date with their proper motion." },
  derived: { label: "Derived", color: "var(--sel)", help: "Computed by COSMIC from real data (differences, stacks, mover candidates)." },
  simulated: { label: "SIMULATED", color: "var(--bad)", help: "Test data made up by COSMIC. Not a real observation." },
};

/** Every image and number carries where it came from. */
export function ProvChip({ kind, className, force }: { kind: Provenance; className?: string; force?: boolean }) {
  const { settings } = useSettings();
  if (!settings.showProvenance && !force && kind !== "simulated") return null;
  const p = PROV[kind];
  return (
    <span
      title={p.help}
      className={cx("inline-flex items-center gap-1.5 whitespace-nowrap border px-1.5 py-[1px] font-semibold uppercase", className)}
      style={{ color: p.color, borderColor: `color-mix(in srgb, ${p.color} 50%, transparent)`, background: "var(--overlay-bg)", fontSize: 10.5, letterSpacing: ".06em", borderRadius: 3 }}
    >
      <span style={{ width: 5, height: 5, background: p.color, borderRadius: kind === "derived" ? 0 : 5 }} />
      {p.label}
    </span>
  );
}

/** Kept for older call sites: the data-source chip on images. */
export function SourceChip({ simulated = false, className }: { simulated?: boolean; className?: string }) {
  return <ProvChip kind={simulated ? "simulated" : "irsa"} className={className} force />;
}

export function CoordLines({ ra, dec, className }: { ra: number; dec: number; className?: string }) {
  return (
    <div className={cx("num", className)} style={{ fontSize: 12, lineHeight: "18px" }}>
      <div>{raLabel(ra)}</div>
      <div>{decLabel(dec)}</div>
    </div>
  );
}

/** Two-column RA / Dec table: sexagesimal and degrees. */
export function CoordTable({ ra, dec }: { ra: number; dec: number }) {
  const { settings } = useSettings();
  const degFirst = settings.coordFormat === "degrees";
  const raDeg = formatDeg(((ra % 360) + 360) % 360);
  const decDeg = formatDeg(dec);
  // both forms always shown; the setting decides which comes first
  return (
    <dl className="num m-0 grid gap-0.5" style={{ fontSize: 12.5 }}>
      <div className="flex justify-between gap-2">
        <dt className="text-ink3">RA</dt>
        <dd className="m-0 text-right">
          {degFirst ? raDeg : formatRA(ra)} <span className="text-ink3">({degFirst ? formatRA(ra) : raDeg})</span>
        </dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-ink3">Dec</dt>
        <dd className="m-0 text-right">
          {degFirst ? decDeg : formatDec(dec)} <span className="text-ink3">({degFirst ? formatDec(dec) : decDeg})</span>
        </dd>
      </div>
    </dl>
  );
}

export function Panel({ title, children, className, right }: { title?: ReactNode; children: ReactNode; className?: string; right?: ReactNode }) {
  return (
    <section className={cx("panel", className)}>
      {title && (
        <header className="flex items-center justify-between border-b border-line px-3 py-2">
          <h3 className="cap m-0">{title}</h3>
          {right}
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Section({ title, right, children, className }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("border-t border-line px-3 py-2.5 first:border-t-0", className)}>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h3 className="cap m-0">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function KV({ k, v, mono = true }: { k: ReactNode; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[2px]">
      <span className="text-ink3" style={{ fontSize: 12 }}>
        {k}
      </span>
      <span className={cx("text-right", mono && "num")} style={{ fontSize: 12 }}>
        {v}
      </span>
    </div>
  );
}

export function Banner({ tone = "info", title, children, action }: { tone?: "info" | "warn" | "bad"; title?: string; children?: ReactNode; action?: ReactNode }) {
  const c = tone === "bad" ? "var(--bad)" : tone === "warn" ? "var(--warn)" : "var(--accent)";
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div role={tone === "bad" ? "alert" : "status"} className="flex gap-2.5 rounded border px-3 py-2" style={{ borderColor: `color-mix(in srgb, ${c} 50%, transparent)`, background: `color-mix(in srgb, ${c} 8%, var(--surface-0))` }}>
      <Icon size={15} color={c} style={{ flex: "none", marginTop: 2 }} />
      <div className="min-w-0 flex-1">
        {title && <div style={{ fontWeight: 600, color: c }}>{title}</div>}
        {children && <div className="text-ink2">{children}</div>}
        {action && <div className="mt-1.5">{action}</div>}
      </div>
    </div>
  );
}

export function Spinner({ label }: { label?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-ink2">
      <Loader2 size={14} className="animate-spin" />
      {label}
    </span>
  );
}

export function Select({ value, onChange, options, label, className }: { value: string | number; onChange: (v: string) => void; options: { value: string | number; label: string }[]; label: string; className?: string }) {
  return (
    <label className={cx("inline-flex items-center gap-1.5", className)}>
      {label && <span className="cap">{label}</span>}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="field" style={{ width: "auto" }}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function fmtSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "–";
  const v = Math.max(0, Math.round(s));
  if (v < 60) return `${v} s`;
  return `${Math.floor(v / 60)} min ${String(v % 60).padStart(2, "0")} s`;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error("UI error", err, info.componentStack);
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="p-6">
        <Banner
          tone="bad"
          title="This view crashed"
          action={
            <button className="btn" onClick={() => this.setState({ err: null })}>
              Try again
            </button>
          }
        >
          {this.state.err.message}
        </Banner>
      </div>
    );
  }
}
