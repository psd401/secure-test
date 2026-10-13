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
   - **2.a Key storage — WORKING KEY DECIDED (the district's IT
     leadership, 2026-10-11): this Mac's Secure Enclave, Touch ID for every
     signature, as recommended below. BACKUP KEY DECIDED (an IT security
     administrator with James, 2026-10-12)**, replacing the printed key
     below: a FIPS hardware security key, the key generated on the token
     (PIV, PIN and touch required on every use), held offline under
     two-person control — no one person can sign with the backup. Custody
     details live in the ops repository, not here. Used only if James's
     Mac is lost or replaced, and any use starts a rotation in the next
     release (new working key, new backup, old public keys removed).
     **Algorithm: ECDSA P-256 / SHA-256** — the Secure Enclave only does
     P-256, so the backup is PIV `ECCP256`; the app verifies DER-encoded
     ECDSA P-256 / SHA-256 over the manifest bytes, one code path for both
     keys. IT sends the backup's public key (PEM) once generated.
     **Manifest (slice 3):** the signature carries a **60-day validity
     window** (James, 2026-10-12, from IT review) so an unwanted renderer expires
     without an app release; refreshing it needs a new Touch ID signature,
     not just a deploy, so long gaps (summer) need a scheduled re-sign. The
     signed manifest records the commit SHA, and only a commit that passed
     CI on `main` is signed. IT will review the verification + bridge code
     read-only once that slice exists.
     **Standard:** no district policy on code-signing keys exists yet; IT
     leadership drafts one from this (hardware-only keys, one two-person
     backup per app, rotation on backup use, an exposure runbook: a release
     with that public key removed + the minimum renderer version raised).
     History: deferred 2026-10-08 (James: consider authenticator options
     more broadly). Candidates: a non-exportable key in this Mac's Secure
     Enclave, a hardware token, a cloud KMS key the deploy role can use but
     the app task role cannot.
     **Recommendation (2026-10-11), decision with the district's IT
     leadership (asked the same day):** the working key in this Mac's
     Secure Enclave, Touch ID for every signature (CryptoKit, a small
     signing tool called from `deploy.sh`); the backup key generated
     offline and printed, stored apart, only its public half compiled in.
     Why not KMS: IAM Identity Center sessions carry no MFA condition keys
     (`aws:MultiFactorAuthPresent` / `aws:MultiFactorAuthAge` are absent for
     Identity Center identities), so no policy can demand fresh MFA per
     `kms:Sign` — anyone holding the signed-in session (≤ 1 h) could sign.
     Per-call MFA exists only for a classic IAM user assuming a role with a
     TOTP code, which needs a long-term access key on disk and cannot use a
     passkey or security key. Cost of the Enclave: signing only on this Mac,
     where deploys already run. Slices 2–4 do not wait on this — they use a
     throwaway dev key; only the production key does.
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
   **DECIDED (D-4, James 2026-10-11):** 3.1 as written — the vocabulary is
   bridge handlers plus host features (`stt`, `tts.word_ranges`,
   `response.generic`, …). 3.2: Swift's decoder ignores unknown keys, so a
   v1.x client ignores the bundle's `renderer` field; new item types stay
   gated to ≥ 2.0 by `lib/items/clientSupport.ts`; from 2.0 on ONE renderer
   serves every shell, guarded by the `requires` check, not per-shell
   renderer lines. 3.3: the KaTeX library (~270 KB, rarely changes, also
   used by Swift's `MathSpeech`) stays in the shell; the macros
   (`GeneratedKatexMacros.swift`, generated from the design tool's
   `macros.ts`) move with the renderer — they are data, and a macro edit
   should not need a shell release.
4. **Swift item decoding.** `DeliveryItem` today decodes and refuses
   unknown types. Proposal: the shell decodes only what IT uses (ids,
   paging, uploads, prefill) and passes items through; the renderer owns
   types. Check every Swift reader of `DeliveryItem` first.
   **Audit (2026-10-11, read-only):** the page already receives the
   delivery body verbatim (`AssessmentPage.html(bundleJSON:)`); Swift
   rebuilds no item for it. The typed decode serves only (a) refusing an
   unknown item type / blank kind — today's version gate, (b) the item
   count in the log (`AssessmentViewController`), (c) `BridgeItemTable`'s
   id → type map (H-2). Speech, peek, the countdown (deadline only),
   lockdown planning and the instant-feedback decode read no item content.
   **The hidden coupling is the answer channel:** `ItemResponse` is a
   closed Swift union of 10 types, used by the `response` handler, the
   per-type caps in `BridgeChecks` (B-7 / H-3), the spool, and the
   bundle's `saved_responses` decode. Passing items through alone would
   still make every new type a shell release.
   **DECIDED (D-5, James 2026-10-11):** the v2.0 shell decodes items to
   `{id, type}` plus what it uses itself (set inline ids, paging, uploads)
   and lets unknown types through. Answers travel as a generic
   `{item_id, type, value}`; the shell checks the item exists and the type
   matches (H-2 kept), every string in `value` is within the essay cap and
   the message within a byte cap; the known types keep their exact caps;
   exact validation of a new type is the server's (zod already validates
   every answer). `saved_responses` passes to the page as raw JSON.
   Drawing uploads stay tied to `drawing_upload` (a future upload-type
   item would need a shell change — accepted). Trade-off accepted: new
   types get generic, not per-type, caps — the bridge protects the shell
   (memory, state), which generic caps still do.
