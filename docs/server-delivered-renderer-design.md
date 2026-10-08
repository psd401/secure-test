# Server-delivered renderer — a stable signed shell, page code from the server

Design note, 2026-10-08. Roadmap: the v2.0 discussion item (2026-10-07,
`docs/roadmap-2026-09.md`, row FB). ADR 0018 (Proposed) records the
security trade-off. Nothing built.

**Trigger.** Every change to what a student sees needs a client release:
psd-sign, `gh release create`, IT's AutoPkg run (next-day delivery), and
for a new item type a delivery version gate (row FB D-4). Most recent
releases were mainly page code — T-1's CSS (v1.3.1), keyboard reach
(v1.3.5), most of autosave (v1.3.4), fill in the blank + rich text
(v1.6.0). The model is the College Board's Bluebook-style split: a
stable, rarely updated app that locks the Mac, and the test experience
fetched at the start of a session.

## What the client is today (measured 2026-10-08)

- `AssessmentPage.html()` assembles ONE HTML string: KaTeX (vendored,
  ~270 KB), the bundle JSON, a few config lines (`OFFLINE`, the TTS scope,
  the STT pre-flight result, KaTeX macros) and `rendererScript`, plus
  `itemStyles` / `richTextStyles`. `AssessmentViewController` loads it with
  `loadHTMLString(html, baseURL: nil)` — a no-origin document.
- The page code sits in Swift string literals: `AssessmentPage.swift` +
  `AssessmentPageRichText.swift` ≈ 6,750 lines / 330 KB with comments.
  `InstantFeedbackPage.swift` carries its own `styles` + `script`.
- The page CSP (`PageShell.contentSecurityPolicy`) is `default-src 'none'`,
  inline script / style only, `data:` fonts and images: **the page cannot
  fetch anything**. Data leaves only through 8 `WKScriptMessage` handlers —
  `response`, `withdraw`, `upload`, `submit`, `timer`, `home`, `tts`,
  `stt` — and Swift calls into the page in 9 places.
- Swift decodes every item (`DeliveryItem.swift`) and refuses an unknown
  item type or blank kind — the reason a new type needs a release today.

## The proposal

The renderer (page JS + its CSS, both pages — test and instant feedback)
is built and served by the design tool. The shell fetches it before
`begin()`, verifies it, and inlines it into the same no-origin document it
builds today. The page CSP stays as it is: the WebView still never fetches
code; the native shell does, and checks it first.

**Stays in the signed shell:** lockdown (`AssessmentLockdown`, the
page-load gate, exits, watchdog posture), sign-in, configuration, the
spool + uploads + deferred rows, the countdown and its notices, speech
(TTS / STT engines, pre-flight), the peek responder, crash / error log,
KaTeX (a library, rarely changes — 3.3 below), the bridge handlers and
their validation.

**Moves to the server:** `rendererScript`, `itemStyles`,
`richTextStyles`, the instant-feedback page's script + styles, the page
side of every item type.

## Delivery — inside the bundle vs a separate asset (§1.1, to decide)

**(A) Inside the delivery bundle** — the bundle gains
`renderer: { version, script, styles }`.

- \+ One fetch, one failure mode; content and renderer always come from
  the same server revision, so they can never disagree.
- \+ Nothing to cache, nothing stale.
- − ~330 KB (≈ 70–90 KB gzipped, estimate) on every delivery AND every
  resume; a whole class joining at once multiplies it.
- − Puts code into the student wire format ADR 0016 keeps deliberately
  narrow (data only — no key can be expressed). Code is not a key, but
  the bundle stops being pure data.
- − Signing it separately (§2) means a signature over a field inside a
  JSON document — workable, awkward.

**(B) A separate, versioned asset** — the bundle names
`renderer: { version, sha256 }`; the shell fetches
`/api/renderer/<version>` once and caches it by hash in the app's
container.

- \+ Fetched once per Mac per version; a resume or a second test reuses
  the cache; the burst at the start of a class is the bundle only.
- \+ The bundle pins the exact bytes (`sha256`), so a cached copy from
  another revision cannot be used by mistake.
- \+ Clean place for a detached signature (§2) made at build time.
- \+ Lets the shell refuse a renderer it cannot host before `begin()`
  (§3.1), from a small manifest, without downloading code.
- − Two fetches before `begin()`, two failure modes; a cache to manage
  (size cap, eviction like the 24 h spool purge).
- − A deploy must keep serving the versions still named by bundles in
  flight (a student mid-test resumes after a deploy) — keep the last N
  versions, or serve by hash from S3.

**Decided (B), James 2026-10-08 (D-1).** Fleet Macs are 1:1 (one student
account each), so the per-account cache means one download per Mac per
renderer version. Loaners are Chromebooks and stay unsupported; shared
loaner MacBooks, if they come, cost one download per account, not a
redesign.

