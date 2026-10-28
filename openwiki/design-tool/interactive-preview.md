---
type: Feature Reference
title: Interactive student preview in the item editor
description: The side-by-side student preview in the R-12 item editor (editor redesign Phase 5, ADR 0019). It runs the student's own signed renderer inside an opaque-origin, hash-pinned sandbox frame, keeps answer keys out of the frame, and scores "Finish and hand in" in the editor page.
tags: [authoring, preview, sandbox, renderer, security]
openwiki:
  roles: [architecture, domain, integration]
  change_kinds: [preview, security-boundary, protocol, bundle-projection]
  source_paths:
    - design-tool/app/preview/shell/route.ts
    - design-tool/app/dashboard/[id]/InteractivePreview.tsx
    - design-tool/lib/preview/interactive/bundle.ts
    - design-tool/lib/preview/interactive/protocol.ts
    - design-tool/lib/preview/interactive/shell.ts
    - design-tool/lib/preview/interactive/shellParts.ts
    - design-tool/lib/preview/interactive/score.ts
    - design-tool/lib/preview/interactive/speech.ts
    - design-tool/lib/api/deliveryItem.ts
  symbols: [InteractivePreview, buildPreviewBundle, createPreviewSealer, acceptReady, parseFrameMessage, buildPreviewShell, previewCsp, loadPreviewRenderer, scorePreview, deliveredItem, DeliveryBundleSchema]
  test_paths:
    - design-tool/test/preview-interactive.test.ts
    - design-tool/test/preview-shell.test.ts
  invariants:
    - No answer key, correct choice or correct answer value is ever posted into the frame; the bundle is parsed by DeliveryBundleSchema before posting.
    - The frame runs with sandbox="allow-scripts" only (opaque origin); the editor accepts its ready message only from the iframe's own contentWindow.
    - The shell route answers 404 unless the signed-in staff member has the R-12 flag on.
    - Scoring happens in the editor page against the editor's own key; the preview creates no attempt, response or score rows.
  validation_commands:
    - cd design-tool && bun test test/preview-interactive.test.ts test/preview-shell.test.ts
---

# Interactive student preview

The interactive preview is the right-hand panel of the [authoring editor](new-authoring-editor.md). It shows the question list as a student would see it, runs the same `renderer.js` a student's client runs, and lets a teacher answer and see the score without starting a sitting. It is part of the R-12 flag: with the flag off, the editor keeps the static preview at `/preview/[id]` described in [assessment authoring](authoring.md#preview-and-print) (ADR 0006).

The posture is recorded in [ADR 0019](../../docs/adr/0019-scripted-preview-sandbox.md), which revises ADR 0006 for this preview only. This page describes what the source does. The ADR's residual-risk list is the reference for review.

## The frame and its CSP

`GET /preview/shell` (`app/preview/shell/route.ts`) serves one fixed document for every assessment. It holds no item content and no key. The route requires a staff session and the R-12 flag (`isNewAuthoringEnabled`), and answers 404 to everyone else. Its response carries a Content-Security-Policy built by `previewCsp` (`lib/preview/interactive/shell.ts`): `default-src 'none'`, three hash-pinned scripts (bootstrap, KaTeX and the renderer), no `connect-src`, `data:` only for images and fonts, `frame-ancestors 'self'`, and `sandbox allow-scripts`. The hashes come from `buildPreviewShell` over the exact bytes it inlines, so a renderer change cannot leave a stale pin; a mismatch blocks the script and the preview stays blank.

The renderer bytes come from `loadPreviewRenderer` (`lib/preview/interactive/shellParts.ts`): the current signed renderer that the delivery bundle would name (see [signed renderer delivery](../client/signed-renderer.md)), or the local `packages/renderer/dist` build when none is named. KaTeX and the base page styles are vendored copies. Their generators are `scripts/vendor-katex-js.mjs`, `scripts/vendor-katex-css.mjs` and `scripts/vendor-page-shell.ts`, and the `.ts` outputs are generated, so change the generator rather than the output.

The editor embeds the frame in `InteractivePreview.tsx` with `sandbox="allow-scripts"` and `allow=""`. The frame therefore has no origin, no cookies and no storage, and cannot call the design tool's API.

## Handshake and live refresh

The frame cannot read the page's data. Content arrives over a `MessageChannel` after the frame announces itself.

```mermaid
sequenceDiagram
  participant Ed as InteractivePreview (editor page)
  participant Fr as Shell frame (bootstrap + renderer)
  Ed->>Fr: iframe loads GET /preview/shell
  Fr->>Ed: ready (one MessagePort)
  Note over Ed: acceptReady: event.source must be the iframe window
  Ed->>Fr: load {bundle, offline, tts_scope, stt_state, katex_macros}
  Fr->>Ed: rendered {linked, items}
  Fr->>Ed: bridge {handler: response, body}
  Note over Ed: answer kept in memory, never saved
  Fr->>Ed: bridge {handler: submit}
  Note over Ed: scorePreview against the editor's key; result shown outside the frame
```

Caption: the editor-to-frame handshake for one preview document. Each edit to the editor state builds a new frame document after a 600 ms debounce.