5. **Fallback.** No fetch, bad hash or refused contract → refuse the join
   before `begin()` (proposal), or fall back to a copy bundled in the app.
   A bundled copy keeps tests running when the server is half-broken but
   reintroduces the version skew the change removes. Cmd-O / `--bundle`
   are Debug-only (security slice 2), so the offline path needs only a
   Debug answer.
   **DECIDED (D-6, James 2026-10-11): refuse the join before `begin()`;
   no bundled renderer in Release.** A Debug-only bundled copy serves
   offline development. The renderer route never touches the database, so
   it is at least as available as the bundle route — if it is down, the
   bundle route almost certainly is too. A Release fallback would be a
   second, untested path that restores the version skew. ADR 0018's
   escape hatch is amended to match.
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
   **DECIDED (D-7, James 2026-10-11):** 7.1 a second scale-to-zero CDK
   stack. 7.2 both, by purpose: day-to-day work = a Debug launch with
   `--server`; the release-candidate run = a signed build on a SECOND,
   org-managed Mac carrying a staging profile (Release builds ignore
   launch arguments and the managed profile wins — security slice 2 — so
   this Mac's production profile rules it out). James has the Mac; its
   staging profile is part of slice 2.
8. **Tests.** The JSC renderer tests (`AssessmentPageTests`,
   `RendererPrefillTests`, …) move to the design-tool side; a contract test
   pins the bridge messages both sides agree on.
   **DECIDED (D-8, James 2026-10-11):** the renderer source lives in its
   own workspace package, `packages/renderer` (neither server code nor
   Swift); the design tool serves its built file. Unit tests run under
   bun with a DOM shim (e.g. happy-dom); a Swift contract test loads the
   BUILT file in JavaScriptCore and checks the bridge messages (headless
   browsers hang here — ADR 0013 — so JSC stays the in-process harness).
9. **Release shape.** v2.0 = the shell that fetches; renderer changes
   meanwhile keep landing in Swift literals and move over unchanged.
   Should v1.x page work pause near the cutover so the first served
   renderer equals the last bundled one?
   **DECIDED (D-3, James 2026-10-11) — where the work lives, so a blocker
   never holds up v1.x releases or design-tool deploys:**
   - **Server and infra on `main`, dark.** Slice 2 (staging) is its own
     CDK stack. Slice 3 (renderer route, manifest, signature) is additive;
     the delivery bundle carries `renderer` only when a setting is on, and
     only staging turns it on — production deploys carry the code dormant
     (the `GRADEBOOK_PROVIDER` pattern). `deploy.sh` ships `main`, so a
     long-lived server branch would drift from every hotfix.
   - **The client on a `v2-renderer` branch, in its own worktree.**
     Slice 4 (fetch, verify, cache, contract check) stays off `main`
     because every v1.x release is signed from `main` (psd-sign refuses
     unless HEAD = origin/main) and no signed v1.x should carry half-built
     fetch-and-verify code, dormant or not. Rebase the branch on `main`
     after each v1.x release.
   - **Slice 5 last, in one short sitting** during a page-work freeze
     right before the v2.0 cut: every v1.x page fix edits
     `AssessmentPage.swift`, the file slice 5 moves, so doing it early on
     the branch guarantees conflicts.
   - v1.x fixes and design-tool deploys continue from `main` unchanged
     throughout.

## Sequencing against the roadmap (James, 2026-10-08)

After v2.0 only the native shell needs a release, so work that touches
native code or the bridge goes before or with v2.0, and page-only work
gets cheaper after it.

**Before v2.0, or inside it**
- The staging stack ("Environments" — now triggered by this change).
- Signing-key storage (2.a), which blocks slice 3 — DECIDED 2026-10-12
  (working key 2026-10-11, backup key 2026-10-12); waiting on IT's
  backup public key.
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
2. Staging stack (infra) + the second Mac's staging profile (D-7).
3. Server: `packages/renderer` build + manifest + route, version
   retention, `requires` list, signature + minimum version (D-2), the
   bundle's `renderer` field behind a setting only staging turns on (D-3).
4. Shell, on the `v2-renderer` branch: fetch, verify, cache, contract
   check, refuse copy (D-6); `DeliveryItem` → `{id, type}` pass-through and
   the generic answer channel (D-5). Ships as v2.0.
5. Move the renderer source, the KaTeX macros (D-4) and its tests into
   `packages/renderer` (D-8); first served renderer = the last bundled
   one, byte for byte.
6. Rows: staging sitting, real AAC session, deploy mid-test then resume,
   bad hash, missing capability, offline (Debug).
3b. **Backup-key signing, before the v2.0 shell is built** (James,
   2026-10-13): `renderer-sign` signs only with the Secure Enclave or a dev
   key; it has no hardware-token (PIV) mode. Add `sign --piv` (or a
   documented PKCS#11 / PIV-tool path producing the same DER signature over
   the same manifest bytes), then ONE rehearsal: the two-person backup
   custody signs a test manifest and `renderer-sign verify` accepts it
   against the backup's public key. Blocks slice 4's release, not its
   build: the shell compiles in both public keys, so the backup's must
   exist first.

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
- 2026-10-09 — slice 1 shipped in client v1.6.2. Open: the real-AAC
  row's "no `BLOCKED` line" half (a Finder launch captures no stderr —
  run once through `launch-client.ts`).
