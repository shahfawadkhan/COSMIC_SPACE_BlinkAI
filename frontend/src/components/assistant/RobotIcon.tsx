export type RobotMood = "idle" | "thinking" | "happy" | "sleepy";

/** Cosmo, the COSMIC assistant: a small friendly robot head. */
export function RobotIcon({ size = 34, mood = "idle", className }: { size?: number; mood?: RobotMood; className?: string }) {
  const eyeY = mood === "thinking" ? 19.2 : 20.5;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className={className} aria-hidden>
      <defs>
        <linearGradient id="cosmo-head" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#cfe6fa" />
        </linearGradient>
        <linearGradient id="cosmo-visor" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0b1a33" />
          <stop offset="1" stopColor="#13305a" />
        </linearGradient>
        <radialGradient id="cosmo-eye">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.45" stopColor="#7df9ff" />
          <stop offset="1" stopColor="#25c6ff" />
        </radialGradient>
      </defs>
      {/* antenna */}
      <line x1="20" y1="6.5" x2="20" y2="10.5" stroke="#cfe6fa" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="20" cy="5.2" r="2.4" fill="#ff5a7a" className="cosmo-antenna" />
      {/* ears */}
      <rect x="4.2" y="17" width="3.6" height="9" rx="1.8" fill="#9cc8ee" />
      <rect x="32.2" y="17" width="3.6" height="9" rx="1.8" fill="#9cc8ee" />
      {/* head */}
      <rect x="6.5" y="10" width="27" height="23" rx="9" fill="url(#cosmo-head)" stroke="#9cc8ee" strokeWidth="0.8" />
      {/* visor */}
      <rect x="10" y="14" width="20" height="13.5" rx="6.5" fill="url(#cosmo-visor)" />
      {/* eyes */}
      {mood === "happy" ? (
        <g stroke="#7df9ff" strokeWidth="2" strokeLinecap="round" fill="none">
          <path d="M13.6 21.4 q2 -2.6 4 0" />
          <path d="M22.4 21.4 q2 -2.6 4 0" />
        </g>
      ) : mood === "sleepy" ? (
        <g stroke="#7df9ff" strokeWidth="2" strokeLinecap="round">
          <line x1="13.6" y1="20.8" x2="17.6" y2="20.8" />
          <line x1="22.4" y1="20.8" x2="26.4" y2="20.8" />
        </g>
      ) : (
        <g className="cosmo-eyes">
          <ellipse cx="15.6" cy={eyeY} rx="2.3" ry="2.7" fill="url(#cosmo-eye)" />
          <ellipse cx="24.4" cy={eyeY} rx="2.3" ry="2.7" fill="url(#cosmo-eye)" />
          <circle cx="16.3" cy={eyeY - 1} r="0.7" fill="#fff" />
          <circle cx="25.1" cy={eyeY - 1} r="0.7" fill="#fff" />
        </g>
      )}
      {/* smile + cheeks */}
      <path d="M17 29.6 q3 2 6 0" stroke="#4a7fb5" strokeWidth="1.3" strokeLinecap="round" fill="none" />
      <circle cx="11" cy="28.6" r="1.4" fill="#ff9fb5" opacity="0.65" />
      <circle cx="29" cy="28.6" r="1.4" fill="#ff9fb5" opacity="0.65" />
    </svg>
  );
}