- `acceptReady` (`lib/preview/interactive/protocol.ts`) accepts `ready` only when `event.source` is the iframe's `contentWindow`, with the expected protocol type and version, and exactly one port. The origin is not checked, because every opaque-origin frame reports `"null"`.
- Every message from the frame is untrusted. `parseFrameMessage` validates its shape, and unknown kinds and handlers are dropped. Nothing from the frame is rendered as HTML by the editor.
- Live refresh builds a standby frame. It loads hidden behind the shown frame and replaces it once it reports `rendered`, so the preview does not blank while the teacher types. A frame that never renders within 20 seconds is reported as failed.
- Answers given so far ride into the next frame as `saved_responses`, so they survive a refresh. The sealer (`createPreviewSealer`) keeps sealed ids stable for one editor session.

## The bundle and the key boundary

`buildPreviewBundle` (`lib/preview/interactive/bundle.ts`) builds the delivery bundle from the editor's unsaved state. Each item goes through `deliveredItem` in `lib/api/deliveryItem.ts`, the same per-item projection that the student's delivery route uses in [sittings and attempts](sittings-and-attempts.md). The whole bundle is parsed by `DeliveryBundleSchema` (see [wire formats](../architecture/wire-formats.md)), which has no field that can hold a key. Match and order items get sealed option ids minted for this editor session, and the map back to real ids stays in the editor page (ADR 0016).

Because the bundle is built from drafts, an item or set too incomplete for the delivery schema (for example, one choice and no pairs) is left out and listed as skipped, rather than failing the whole preview. The projection is shared with delivery, so a change to `deliveredItem` changes the student's bundle too.

## Scoring and the stub bridge

The frame's renderer calls `window.webkit.messageHandlers`. The bootstrap supplies a stub, and the editor answers each handler locally. Nothing reaches a server or the database.

| Handler | Behaviour in the preview |
|---|---|
| `response`, `response.generic`, `withdraw` | Stored in the editor page's memory for this preview only. |
| `submit` | `scorePreview` (`lib/preview/interactive/score.ts`) scores the stored answers against the editor's key with `scoreResponse` from `lib/scoring/auto.ts`, the same pure scoring the server uses. The result appears below the frame. |
| `tts` | Read-aloud through the browser's speech synthesis, using on-device English voices only (`localService`). Word boundaries are relayed back for highlighting (`lib/preview/interactive/speech.ts`). |
| `stt`, `upload`, `timer`, `home` | No-op. Drawing bytes are dropped in the bootstrap and never leave the frame. |

The ADR's handler table is the review record. Wiring any other handler is a change to that table and needs the same review.

## Change navigation

- Changing what a student's bundle contains: start in `lib/api/deliveryItem.ts`, then `lib/preview/interactive/bundle.ts`. Run `cd design-tool && bun test test/preview-interactive.test.ts`, then `delivery-api.test.ts` with `DATABASE_URL` set to the test database, because both the student route and the preview depend on the projection.
- Changing the posted payload or the key boundary: the test "the posted bundle (ADR 0019 risk 7: no key reaches the frame)" in `test/preview-interactive.test.ts` holds a keyed fixture of every item type to "no key field or key value in the payload". A change that trips it is the boundary the ADR forbids, not a test to relax.
- Changing the protocol: edit `protocol.ts` and the bootstrap together. The bootstrap is inside the shell, so the drift and bootstrap tests in `test/preview-shell.test.ts` must still pass.
- Changing the frame's CSP or shell: `shell.ts`, `shellParts.ts` and `app/preview/shell/route.ts`. Regenerate vendored inputs with their generators. Do not hand-edit `pageShell.generated.ts` or the `katex.min.*.ts` files.
- Scope boundary: browser behaviour (the sandbox, hash-pinned inline scripts, the `event.source` check, read-aloud voices, the layout) is not covered by any test in this repository. ADR 0019 treats it as hand-checked, and the hand-check rows are tracked outside this wiki. Do not claim a browser behaviour is verified from the Bun tests.

## Focused tests

- `test/preview-interactive.test.ts`: the posted bundle's key boundary (`the posted bundle (ADR 0019 risk 7: no key reaches the frame)`), the sealer (`the sealer`), the protocol's acceptance rules (`the protocol: what the editor page accepts from the frame`), local scoring (`local scoring against the editor's key`) and read-aloud ranges (`read-aloud: segments → one utterance → word ranges`). These do not need the database.
- `test/preview-shell.test.ts`: the CSP and hashes (`the frame document and its CSP`), the drift check between the shell's inlined client bytes and the client's (`the client bytes the frame inlines are the client's (drift)`), the bootstrap running the real renderer in the client harness's DOM shim (`the bootstrap, running the student's renderer`), and the route's gating (`GET /preview/shell`). The route block reads the R-12 flag from the database, so run it with `DATABASE_URL` pointed at the test database, as other route tests are.
- Related static-preview tests: `test/preview-render.test.ts` covers the ADR 0006 `/preview/[id]` HTML, which is a separate renderer.

## Related pages

- The editor that hosts the panel, the flag and the autosave it shares with the rest of the editor: [authoring editor](new-authoring-editor.md).
- The student renderer and its signed delivery: [signed renderer delivery](../client/signed-renderer.md) and [client overview](../client/overview.md).
- The scoring rules `scorePreview` reuses: [scoring and results](scoring-and-results.md).
.
