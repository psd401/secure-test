# 0013. PDF for print accommodations — client-side print, not a headless-Chrome route

- **Status**: Accepted
- **Date**: 2026-06-23

## Context

Slice 34 ("PDF export for print accommodations", `docs/phase-2-slices.md`) needs to produce a paper version of an assessment for students whose accommodations call for a printed test. The design-tool already renders an assessment to static, CSP-hardened HTML (`lib/preview/renderHtml.ts`, ADR 0006), so "PDF just consumes the preview" — no new content model is required.

The drafted plan (`design-tool-plan.md:33`, `docs/phase-2-slices.md` slice 34) was a **server route** that launches headless Chromium via `@sparticuz/chromium-min` + `playwright-core` and renders `renderAssessmentHtml` output to a PDF byte stream.

Before adding those dependencies, we de-risked the engine with a throwaway spike. **Headless Chrome does not run in this environment:**

- System Google Chrome 149 `--headless=new --print-to-pdf` on a trivial 4-line HTML page hung for **3m45s** and produced no output before being killed (should take < 1s).
- The Playwright-MCP browser failed to launch twice earlier in the same session, each timing out at **180s**.

A server `/pdf` route that can neither be developed nor verified locally is not shippable here. Separately, a headless renderer would not carry the teacher's session cookie, so the auth-gated `<img src="/api/assets/<uuid>">` images in stems would need data-URI inlining — extra work that only exists to serve the headless path.

## Decision

**Ship client-side print; do not add a headless-Chrome server route.**

- `renderAssessmentHtml` gains a `printMode` option (`RenderOptions`). In print mode it: drops the teacher-only preview banner and the Tier-1 accommodations toolbar; renders MC choices as blank mark boxes (round for single-select, square for multi) plus a letter the student marks; renders short-text as a blank write-line and essay as a tall write-area; adds `@page` margins and an `@media print` block (`break-inside: avoid`, forced light page) so output is correct even from a dark-mode tab; drops the "— preview" title suffix so the browser's Save-as-PDF filename is just the assessment name.
- `GET /preview/:id?print=1` serves the print variant — same owner-scoped auth and hardened CSP as the screen preview.
- The editor's Preview section has a "Print / Save as PDF" link that opens `?print=1` in a new tab. The no-script preview and its `sandbox="allow-same-origin"` iframe (ADR 0006) can't host a print button themselves, so the affordance lives on the editor (React) page.
- The teacher prints from their own (non-headless) browser → Save as PDF. Because that browser carries their session cookie, same-origin asset images resolve normally — **no data-URI inlining needed**. No new dependencies.

## Consequences

- **Better**: works in this environment today; zero new dependencies; full fidelity (KaTeX, fonts, images all resolve on the live page in a real browser); reuses the existing CSP-hardened renderer. Genuinely delivers "a printable test for print accommodations."
- **Worse**: not a programmatic endpoint — a human drives the print. There is no API that returns a PDF byte stream, so batch/server-side PDF generation (e.g. "email every student their paper form") is not possible yet.
- **Deferred / escape hatch**: the spike hang looks specific to this macOS dev box. On a Linux deploy target (container or Lambda) where headless Chromium launches reliably, a server-side `/pdf` route remains viable and would supersede the relevant part of this ADR. The `printMode` HTML this slice produces is exactly what such a route would feed to the renderer, so that work is additive, not a rewrite.
- **Testing note**: `printMode` rendering is unit-tested in `test/preview-render.test.ts`; the route's `?print=1` parsing is a one-line query read into that tested renderer and is covered by live verification rather than a new preview-route harness (none exists).
