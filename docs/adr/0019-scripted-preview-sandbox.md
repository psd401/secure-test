# 0019. Run the student renderer in the editor preview inside an opaque-origin, hash-pinned sandbox

- **Status**: Proposed — prototype behind R-12 only; acceptance before cutover. James accepted the posture as R-3 of `docs/editor-redesign-design.md` (2026-10-25); he has not reviewed this ADR's text. The scripted preview may be built behind the R-12 flag while this is Proposed; Phase 9 (cutover) needs it Accepted.
- **Date**: 2026-10-26
- **Revises**: [ADR 0006](0006-preview-iframe-sandbox.md), for the interactive preview only. ADR 0006 still governs `/preview/[id]` (the static preview, the print variant and every flag-off editor).

## Context

ADR 0006 made the editor's preview safe by giving it no JavaScript at all: `sandbox="allow-same-origin"` without `allow-scripts`, a CSP with no `script-src`, and static HTML from `lib/preview/renderHtml.ts`. That preview is a second renderer. It drifts from the student's page, and it cannot be answered.

The editor redesign decided otherwise (D-1, D-2): the preview runs the same `renderer.js` a student gets (ADR 0018, `packages/renderer`), and a teacher can answer an item and see how it would be scored. ADR 0006's escape hatch named this case and asked for the surface to be examined fresh. That means running script in a frame embedded in a signed-in staff page that holds answer keys. Constraints:

- **ADR 0016.** No answer key may enter the delivery path. The renderer consumes `DeliveryBundleSchema`, which has no field that can hold one. Match and order carry per-attempt sealed option ids instead.
- **The renderer expects the shell.** It reads the page globals `BUNDLE`, `OFFLINE`, `TTS_SCOPE`, `STT_STATE` and `KATEX_MACROS`, calls `katex.render`, and posts to `window.webkit.messageHandlers.<name>` (the handlers listed in `BRIDGE_REQUIRES`, `packages/renderer/src/requires.ts`). It uses no `alert` / `confirm`, storage, `window.open` or `eval`.
- **The student page is already locked down this way.** It is a no-origin document under `default-src 'none'` with no `connect-src`, and answers leave only through named handlers whose payloads are validated as untrusted (`PageShell.contentSecurityPolicy`, openwiki `client/lockdown-and-security.md`). The preview should be no looser, except where a browser frame differs from a WKWebView.
- **No headless browser here** (ADR 0013). The browser-specific parts of this posture are hand-checked, not tested.

## Decision

**1. The frame.** A new route serves a fixed shell document. Its iframe carries:

- `sandbox="allow-scripts"` and **no other token**. No `allow-same-origin`, so the document's origin is opaque: no cookies, no storage, and no credentialed access to the design tool's API. Forms, popups, modals, top-level navigation, downloads and pointer lock all stay blocked.
- `referrerpolicy="no-referrer"`, and `allow=""` so the frame gets no permission-policy features (microphone, camera, and so on).

The route itself requires a staff session (defense in depth). The shell it serves carries **no item content and no answer key**: it is the same bytes for every assessment.

**2. The CSP.** Sent as a response header, and repeated as a `<meta>` without `frame-ancestors`, which only works as a header:

```text
default-src 'none';
script-src 'sha256-<bootstrap>' 'sha256-<katex>' 'sha256-<renderer>';
style-src 'unsafe-inline';
img-src data:; font-src data:;
connect-src 'none'; form-action 'none'; base-uri 'none';
frame-ancestors 'self'
```

- Only three scripts may run, each pinned by hash. **No** `'unsafe-inline'`, `'unsafe-eval'` or host source. R-3 said "only the renderer". The renderer needs KaTeX and a bridge, so this widens it to three fixed scripts: the bootstrap, KaTeX and the renderer. None of them depends on content.
- **No network.** `connect-src 'none'` blocks fetch, XHR, WebSocket and EventSource. With `default-src 'none'` and `img-src data:` / `font-src data:`, no subresource can load either, CSS `url()` included. Pictures arrive as the bundle's base64 `assets`, exactly as on the client.
- `style-src 'unsafe-inline'` matches ADR 0006 and the client page. The renderer and the shell styles are inline.
- **Hashes come from bytes, never from constants.** The route computes each hash from the exact bytes it inlines, so a renderer deploy cannot leave a stale pin behind. A mismatch fails closed: the script is blocked and the preview is blank.

**3. Which renderer.** The route uses the bytes the delivery bundle would name: the current signed renderer (`currentRenderer()`), which has been re-verified against `RENDERER_PUBLIC_KEYS`. If none is named (dev, or `RENDERER_DELIVERY` off), it falls back to the locally built `packages/renderer/dist`. KaTeX and the macros come from the design tool's copy, the same version the client vendors.

