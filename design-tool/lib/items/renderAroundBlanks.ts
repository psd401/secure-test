// FB-S1 (2026-10-07 v1.6.0 sitting, teacher side): a fill-in-the-blank stem
// used to be rendered segment by segment between its markers, so emphasis
// that spans a blank — `**[[b1]]**`, `_the [[b1]] gap_` — was cut in two and
// printed literal `**` / `_`. This renders the stem WHOLE: the text between
// blanks is joined with a private-use sentinel, rendered once through
// renderItemContent (emphasis, KaTeX, pictures — it escapes its own text),
// and each sentinel in the output is replaced by that blank's markup, so a
// blank sits inside its <strong> / <em>. The client does the same in the
// student page (AssessmentPage.swift fillBlankField).
//
// When a sentinel does not come back as plain text — a marker written inside
// a formula, or inside a picture's alt text — the whole stem falls back to
// the old segment-by-segment rendering, which is always well-formed.

import { renderItemContent, type ResolvedAsset } from "@/lib/items/renderItemContent";

const SENTINEL = "";

/**
 * `texts` has one more entry than `slots`: texts[0], slots[0], texts[1], …
 * Text is raw stem source; slot HTML is the caller's own (already safe) markup.
 */
export function renderAroundBlanks(
  texts: readonly string[],
  slots: readonly string[],
  resolved: Map<string, ResolvedAsset>,
): string {
  const clean = texts.map((t) => t.split(SENTINEL).join(""));
  const segmented = () =>
    clean.map((t, i) => renderItemContent(t, resolved) + (i < slots.length ? slots[i] : "")).join("");
  if (slots.length === 0) return segmented();

  const pieces = renderItemContent(clean.join(SENTINEL), resolved).split(SENTINEL);
  if (pieces.length !== slots.length + 1) return segmented();
  // A sentinel inside a tag (an attribute value) is not a place for markup.
  for (let i = 0; i < slots.length; i++) {
    const piece = pieces[i]!;
    if (piece.lastIndexOf("<") > piece.lastIndexOf(">")) return segmented();
  }
  let html = pieces[0]!;
  for (let i = 0; i < slots.length; i++) html += slots[i]! + pieces[i + 1]!;
  return html;
}