**The cache is never trusted.** It sits in the app's sandbox container,
which the student's own account can write. The shell reads the cached
file into memory, hashes those bytes against the `sha256` in the bundle
it has just fetched, and inlines exactly those bytes. A mismatch deletes
the file and downloads again. A tampered cache therefore costs a
download, never a changed page. The cache holds renderer code only,
never test content (the code is public in this repository anyway).

## Open questions

1. **Delivery** — DECIDED (B), D-1 above.
2. **Integrity beyond TLS — DECIDED: sign (D-2, James 2026-10-08).** The
   renderer carries a detached signature made with a key the server never
   holds, checked against public keys compiled into the app. The shell
   also carries a minimum renderer version, so an old, validly signed
   renderer cannot be replayed.
   - *Why, stated narrowly:* a compromised server already controls
     content, scoring and grades, and could already post a question asking
     for a password. What signing adds is that a compromised server cannot
     run CODE inside lockdown: content is drawn as text by our renderer,
     while a malicious renderer could probe WebKit for an escape into the
     app. That gap is real but narrower than "a compromised server cannot
     hurt students".
   - *What it does not cover:* a compromised repository or GitHub account
     (the signer signs whatever is on `main`), and confidentiality (a
     network that inspected HTTPS would still read tokens and answers).
     IT, 2026-10-08: the district does not inspect most traffic — it
     collides with Securly's proxying.
   - *Key rotation without a client release:* compile in two public keys,
     a working key and a backup kept offline.
   - **2.a Key storage — DEFERRED** (James: consider authenticator options
     more broadly). Candidates: a non-exportable key in this Mac's Secure
     Enclave, a hardware token, a cloud KMS key the deploy role can use but
     the app task role cannot.
   - **Signing is decoupled from GitHub Actions.** `deploy.sh` can sign
     with a key held outside the server; moving deploys to Actions stays a
     separate roadmap question ("Environments"), with its own risks on a
     public repository (fork-PR workflow tricks, third-party action
     compromise — pin actions by SHA, or keep the deploy workflow in the
     private ops repository).
3. **Compatibility contract.**
   3.1 The renderer declares a `requires` list (bridge handlers + host
   features, e.g. `stt`, `tts.word_ranges`); the shell refuses (before
   `begin()`, with the "update Secure Test" copy) a renderer that needs
   something it lacks. Replaces D-4-style gates for page-only changes.
   3.2 The server keeps the renderer compatible with every shell still on
   the fleet (the `X-SecureTest-Version` header already tells it which).
   3.3 KaTeX: stay in the shell (proposal) or move with the renderer.
4. **Swift item decoding.** `DeliveryItem` today decodes and refuses
   unknown types. Proposal: the shell decodes only what IT uses (ids,
   paging, uploads, prefill) and passes items through; the renderer owns
   types. Check every Swift reader of `DeliveryItem` first.
5. **Fallback.** No fetch, bad hash or refused contract → refuse the join
   before `begin()` (proposal), or fall back to a copy bundled in the app.
   A bundled copy keeps tests running when the server is half-broken but
   reintroduces the version skew the change removes. Cmd-O / `--bundle`
   are Debug-only (security slice 2), so the offline path needs only a
   Debug answer.
