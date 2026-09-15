// Roadmap 4b-f (2026-09-14, docs/math-entry-design.md §Follow-ups): a
// short-text answer is math on the student's screen, so it is math on the
// teacher's too.
//
// The client previews every non-empty short-text answer as rendered math
// (client/SecureTestCore/.../AssessmentPage.swift, `formulaTex`): the stored
// response is the RAW typed text (`4^2`, `H_2O`, `\frac{1}{2}`), and the
// preview wraps it in `\mathrm{…}`. The review queue, the per-student results
// page and the student-work packet printed that raw text as-is — so the
// teacher read `4^2` where the student saw 4². These two functions mirror the
// client exactly, so both sides agree character for character.
//
// Essays stay plain text everywhere; only `short_text` goes through here.

import katex from "katex";
import { escapeHtml } from "@/lib/escapeHtml";
import { K12_MACROS } from "@/lib/math/renderLatex";

/**
 * The tex the client builds from a typed answer. Byte-for-byte the same
 * transform as `formulaTex`: drop every `$` (the student's own dollars are not
 * delimiters here — the whole field is math), backslash-escape the four
 * characters that are TeX control characters in text mode, trim, collapse
 * whitespace runs to `\ ` (a real space in `\mathrm`), wrap in `\mathrm{…}`.
 * Empty (or whitespace-only) input gives "".
 */
export function shortTextTex(text: string): string {
  const inner = String(text)
    .replace(/\$/g, "")
    .replace(/([%#&~])/g, "\\$1")
    .trim()
    .replace(/\s+/g, "\\ ");
  return inner ? `\\mathrm{${inner}}` : "";
}

/**
 * The answer as HTML: KaTeX when it parses, the escaped plain text when it
 * does not. The client asks KaTeX to THROW (slice S-4) so a half-typed
 * `\frac{` is not painted as red error markup; the same reasoning applies
 * here — a teacher reading an unfinished expression should see what the
 * student typed, not KaTeX's parse message. Never returns unescaped input.
 */
export function renderShortTextAnswer(text: string): string {
  const tex = shortTextTex(text);
  if (tex) {
    try {
      // Fresh shallow macro copy per call — see the long note in
      // lib/math/renderLatex.ts (KaTeX writes into the object it is handed).
      return katex.renderToString(tex, {
        displayMode: false,
        throwOnError: true,
        macros: { ...K12_MACROS },
        output: "html",
        strict: "ignore",
        trust: false,
      });
    } catch {
      // fall through to plain text
    }
  }
  return `<span class="short-text-plain">${escapeHtml(text)}</span>`;
}
