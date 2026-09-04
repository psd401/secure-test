# 0009. KaTeX math rendering — SSR with raw LaTeX in storage

- **Status**: Accepted (design-tool + PoC-B)
- **Date**: 2026-05-21 (PoC-B addendum same day)

## Context

Item stems and choices commonly contain math (fractions, exponents, Greek letters, etc.). Three places need to render it:

1. The design-tool **editor** (`/dashboard/[id]`) so teachers see math while authoring.
2. The design-tool **preview iframe** (`/preview/[id]`) so teachers see what students will see.
3. PoC-B's **WKWebView** (`TestRunner.swift`'s `renderHTML()`) so students see math at test time.

KaTeX is the standard pick for K-12 LaTeX (MathJax is heavier; native MathML is inconsistent across browsers).

A real wrinkle: ADR 0006 deliberately dropped `script-src` from the preview iframe CSP. Client-side KaTeX in the preview would mean re-opening `script-src`.

## Decision

- **Storage**: raw LaTeX text in the DB. No schema or wire-format change. Stem `"What is $x^2$?"` stays that string everywhere.
- **Delimiters**: standard LaTeX `$...$` (inline) and `$$...$$` (display). Backslash-escaped `\$` is treated as a literal `$` (post-escape removal).
- **Rendering strategy**:
  - **Preview iframe**: server-side render via `katex.renderToString()`. Output is pure HTML + inline `<span class="katex">...` markup. ADR 0006's no-`script-src` posture stays intact. KaTeX's minified stylesheet (~24 KB) is inlined into the iframe's `<style>` block via `lib/preview/katexCss.ts`.
  - **Editor**: same `renderLatex()` reached through a Next.js server action (`app/actions/renderMath.ts`). A `MathPreview` client component debounces 300 ms after the last edit, then calls the action and renders the returned HTML below each stem / choice text input. The debounce keeps the round-trip out of every keystroke; the server-side render keeps a single source of truth for what math actually looks like.
- **K-12 macros**: a small allow-list in `lib/math/macros.ts` (`\degree`, `\percent`, `\plusminus`, `\half`, `\third`, `\quarter`). Add sparingly — each macro is one more thing every future implementer has to remember and a breaking change here ripples through every saved stem.
- **Bad LaTeX**: KaTeX's `throwOnError: false` + `errorColor: '#cc0000'` renders the offending expression inline in red. No exception path. The renderer adds a defensive try/catch that emits a `<span class="math-error">` if KaTeX somehow does throw.

## PoC-B (slice 13)

