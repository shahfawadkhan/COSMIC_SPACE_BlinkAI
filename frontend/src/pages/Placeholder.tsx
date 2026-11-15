import { Link } from "react-router-dom";

export default function Placeholder({ title, text }: { title: string; text: string }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-14">
        <h1 className="h1 m-0" style={{ fontSize: 32 }}>
          {title}
        </h1>
        <p className="mt-3 text-ink2" style={{ fontSize: 16 }}>
          {text}
        </p>
        <div className="card mt-6 p-4 text-ink2">
          This page arrives in a later build step. Meanwhile, the{" "}
          <Link to="/explorer" className="link">
            Blink Explorer
          </Link>{" "}
          works on real SPHEREx data.
        </div>
      </div>
    </div>
  );
}
