"use client";

import { useState } from "react";
import katex from "katex";
import { translateMath } from "@/app/actions/translateMath";

interface Props {
  onInsert: (latex: string, displayMode: "inline" | "display") => void;
}

// Inline panel for converting natural-language math descriptions into
// LaTeX. Always-on (unlike the assessment.allow_llm_authoring-gated
// item generator). The mock provider handles common K-12 phrasings —
// fractions, exponents, sqrt, plus/minus/times/divided — and echoes
// `[TRANSLATE-MOCK: …]` for anything it doesn't recognize so the
// teacher sees clearly when the mock fell short.
//
// On Insert the panel emits the LaTeX wrapped per the chosen display
// mode: `$...$` (inline) or `$$...$$` (display). The parent decides
// how to splice that into the underlying field.
export function MathTranslator({ onInsert }: Props) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [displayMode, setDisplayMode] = useState<"inline" | "display">("inline");
  const [busy, setBusy] = useState(false);
  const [latex, setLatex] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onTranslate() {
    setError(null);
    setLatex(null);
    setBusy(true);
    try {
      const res = await translateMath({ prompt, display_mode: displayMode });
      if (!res.ok) {
        setError(res.error ?? "translate_failed");
        return;
      }
      setLatex(res.latex ?? "");
      setProvider(res.provider ?? null);
    } catch (e) {
      setError(`translate: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function onInsertClick() {
    if (!latex) return;
    const wrapped = displayMode === "display" ? `$$${latex}$$` : `$${latex}$`;
    onInsert(wrapped, displayMode);
    // Reset and close so subsequent inserts feel like fresh translations.
    setOpen(false);
    setPrompt("");
    setLatex(null);
  }

  // SSR-equivalent preview — the same KaTeX call the renderer uses,
  // run client-side here so the proposal previews instantly before
  // insertion.
  let previewHtml = "";
  if (latex) {
    try {
      previewHtml = katex.renderToString(latex, {
        displayMode: displayMode === "display",
        throwOnError: false,
        errorColor: "#cc0000",
        output: "html",
        strict: "ignore",
      });
    } catch {
      previewHtml = "";
    }
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent"
      >
        {open ? "Hide math" : "Math…"}
      </button>
      {open ? (
        <div className="mt-2 rounded-md border border-border bg-muted p-3 space-y-2">
          <label className="block text-xs">
            Describe in words (e.g. "one half plus one third", "x squared minus 4")
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
          </label>
          <div className="flex items-center gap-3 text-xs">
            <label>
              <input
                type="radio"
                name="dispmode"
                checked={displayMode === "inline"}
                onChange={() => setDisplayMode("inline")}
              />{" "}
              Inline ($…$)
            </label>
            <label>
              <input
                type="radio"
                name="dispmode"
                checked={displayMode === "display"}
                onChange={() => setDisplayMode("display")}
              />{" "}
              Display ($$…$$)
            </label>
            <button
              type="button"
              onClick={onTranslate}
              disabled={busy || prompt.trim().length === 0}
              className="ml-auto rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Translating…" : "Translate"}
            </button>
          </div>

          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : null}

          {latex ? (
            <div className="rounded-md border border-border bg-background p-2 space-y-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                proposed {provider ? <>· <code>{provider}</code></> : null}
              </div>
              <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                {displayMode === "display" ? `$$${latex}$$` : `$${latex}$`}
              </code>
              <div
                className="rounded border border-dashed border-border px-2 py-1 text-sm"
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onInsertClick}
                  className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
                >
                  Insert at end
                </button>
                <button
                  type="button"
                  onClick={() => setLatex(null)}
                  className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
                >
                  Discard
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
