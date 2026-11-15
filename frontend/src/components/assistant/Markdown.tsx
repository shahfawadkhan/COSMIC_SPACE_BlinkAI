import { Fragment, type ReactNode } from "react";

/** Safe Markdown subset for chat answers (no raw HTML): headings, paragraphs, bullet and numbered
 * lists (one level of nesting), tables, fenced code, rules, **bold**, *italic*, `code`,
 * [links](https://…) and [S1]-style citations. Parsed line by line, so a sentence followed
 * directly by a list (the usual LLM style) renders correctly. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|\[S\d+\](?:\[S\d+\])*|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith("**") || t.startsWith("__")) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k} className="md-code">{t.slice(1, -1)}</code>);
    else if (/^\[S\d+\]/.test(t))
      t.match(/S\d+/g)!.forEach((s, j) => out.push(<sup key={`${k}-${j}`} className="md-cite">{s}</sup>));
    else if (t.startsWith("[")) {
      out.push(<a key={k} href={m[2]} target="_blank" rel="noreferrer" className="link">{t.slice(1, t.indexOf("]"))}</a>);
    } else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; lines: string[] }
  | { t: "list"; ordered: boolean; items: { text: string; sub: string[] }[] }
  | { t: "table"; rows: string[] }
  | { t: "code"; text: string }
  | { t: "hr" };

const LIST_RE = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/;

function parse(src: string): Block[] {
  const lines = src.replace(/\r/g, "").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(l)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ t: "code", text: body.join("\n") });
      continue;
    }
    const h = /^\s*(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      blocks.push({ t: "h", level: h[1].length, text: h[2].replace(/#+\s*$/, "") });
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(l)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    if (l.trim().startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(lines[i++]);
      blocks.push({ t: "table", rows });
      continue;
    }
    const lm = LIST_RE.exec(l);
    if (lm) {
      const ordered = /\d/.test(lm[2]);
      const base = lm[1].length;
      const items: { text: string; sub: string[] }[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (!cur.trim()) {
          // a blank line inside a list: continue only if the list goes on
          const next = lines.slice(i + 1).find((x) => x.trim());
          if (next && LIST_RE.test(next)) {
            i++;
            continue;
          }
          break;
        }
        const m = LIST_RE.exec(cur);
        if (m && m[1].length <= base + 1) items.push({ text: m[3], sub: [] });
        else if (m && items.length) items[items.length - 1].sub.push(m[3]);
        else if (/^\s{2,}\S/.test(cur) && items.length) items[items.length - 1].text += " " + cur.trim();
        else break;
        i++;
      }
      blocks.push({ t: "list", ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !LIST_RE.test(lines[i]) && !/^\s*(#{1,6}\s|```|\|)/.test(lines[i])) para.push(lines[i++]);
    blocks.push({ t: "p", lines: para });
  }
  return blocks;
}

export function Markdown({ text }: { text: string }) {
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  return (
    <div className="md">
      {parse(text).map((b, bi) => {
        const k = String(bi);
        switch (b.t) {
          case "h":
            return (
              <div key={k} className={b.level <= 2 ? "md-h2" : "md-h3"}>
                {inline(b.text.replace(/^\*\*(.*)\*\*$/, "$1"), k)}
              </div>
            );
          case "hr":
            return <hr key={k} className="md-hr" />;
          case "code":
            return (
              <pre key={k} className="md-pre">
                <code>{b.text}</code>
              </pre>
            );
          case "table": {
            const [head, ...body] = b.rows.filter((l) => !/^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(l));
            return (
              <div key={k} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {cells(head).map((c, ci) => (
                        <th key={ci}>{inline(c, `${k}-h${ci}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {body.map((r, ri) => (
                      <tr key={ri}>
                        {cells(r).map((c, ci) => (
                          <td key={ci}>{inline(c, `${k}-${ri}-${ci}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          case "list": {
            const L = b.ordered ? "ol" : "ul";
            return (
              <L key={k} className={b.ordered ? "md-ol" : "md-ul"}>
                {b.items.map((it, ii) => (
                  <li key={ii}>
                    {inline(it.text, `${k}-${ii}`)}
                    {it.sub.length > 0 && (
                      <ul className="md-ul">
                        {it.sub.map((s, si) => (
                          <li key={si}>{inline(s, `${k}-${ii}-${si}`)}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </L>
            );
          }
          default:
            return (
              <p key={k}>
                {b.lines.map((l, li) => (
                  <Fragment key={li}>
                    {li > 0 && <br />}
                    {inline(l, `${k}-${li}`)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