**4. Content arrives by `postMessage`, never as script text.** The page globals cannot be inline scripts, because their text would differ per assessment and could not be hash-pinned. Instead:

1. The bootstrap creates a `MessageChannel` and posts one `ready` message (with one port) to `window.parent`.
2. The parent accepts `ready` only when `event.source === iframe.contentWindow`. Checking `event.origin` is not enough: every opaque-origin frame reports `"null"`. The parent keeps the port and sends everything on it from then on.
3. The parent posts `{ bundle, offline, tts_scope, stt_state, katex_macros }` on the port. `bundle` comes from the same delivery projection the student's bundle uses and is parsed by `DeliveryBundleSchema` before it is posted. That schema is strict and has no field for a key, so the gate is structural, not a convention. Match and order get sealed option ids minted for this preview load. Their map back to the real ids stays in the parent.
4. The bootstrap assigns the globals from that message (data only, never evaluated) and then inserts the renderer as an inline `<script>` whose text hashes to the pinned value. Editor changes replace the content the same way, with a new message and a fresh frame document.

**5. A stub bridge answers locally.** The bootstrap defines `window.webkit.messageHandlers` as a stub. Each handler forwards `{handler, body}` on the port, and nothing is sent over the network or recorded.

| Handler | Preview behaviour |
|---|---|
| `response` (and `response.generic`), `withdraw` | The parent stores the answer in memory for this preview only. |
| `submit` | The parent scores the stored answers against **the key the editor already holds** (the item view in `AssessmentEditor`), using the same pure scoring functions the server uses (`lib/scoring/auto.ts`). It shows the result in the **parent's** UI, outside the frame. |
| `tts`, `stt`, `upload`, `timer` | No-op in this ADR. Wiring any of them (for example R-11's read-aloud through the parent's speech synthesis) is a change to this table and needs the same review. |

The parent treats every message from the frame as untrusted input, the way the shell does under ADR 0018. Each body is validated against its handler's shape, unknown handlers are dropped, and nothing from the frame is ever rendered as HTML in the parent. The key, the score and the correct answer **never go into the frame**.

## Consequences

- **Easier.** The preview is the student's renderer, byte for byte, so preview drift (the reason for D-1) ends for the scripted view. Teachers can answer and see the score without a sitting, and no attempt, response or score row is created.
- **Harder.** The preview now runs script beside a signed-in staff page. The boundary is the sandbox, the hash-pinned CSP and the parent's message validation, and all three are browser behaviour this Mac cannot test headlessly.

**Residual risks** (accepted for the prototype unless noted):

1. **Renderer bug, HTML injection.** Item text is built with `textContent`, but a renderer bug could still inject markup. Script would stay blocked by the hashes. CSS and `data:` images could still deface the frame. With no network, nothing can be exfiltrated.
2. **The frame can navigate itself.** The sandbox blocks top-level navigation but not navigation of the frame itself, and CSP has no shipped `navigate-to`. Only script could do it, and only pinned script runs. If it happened, the new document would not hold the port. The parent drops the port and starts the handshake again on every frame `load`, and it posts nothing to `"*"` after the handshake. The most that could leak is the draft item content the parent had already posted, never a key.
3. **Spoofed messages to the parent.** Any window can `postMessage` the editor. The parent accepts only `ready` from `iframe.contentWindow`, and port traffic only from its own channel. A forged `submit` could at most make the parent score answers and show the result to the teacher who is already holding that key.
4. **Same-process frame.** A renderer hang can freeze the editor tab in browsers that keep an opaque-origin frame in the parent's process. Accepted: the preview is opt-in and the editor autosaves (R-5).
5. **The renderer is not signature-checked in the browser.** The server re-verifies the bytes it serves, but the browser trusts the server. That is the same trust the editor page already places in it. In dev, the unsigned `dist` build runs.
6. **Browser support is assumed, not proven.** Slice B must hand-check, in Safari, Chrome and Firefox:
   - a hash source admits a dynamically inserted inline script;
   - an opaque-origin frame sends no cookies on a `fetch` (which the CSP blocks first anyway);
   - the parent's `event.source` check holds.
   If a browser fails the first item, the fallback is to inline the renderer behind a bootstrap guard that waits for the message. The fallback is never `'unsafe-inline'`.
7. **Key boundary drift.** A future change could post the editor's item view (with its key) instead of the projection. Mitigations: the `DeliveryBundleSchema` parse before posting, and a test that the posted payload for keyed fixtures of every item type contains no key value. This is the one risk this ADR treats as **not** accepted: slice B ships that test.

**Escape hatch.** Turning the flag off returns every teacher to the ADR 0006 preview, which this ADR leaves in place. If the posture fails review, the scripted preview is removed and D-2 is reopened. The static preview is not loosened to compensate.
