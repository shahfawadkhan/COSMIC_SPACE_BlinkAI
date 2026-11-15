import { Menu, Settings, X } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useHealth } from "../hooks/useHealth";
import { cx } from "./ui";

export const MENU = [
  { to: "/", label: "Mission Control", end: true },
  { to: "/explorer", label: "Blink Explorer" },
  { to: "/compare", label: "Image Exploration" },
  { to: "/analysis", label: "AstroAnalytics" },
  { to: "/candidates", label: "Discovery Log" },
  { to: "/planetx", label: "Planet X Lab" },
  { to: "/mission", label: "SPHEREx Mission" },
];

export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden>
      <circle cx="20" cy="20" r="18" fill="#0b3d91" />
      <ellipse cx="20" cy="20" rx="17" ry="6.5" fill="none" stroke="#fff" strokeWidth="1.6" transform="rotate(-24 20 20)" />
      <circle cx="20" cy="20" r="4.2" fill="#5db3f0" />
      <circle cx="31" cy="13.5" r="2.2" fill="#fc3d21" />
    </svg>
  );
}

export function TopBar() {
  const { online, ms, health } = useHealth();
  const [menuOpen, setMenuOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setMenuOpen(false), [loc.pathname]);
  const dot = online === null ? "#f0b258" : online ? "#4cc67a" : "#ff6b73";
  const statusText = online === null ? "Connecting…" : online ? `Online · ${ms} ms` : "Data service offline";
  return (
    <header className="relative z-50" style={{ background: "var(--chrome)", color: "var(--chrome-ink)", borderBottom: "3px solid var(--sky)" }}>
      <div className="flex h-[54px] items-center gap-3 px-3 sm:gap-4 sm:px-4">
        <NavLink to="/" className="flex min-w-0 shrink-0 items-center gap-2.5 no-underline" style={{ color: "inherit" }} aria-label="COSMIC Space Blink AI home">
          <Logo />
          <span className="min-w-0 leading-tight">
            <span className="block truncate" style={{ fontWeight: 800, fontSize: 16, letterSpacing: "-0.01em" }}>
              COSMIC Space Blink AI
            </span>
            <span className="hidden sm:block" style={{ fontSize: 11.5, color: "var(--chrome-ink-2)" }}>
              SPHEREx motion &amp; change finder
            </span>
          </span>
        </NavLink>
        <nav aria-label="Primary" className="no-scrollbar ml-2 hidden h-full min-w-0 items-stretch overflow-x-auto lg:flex">
          {MENU.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => cx("flex items-center whitespace-nowrap border-b-[3px] px-3 no-underline transition-colors", isActive ? "border-[var(--sky)]" : "border-transparent hover:bg-white/5")}
              style={{ color: "var(--chrome-ink)", fontWeight: 500, fontSize: 14, marginBottom: -3 }}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-3" aria-live="polite">
          <span className="flex items-center gap-2 whitespace-nowrap" style={{ color: "var(--chrome-ink-2)", fontSize: 12.5 }} title={`Backend: ${statusText}`}>
            <span style={{ width: 8, height: 8, borderRadius: 8, background: dot }} />
            <span className="hidden sm:inline">{statusText}</span>
          </span>
          {health && (
            <span className="hidden whitespace-nowrap xl:inline" style={{ fontSize: 12.5, color: health.redis === "connected" ? "#4cc67a" : "var(--chrome-ink-2)" }} title={health.redis === "connected" ? "Redis cache connected" : "Redis not running: disk cache only"}>
              {health.redis === "connected" ? "Redis ✓" : "Disk cache"}
            </span>
          )}
          <NavLink to="/settings" aria-label="Settings" title="Settings" className="flex h-9 w-9 items-center justify-center rounded hover:bg-white/10" style={{ color: "var(--chrome-ink)" }}>
            <Settings size={18} />
          </NavLink>
          <button className="flex h-9 w-9 items-center justify-center rounded hover:bg-white/10 lg:hidden" style={{ color: "var(--chrome-ink)", background: "transparent", border: 0, cursor: "pointer" }} aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>
      {menuOpen && (
        <nav aria-label="Primary (mobile)" className="absolute left-0 right-0 top-full lg:hidden" style={{ background: "var(--chrome)", borderBottom: "3px solid var(--sky)", boxShadow: "0 12px 30px rgba(0,0,0,.35)" }}>
          {MENU.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => cx("block border-l-[3px] px-5 py-3 no-underline", isActive ? "border-[var(--sky)] bg-white/5" : "border-transparent hover:bg-white/5")}
              style={{ color: "var(--chrome-ink)", fontWeight: 500, fontSize: 15 }}
            >
              {label}
            </NavLink>
          ))}
        </nav>
      )}
    </header>
  );
}
