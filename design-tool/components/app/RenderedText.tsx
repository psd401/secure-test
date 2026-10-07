"use client";

import { useEffect, useState } from "react";
import { renderContent } from "@/app/actions/renderContent";

// S-f-1 (docs/multi-source-stimulus-design.md, Row S-f sitting 2026-09-09):
// the importer writes money as `\$57,600` so the renderers never open math
// on it (C-2). The plain-text fallback below drops only that escape; the
// stored text keeps it.
export function cardText(stem: string): string {
  return stem.replace(/\\\$/g, "$");
}

/** True when the text carries anything renderContent would change. */
export function needsRendering(text: string): boolean {
  return text.includes("$") || text.includes("](asset:") || /\*\*|(^|\s)_[^_\s]/.test(text);
}

// A read-only proposal (Generate questions, PDF import) renders its text
// once — math as KaTeX, **bold** / _italic_, images — through the same
// server action as the editor's MathPreview, instead of raw text beside a
// preview. Plain text (nothing to render) skips the round-trip; until the
// HTML arrives, or if the action returns nothing, the raw text shows.
export function RenderedText({ text, className }: { text: string; className?: string }) {
  const interesting = needsRendering(text);
  const [html, setHtml] = useState<string>("");
  useEffect(() => {
    if (!interesting) return;
    let cancelled = false;
    void renderContent(text).then((out) => {
      if (!cancelled) setHtml(out);
    });
    return () => {
      cancelled = true;
    };
  }, [text, interesting]);
  // renderContent output is server-rendered: text HTML-escaped, math is
  // KaTeX, images point at session-scoped /api/assets — the same trust as
  // MathPreview.
  if (interesting && html) {
    return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <span className={className}>{cardText(text)}</span>;
}
