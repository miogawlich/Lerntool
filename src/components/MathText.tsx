import katex from "katex";
import "katex/dist/katex.min.css";
import { useMemo } from "react";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderPlain(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br/>");
}

/** Rendert Text mit $…$ (inline) und $$…$$ / \[…\] (abgesetzt) als KaTeX. */
export function renderMathText(text: string): string {
  const re = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$([^$\n]+?)(?<!\\)\$/g;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += renderPlain(text.slice(last, m.index));
    const display = m[1] ?? m[2];
    const tex = display ?? m[3] ?? m[4] ?? "";
    out += katex.renderToString(tex, { displayMode: display !== undefined, throwOnError: false, strict: "ignore" });
    last = (m.index ?? 0) + m[0].length;
  }
  out += renderPlain(text.slice(last));
  return out.replace(/\\\$/g, "$");
}

export function MathText({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMathText(text ?? ""), [text]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