- 2026-10-11 — 2.a recommendation recorded (Secure Enclave + Touch ID,
  printed offline backup) and put to the district's IT leadership, whose
  call it is. D-3 decided: server / infra on `main` behind a setting,
  the client on a `v2-renderer` branch, slice 5 last (question 9).
  Notarization (Apple's 403) blocks only the v2.0 release step, not the
  work. Nothing built.
- 2026-10-11 — Q4 audit done (read-only): the shell already passes the
  bundle to the page verbatim; the real coupling is the closed
  `ItemResponse` union. D-4 (compatibility + KaTeX), D-5 (generic answer
  channel), D-6 (refuse, no Release fallback; ADR 0018 amended), D-7
  (staging stack + second Mac with a staging profile), D-8
  (`packages/renderer`, bun + DOM shim, Swift JSC contract test) decided.
  Every open question but 2.a (with IT leadership) is closed. Nothing
  built.
- 2026-10-12 — 2.a DECIDED: working key in the Secure Enclave + Touch ID
  (IT leadership, 2026-10-11); backup key on a FIPS hardware key under
  two-person control (2026-10-12); ECDSA P-256 / SHA-256; slice 3's
  manifest gains a 60-day validity window and the commit SHA. Waiting on
  IT's backup public key. Nothing built.
- 2026-10-13 — names and backup-key custody details replaced with roles
  (public-repository rule); custody recorded in the ops repository.
- 2026-10-13 — **Slice 2 BUILT (staging stack), not deployed.** IT
  leadership approved the staging approach. Decisions (James): own VPC,
  kept running for now (`cdk destroy` may come later), task count set by
  script, hostname `staging.<origin>`. `0d75ef9`: the CDK app builds one
  stack chosen by `env` — none = production, unchanged (template
  byte-identical before / after); `env=staging` =
  `SecureTestDesignToolStaging` (0 ACU, no DesiredCount in the template,
  no alarms, no gradebook / PowerSchool secrets, no SES, no warehouse
  producer); any other value refused (before, `env=<x>` re-targeted the
  production stack in place). `c36db05`: `deploy.sh --staging`,
  `staging.sh up | down | status`, the `seed-staging` one-off mode (the
  fictional demo roster + run-time-only staff / demo-student accounts,
  guarded by `SECURE_TEST_DEPLOYMENT=staging` AND a `_staging` database
  name), README "Staging". **Before the first staging deploy:** the
  staging app secret (fresh session / PKCE / delivery values — a
  hidden-prompt script outside the repo), the staging redirect URI on the
  web OAuth client, and IT's two CNAMEs (ACM validation + the ALB); then
  `seed-staging`, then the staging profile on the student test Mac
  (D-7). Next build slice: 3 (renderer route + signing, dev key).
- 2026-10-13 — Slice 2 deployed: staging LIVE at `https://staging.<origin>`
  (first create failed on Aurora 16.6, which AWS no longer creates; staging
  now uses 16.11, the version production actually runs). `ci` workflow
  live (the signing gate). **Slice 3 commits 2–3 BUILT:** `packages/renderer`
  (placeholder renderer, `requires`, canonical manifest, build) and
  `tools/renderer-sign` + `src/verify.ts` (Secure Enclave signer, dev key,
  cross-language fixture). **Working key CREATED** on this Mac (Secure
  Enclave, `.biometryAny`): an unsigned SwiftPM build needs no entitlement;
  Touch ID prompts on `sign` with the version and commit; a real signature
  verified against `packages/renderer/keys/working.pub.pem`. Slice 3b
  (backup-key PIV signing + one rehearsal) added before the v2.0 shell.
  Next: commit 4 (sign at deploy, S3 by hash, the route, the bundle field —
  staging only).
- 2026-10-13 — **Slice 3 commit 4 BUILT, not deployed:** `deploy.sh
  --staging` gates on a green `ci` run, builds, signs (Touch ID), verifies
  and uploads to `renderers/<manifest sha256>/…` then `renderers/current.json`
  (`--no-renderer` skips it); `lib/renderer/current.ts` re-verifies the
  pointer (hash, signature vs the generated `packages/renderer/src/keys.ts`,
  window, files; 60 s cache, WARN on failure); `GET
  /api/renderer/<sha256>/<file>` (student or staff JWT, no database,
  immutable caching); the bundle's optional `renderer: {version, sha256}`
  only with `RENDERER_DELIVERY=on`, set on staging alone (production template
  unchanged bar the image hash).
- 2026-10-13 afternoon — **Slice 3 DONE and deployed to staging** (`e8542c2`):
  the first `deploy.sh --staging` passed the CI gate, signed renderer
  `v1791914636` with Touch ID, uploaded `renderers/a72e9498…/` and
  `current.json`; staging serves all four files (200, hashes match the
  manifest, `private, immutable`), 401 without a session, 404 for a bad
  name or unknown hash; no `renderer_current_*` warnings. Not yet seen
  live: the bundle's `renderer` field (needs a student sitting) and the
  shell's own verification (slice 4).
- 2026-10-13 — **Slice 4 planned; decisions D-9…D-14 (James).** D-9
  *bridge mode*: until slice 5, `packages/renderer`'s build EXTRACTS
  `renderer.js` / `renderer.css` from the Swift literals
  (`AssessmentPage.rendererScript` with its spliced math + rich-text
  functions, `itemStyles`, `richTextStyles`), so the served renderer is
  byte-identical to the bundled one and page edits keep landing in Swift
  with no merge conflict; slice 5 then moves ownership and deletes the
  literals. D-10 the instant-feedback page stays in the shell for v2.0.
  D-11 v2.0 REQUIRES the bundle's `renderer` field (absent = refuse), so
  production serves the signed renderer before v2.0 ships; v1.x clients
  ignore the field throughout. D-12 production signs only when the
  renderer files change (or the current signature is near `not_after`),
  not on every deploy. D-13 v2.0's compiled-in minimum renderer version =
  the first production-signed renderer's version. D-14 build order:
  4a Core verifier → 4b loader + cache → 4d generic channels ∥ 4e server
  (bridge-mode extraction, production signing, production
  `RENDERER_DELIVERY`, clientSupport 2.0) → 4c app wiring → 4f rows +
  v2.0.0. Client commits on the `v2-renderer` branch (D-3); 4e on `main`.
  Mapping notes for the build: fetch / verify / `requires` belong between
  the bundle decode and `onBundleLoaded` (`AssessmentViewController`
  :341–388, before `begin()`); the refusal follows the
  `onTimeRanOutBeforeStart` pattern; cache beside the spool in
  `Application Support/SecureTest/renderers/`, evicted on the existing
  24 h purge hooks; strict decodes to loosen in 4d = `DeliveryItem`,
  `ItemResponse` (incl. `saved_responses`), `ItemSet.Layout`.
