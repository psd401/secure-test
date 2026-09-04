"use client";

import { useEffect, useState } from "react";
import { renderContent } from "@/app/actions/renderContent";

interface Props {
  text: string;
  /** ms to wait after the last edit before calling the server action. */
  debounceMs?: number;
}

// Live preview of a single stem / choice text field. Calls the
// renderContent server action on a debounce so the editor shows
// SSR-rendered math + images while the teacher types. Skips the
// round-trip when the text contains neither `$` math markers nor
// `![](asset:...)` image refs.
export function MathPreview({ text, debounceMs = 300 }: Props) {
  const [html, setHtml] = useState<string>("");
  const [busy, setBusy] = useState(false);
  // E6 (2026-09-02, row 39): emphasis markers count as "interesting" too,
  // so a stem like "Which factor is **ABIOTIC**?" previews in its card and
  // the teacher sees the bold rather than the asterisks.
  const interesting =
    !!text && (text.includes("$") || text.includes("](asset:") || /\*\*|(^|\s)_[^_\s]/.test(text));

  useEffect(() => {
    if (!interesting) {
      setHtml("");
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const out = await renderContent(text);
        if (!cancelled) setHtml(out);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, debounceMs, interesting]);

  if (!interesting) return null;

  return (
    <div className="mt-1 rounded-md border border-dashed border-border bg-muted px-3 py-1.5 text-sm">
      <span className="mr-2 text-xs uppercase tracking-wide text-muted-foreground">
        preview{busy ? "…" : ""}
      </span>
      {/* renderContent output is server-side rendered: text is
          HTML-escaped, math is KaTeX, images are <img> tags pointing
          at session-scoped /api/assets/<uuid>. Unresolved refs come
          back as inline red placeholders — no injection vector. */}
      <span dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