6. **Bridge hardening (the ADR's condition).** Each handler validates its
   payload in Swift as untrusted input: shape, sizes, item ids that exist
   in the bundle, upload byte caps, `home` / `submit` only in the states
   that allow them. Audit the 8 handlers + 9 calls into the page as the
   first slice; most checks probably exist.
7. **Staging (James, 2026-10-08: a MUST).** A broken renderer reaches
   every Mac within minutes of a deploy, where today AutoPkg staggers a
   client over a day. This brings the staging stack (roadmap
   "Environments") forward: every renderer change runs on staging with a
   real client before production. Open: 7.1 staging as a second
   scale-to-zero CDK stack (the roadmap's plan) and 7.2 whether a client
   points at it by a launch argument in Debug only, or a second managed
   profile on a test Mac.
8. **Tests.** The JSC renderer tests (`AssessmentPageTests`,
   `RendererPrefillTests`, …) move to the design-tool side; a contract test
   pins the bridge messages both sides agree on.
9. **Release shape.** v2.0 = the shell that fetches; renderer changes
   meanwhile keep landing in Swift literals and move over unchanged.
   Should v1.x page work pause near the cutover so the first served
   renderer equals the last bundled one?

## Sequencing against the roadmap (James, 2026-10-08)

After v2.0 only the native shell needs a release, so work that touches
native code or the bridge goes before or with v2.0, and page-only work
gets cheaper after it.

**Before v2.0, or inside it**
- The staging stack ("Environments" — now triggered by this change).
- Signing-key storage (2.a), which blocks slice 3.
- The bridge audit + hardening (slice 1, ships in a v1.x).
- Anything needing new native code or a new bridge handler, so the v2.0
  shell carries it: the handwriting spike (Vision, row 4b); the speech
  candidates that live in the native engine (a speed change applied
  mid-reading, a choice of voice — which may also need enhanced voices on
  the fleet); a "See my results" entry on Your tests (row IF's follow-up,
  native entry screen).
- Notarization of the v2.0 build (Apple's 403 on IT's ticket).

**After v2.0 — cheaper as a served renderer**
- Further new item types.
- The page halves of row 4b-f (keypad without a `$` stem, …).
- Speech "start reading from a chosen point" and RT-S1 (Speak does not
  read the toolbar).
- UX pass 3's client half (the accessibility audit).
- Small page fixes of the v1.3.1 / v1.3.5 kind.

**Timing.** No large page refactors while the renderer source moves to
the design tool (slice 5) — question 9.

**Unaffected.** Design-tool-only rows (U-9, U-11, CI, EV, AC); DS-3
(GitHub Actions deploys) is no longer a prerequisite now that signing is
decoupled from it (D-2). With row AC's overnight Aurora pause, the
renderer route must not touch the database (the bundle fetch already
meets a cold cluster).

## Slices (draft, after the decisions)

0. This note + ADR 0018 + decisions.
1. Bridge audit + hardening (shell, ships in a v1.x — useful anyway).
2. Staging stack (infra).
3. Server: renderer build + manifest + route (or bundle field), version
   retention, `requires` list, signature + minimum version (D-2).
4. Shell: fetch, verify, cache, contract check, refuse copy; `DeliveryItem`
   pass-through. Ships as v2.0.
5. Move the renderer source + its tests to the design tool; first served
   renderer = the last bundled one, byte for byte.
6. Rows: staging sitting, real AAC session, deploy mid-test then resume,
   bad hash, missing capability, offline (Debug).

## Progress

- 2026-10-08 — note + ADR 0018 (Proposed) written. Staging decided as a
  must. D-1 delivery = (B), verify-on-every-use cache; fleet is 1:1.
  D-2 sign the renderer; key storage deferred (2.a); signing decoupled
  from GitHub Actions. Sequencing against the roadmap recorded.
  Nothing built.
- 2026-10-08 — **Slice 1 audit done (read-only), hardening decided: one
  slice H-1…H-6 + B-7 (James).** Inventory: navigation allows only the
  host's own loads; new windows, file pickers, alerts / confirms / prompts
  refused; context menu suppressed; `nonPersistent()` store; the page CSP
  blocks every fetch; speech / dictation callbacks JSON-quote their
  strings; `tts` gated on the accommodation and `stt` on a ready
  pre-flight; `response` decoded by shape (10 types) and ignored after
  hand-in; the server re-validates (zod, 20 MB upload cap). Findings:
  - **B-1** `home` is honoured at any time: mid-session with no feedback
    pending, `BackToTests.decide` → `.leave` → `showEntry()` tears the
    attempt screen down WITHOUT ending lockdown. Latent (the button shows
    only after an end). → **H-1** honour `home` only when lockdown is not
    active or the attempt is handed in.
  - **B-2** `response` / `withdraw` / `upload` never check `item_id`
    against the bundle or the response type against the item's type; the
    server refuses, the client reports `responses_dropped`. → **H-2**.
  - **B-3** `upload` decodes any size of base64 in memory and checks only
    the data-URL prefix. → **H-3** 20 MB before decoding + PNG signature;
    text / HTML / cell caps as the server's.
  - **B-4** the test web view has no media-capture delegate (the sign-in
    sheet denies) while the app holds `audio-input`. → **H-4** deny.
  - **B-5** `reportDrawing` / `updateTimeLimit` strip only `"` from a
    string. → **H-5** JSON quoting.
  - **B-6** `tts` accepts any size: memory, a linear per-word span search
    and `MathSpeech` on the main thread. → **H-6** 120,000 characters and
    2,000 segments per request.
  - **B-7** answer text has no maximum anywhere: `text: z.string()` for
    essay and short text (`packages/schema/src/responses.ts`); only essay
    HTML (200,000) and cells (500) are capped. Measured on Aurora
    (read-only, lengths only): 789 essays, max 8,590 characters, p99
    5,580; 21 short texts, max 13; the longest kept revision 23,790. →
    essay text 100,000, short text 2,000, schema first (design-tool
    deploy), the same limits in the client (H-3).
  Accepted: `submit` without a native confirm (it is the student's
  Finish); `timer` (hides the banner only); no per-message rate limit.
