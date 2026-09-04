/**
 * The XSS chokepoint for every server-rendered HTML surface.
 *
 * Escapes the five characters that can break out of HTML text or an attribute
 * value: `&` first (so the replacements below aren't double-escaped), then the
 * tag delimiters and both quote styles. `'` becomes the numeric `&#39;` rather
 * than `&apos;` because the named entity is not in the HTML 4 entity set.
 *
 * This lived as three byte-identical private copies — lib/math/renderLatex.ts,
 * lib/preview/renderHtml.ts, lib/items/renderItemContent.ts. They happened to
 * agree, but nothing kept them agreeing: hardening one copy would silently
 * leave the other two behind, on the one function where that matters most.
 * Import this; do not re-declare it.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
