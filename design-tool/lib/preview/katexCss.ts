// Returns the vendored KaTeX stylesheet (see lib/preview/katex.min.css.ts).
//
// We can't readFileSync from node_modules at request time — Next.js /
// Turbopack rewrites require.resolve paths to `[project]/...` placeholders
// that don't exist on the real filesystem. Instead the CSS is vendored as
// a TS string constant by `bun scripts/vendor-katex-css.mjs`, which is
// re-run after any katex upgrade.
//
// The output is inlined into the preview iframe's <style> block so the
// iframe's `default-src 'none'; style-src 'unsafe-inline'` CSP (ADR 0006)
// stays unchanged. Math fonts fall back to system fonts inside the
// iframe (no font-src allowance) — layout still renders correctly via
// KaTeX's CSS-driven positioning. Proper fonts in the preview is a
// follow-up tracked in ADR 0009.

import { KATEX_CSS } from "./katex.min.css";

export function getKatexCss(): string {
  return KATEX_CSS;
}
