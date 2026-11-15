import { Link } from "react-router-dom";

export const UNIDENTIFIED_TEXT = "Unidentified candidate – needs further scientific investigation. Not a claim of Planet X.";

/** Shown with every REAL mover that has no catalogue match. Links to the Planet X Lab, which only tests with SIMULATED objects. */
export function UnidentifiedNote({ className }: { className?: string }) {
  return (
    <div className={className} style={{ fontSize: 11.5, lineHeight: "16px" }}>
      <span className="text-warn">{UNIDENTIFIED_TEXT}</span>{" "}
      <Link to="/planetx" className="link whitespace-nowrap">
        Could we detect Planet X? Test it →
      </Link>
    </div>
  );
}
