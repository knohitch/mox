import { Fragment, type ReactNode } from "react";

/**
 * Minimal, safe markdown renderer for chat bubbles (Prompt 05 "high-quality
 * markdown"): fenced code, headings, bold/italic/code spans, lists, links.
 * No HTML injection — text nodes only.
 */

export function Markdown({ text }: { text: string }) {
  return <div className="md">{renderBlocks(text)}</div>;
}

function renderBlocks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        buf.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // closing fence
      out.push(
        <div className="aw-code-block" key={key++}>
          <div className="aw-code-header">
            <span>{lang || "Code"}</span>
            <button className="aw-copy-btn" onClick={() => navigator.clipboard.writeText(buf.join("\n"))}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              Copy
            </button>
          </div>
          <pre data-lang={lang}>
            <code>{buf.join("\n")}</code>
          </pre>
        </div>,
      );
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const Tag = (`h${Math.min(level + 2, 6)}`) as "h3";
      out.push(<Tag key={key++}>{inline(heading[2] ?? "")}</Tag>);
      i += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^[-*]\s+/, ""));
        i += 1;
      }
      out.push(
        <ul key={key++}>
          {items.map((it, n) => (
            <li key={n}>{inline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\d+\.\s+/, ""));
        i += 1;
      }
      out.push(
        <ol key={key++}>
          {items.map((it, n) => (
            <li key={n}>{inline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    // Paragraph: consume until blank line.
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !/^(#|```|[-*]\s|\d+\.\s)/.test(lines[i] ?? "")) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    out.push(<p key={key++}>{inline(para.join(" "))}</p>);
  }
  return out;
}

function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g).filter(Boolean);
  return (
    <>
      {parts.map((part, n) => {
        if (part.startsWith("**") && part.endsWith("**")) return <strong key={n}>{part.slice(2, -2)}</strong>;
        if (part.startsWith("`") && part.endsWith("`")) return <code key={n}>{part.slice(1, -1)}</code>;
        if (part.startsWith("*") && part.endsWith("*") && part.length > 2) return <em key={n}>{part.slice(1, -1)}</em>;
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        if (link) {
          return (
            <a key={n} href={link[2]} target="_blank" rel="noreferrer">
              {link[1]}
            </a>
          );
        }
        return <Fragment key={n}>{part}</Fragment>;
      })}
    </>
  );
}