The Swift target now bundles KaTeX under `poc-b-test-loop/client/Sources/PocBClient/Resources/katex/`: `katex.min.css`, `katex.min.js`, `auto-render.min.js`, and the 20 woff2 font files (~592 KB total on disk, all committed). At render time `TestRunner.swift` reads the CSS, strips the `woff` / `ttf` fallback URLs (we don't ship those formats), and base64-inlines each woff2 into a `data:font/woff2;base64,...` URL. The CSS + JS + auto-render are all injected inline into the existing `loadHTMLString` body so the existing CSP posture stays single-string. The CSP now allows `font-src data:` (no `font-src` previously); `script-src 'unsafe-inline'` was already permitted.

After `items.forEach` builds the DOM, the inline JS calls `renderMathInElement(document.body, { delimiters, throwOnError: false, errorColor: '#cc0000', macros: {...} })`. Macros are duplicated from `design-tool/lib/math/macros.ts` into the inline JS literal — **must be kept in sync by hand**. There are six entries; a future codegen script could derive both from the Zod source if drift becomes a problem.

Trade-offs accepted for the inlining approach:
- The rendered HTML string is now ~700 KB (KaTeX JS ~280 KB + base64 fonts ~400 KB + CSS ~24 KB + existing template). `loadHTMLString` handles it without issue, but it's a one-shot cost at app start.
- The `loadFileURL(_:allowingReadAccessTo:)` alternative would skip the base64 inflation, but it changes the page origin to `file://` and would require revisiting `WKNavigationDelegate.decidePolicyFor` to accept `file://` for the initial load. Inline base64 keeps the navigation delegate untouched.

The Resources fixture (`items.json`) gained two math-bearing items (`$\\frac{1}{2}+\\frac{1}{3}$` MC and a Pythagorean short-text with display math) so launching the PoC-B app provides immediate visual verification that math renders correctly.

## Consequences

- **Better**: math works end-to-end in the design-tool today; teachers see live previews; the preview iframe stays CSP-locked at no-`script-src`; the schema package and PoC-B's Swift model didn't have to change. Future S3 / image work is unblocked because nothing about storage changed.
- **Worse**:
  - Editor live preview costs one server round-trip per debounce window (300 ms after last keystroke). At typical typing cadence that's a handful of round-trips per item; the renderer is fast (microseconds) so the bottleneck is HTTP, not CPU.
  - The preview iframe inlines KaTeX CSS that contains `@font-face` rules pointing at `../fonts/*`. With no `font-src` allowance, those rules fail silently and math falls back to system fonts for character glyphs. Layout (fractions, exponents, etc.) is CSS-driven and renders correctly. Enabling proper KaTeX fonts in the preview iframe is a small follow-up — either serve them via a `/api/katex-fonts/*` route + `font-src 'self'`, or base64-inline the woff2 files (~150 KB).
  - Macro names live in two places conceptually: the renderer's allow-list and the teacher's muscle memory. Adding macros is cheap; removing one is a breaking change.
- **Escape hatch**: if SSR ever becomes too slow (it won't — KaTeX is microseconds per render), the editor can swap to client-side KaTeX by adding `katex/dist/katex.js` to the bundle and re-using the same renderer logic in the browser. Preview stays SSR regardless.

## TODO: follow-ups

- [x] ~~**Wire math rendering in PoC-B's WKWebView.**~~ Done in Slice 13.
- [x] ~~**Proper KaTeX fonts in the preview iframe.**~~ Done in Slice 14 (2026-05-21). Vendor script copies the 20 woff2 files into `design-tool/public/katex-fonts/` and rewrites the vendored CSS to point at `/katex-fonts/X.woff2`. The woff and ttf fallback URLs are stripped (we don't ship those formats). Preview CSP gained `font-src 'self'` (both response header and meta tag).
- [ ] **Stem character cap awareness.** The Zod schema caps stems at 10 000 characters; LaTeX-heavy stems can hit that surprisingly fast. Surface a soft warning at, say, 8 000.
- [x] ~~**Codegen the macro set**~~ Done in Slice 16 (2026-05-21). Canonical `K12_MACROS` lives in `packages/schema/src/macros.ts`. The design tool re-exports it via `design-tool/lib/math/macros.ts`. PoC-B has a tiny generator at `poc-b-test-loop/client/scripts/vendor-katex-macros.mjs` that imports the schema source directly (Bun transparently transforms TS), serializes a sorted JSON, and writes `Sources/PocBClient/GeneratedKatexMacros.swift` with a `GeneratedKatexMacros.json` Swift constant. `TestRunner.swift` interpolates that constant directly into its inline JS via Swift string interpolation. Re-run the script after any macros change: `cd poc-b-test-loop/client && bun scripts/vendor-katex-macros.mjs`.

## Addendum 2026-09-01 — the shipping client renders KaTeX

The Phase 5 client (`client/`) replaced PoC-B but only reserved the CSP for
KaTeX (`PageShell.contentSecurityPolicy`: inline script, inline style, `font-src
data:`); the library itself never moved, so every `$…$` in a stem reached the
student as source. Found during E5 slice 2; ported the same night:

- `client/scripts/vendor-katex.mjs` copies `katex.min.js`, `katex.min.css`,
  `contrib/auto-render.min.js` and the 20 woff2 faces from
  `design-tool/node_modules/katex` (so the client renders with the exact version
  the design tool's SSR uses) into `SecureTestCore/Sources/SecureTestCore/Resources/katex/`
  and writes `GeneratedKatexMacros.swift` from `K12_MACROS` (same format as the
  PoC-B generator; `packages/schema/test/macros.test.ts` drift-checks both, and
  that the vendored version matches design-tool's).
- `KatexBundle` (SecureTestCore) loads the assets from the SwiftPM resource
  bundle once, strips the woff/ttf fallback URLs and inlines each woff2 as a
  data URI; `AssessmentPage.html` inlines CSS + library + auto-render + the
  macro constant ahead of the renderer, and the renderer closes with
  `renderMathInElement(root, …)` — `$$…$$` display, `$…$` inline,
  `throwOnError: false`, `errorColor #cc0000`, `strict: 'ignore'`, `trust: false`
  — over everything authored (stems, choices, match sides, sequence labels,
  stimuli; James, 2026-09-01). The call is guarded, so the JavaScriptCore test
  harness and a stripped build simply leave the source visible.
- PoC-B's copy under `poc-b-test-loop/` stays as the historical record.


## Addendum 2026-09-02 — the rest of the authored-content format

The same three renderers (design-tool `renderItemContent`, its print/preview
`renderHtml`, the client page script) now share two more rules beside `$…$`
and `![alt](asset:uuid)`:

- **E6 emphasis:** `**bold**` and `_italic_`, parsed only outside math and
  image refs; an italic run opens at a word boundary and closes before one
  (`snake_case`, `H_2O` outside math and a blank `______` stay literal); runs
  never empty, never start or end with whitespace, never cross a newline; bold
  first, italic inside it; no escape syntax yet. The client builds `strong` /
  `em` elements from text nodes — nothing authored becomes markup. The PDF
  extractor writes the markers from the text layer's font runs (bold / italic
  flags or the BaseFont name), skipping a style that is a page's body face.
- **E7(b) formula answers:** a short-text answer typed with `_` / `^` / `$` /
  `\` previews under the client's field as `\mathrm{…}` through KaTeX; the
  response stays the raw text. The auto scorer compares plain first and,
  only when either side carries formula markup, folds both (`$` and
  `\mathrm{}` unwrap, braces / whitespace / `_` go, `^` stays).

Record: `docs/pdf-import-enhancements.md` E6 and E7.
