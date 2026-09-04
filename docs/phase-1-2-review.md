# Phase 1–2 code review — findings ledger

Status: reviews complete 2026-08-14. **All 20 findings FIXED 2026-08-14** across
five commits (A–E), one per group, each with tests. This file is kept as the
durable record of what was found and why each fix took the shape it did.

## Execution record (2026-08-14)

| Group | Commit | Findings |
|---|---|---|
| A — auth/OIDC | `d1724ce` | A1, A2, A5, A6 |
| B — XSS / data-exfil | `8ae689b` | B3, B4, B7, B8 |
| C — publish lock | `709288a` | C9, C10, C11 |
| D — TIDE / accommodations | `5907048` | D12, D13, D14, D15 |
| E — correctness batch | `924e613` | E16, E17, E18, E19, E20 |

Test count 516 → **571 design-tool** (+55), 68/68 `@secure-test/schema`,
`bun run typecheck` clean. No SQL migrations were needed.

**Rulings taken this session** (recorded here because they shaped the fixes):

- **B7** — drop `image/svg+xml` from the upload allowlist (rather than serving
  assets as attachments).
- **B8** — hidden rubrics omitted from the export bundle entirely (rather than
  shipped with a client-honored visibility flag).
- **B8 follow-up** — implementing B8 surfaced a consequence the review missed:
  `/export` and `POST /api/assessments/import` share ONE bundle format, so a
  blanket omission silently loses the rubric on a teacher-to-teacher share AND
  downgrades that essay's `ai`/`hybrid` scoring (import clamps when no rubric
  arrives). Resolved as **fail-safe default + explicit teacher opt-in**: the
  route omits hidden rubrics by default; the editor's "Export JSON" affordance
  passes `?include_hidden_rubrics=1` for a lossless share/backup copy.
- **C10** — DELETE on a published assessment returns 409 (rather than allowing
  it behind an explicit confirm).

**Deviations / extras beyond the ledger's stated fix direction:**

- **A2** — rather than only mirroring the callback's audience fallback,
  `verifyIdToken` now *requires* an audience (typed + runtime guard) and
  `resolveExpectedAudience()` is the one place it is resolved, so the two
  routes cannot diverge again.
- **C9** — also fixed the client half: `isLocked` tracked the local status
  select, so the inputs re-enabled before anything was saved. It now tracks the
  persisted status.
- **C** — took the ledger's suggested cleanup: `rejectIfPublished` was folded
  into the shared `requireDraft` / `requireDraftStatus`.
- **D12** — added a second protection tier beyond the ledger's prescription:
  when not even the TIDE *tool name* maps, the soft-remove sweep is suppressed
  for that student wholesale. Added `rows_removal_suppressed` /
  `students_sweep_skipped` counters and an amber drift callout in
  ImportTidePanel, so preserved-but-not-updated rows are visible rather than
  silent.
- **D13/D14** — these shared a root cause with D12: `tide_code` was never
  refreshed on `tide_then_edited` rows and nothing could read it back. Added
  `mapCatalogIdToTide` (inverse index) and `tideValueForCode`; the importer now
  refreshes `tide_code`, the review page compares actual values instead of
  timestamps, and DiffReviewPanel *displays* TIDE's value instead of making the
  teacher hand-type it (which is what made D13 dangerous).
- **E16** — re-verified against the repo's actual katex (0.18.4, not 0.16.47).
  Confirmed both the frozen-object TypeError and that `\gdef` mutates the
  passed object — hence a fresh copy per call, not one shared copy.
- **E19** — also guarded the destructive rubric style switch with a confirm
  that names how many entries would be lost.

**Still open (not part of the 20):** the cleanup/altitude items and the review
roadmap at the bottom of this file. One manual step remains: `.env.local.example`
still has `NEXT_PUBLIC_ALLOW_TEST_ISSUER=0` and should be renamed to
`ALLOW_TEST_ISSUER=0` (tooling could not write that path).

---

## Original ledger (as written 2026-08-14, before fixes)

## Scope & method

Three ranged `/code-review high` passes over the Phase 1 + Phase 2 history, each a
multi-angle find → adversarial-verify pipeline:

| Range | Commits | Covers |
|---|---|---|
| Phase 1a | `76968c5..9bfda0f` | scaffold → slice 13 (auth/OIDC, assessments+items CRUD, MC/short-text, JSON export/import, preview iframe, image refs, KaTeX) |
| Phase 1b | `9bfda0f..4125620` | slices 14–23b (KaTeX fonts, accommodations picker + construct-altering, student roster + TIDE xlsx import, per-student overrides) |
| Phase 2 | `4125620..0a49d61` | slices 24–34 (Aurora/S3 infra, real Bedrock AI wiring, safeguarding guardrails, essay + rubric items, print/PDF) |

20 findings after cross-range dedup (several confirmed by 2–3 independent angles) and
after **filtering issues later slices already fixed** — the hand-copied `ItemType`
union, `renderItem` fall-through, and export `short_text` catch-all were resolved in
slice 46 / the Phase-3 review fixes (commits `894b7e2`, `ab6b989`). All 20 were
**re-verified live at HEAD** (`8fbb754`) unless noted.

**Pre-production context:** this is Phase 1–2 code predating the auth hardening a real
deploy requires; nothing is deployed (local-only, ClassLink still stubbed). These are
pre-production debt, not live exposure — but the auth cluster must be fixed before any
ClassLink go-live.

## Approvals / decisions (2026-08-14)

- **Group A (auth/security) is APPROVED as a group** — no per-finding ruling needed;
  proceed with the OIDC-flow changes when work resumes.
- Groups B–E: not yet ruled on. Recommend A → B → C → D → E (severity order; E is the
  lowest-risk to change).
- Fixes deferred to a fresh session by request — execute from this ledger.

> **Resolved.** All five groups were executed in the recommended order on
> 2026-08-14; see the execution record at the top of this file for the rulings
> that were taken on B7/B8/C10 and the commit for each group.

---

## Group A — auth / OIDC (APPROVED)

### A1. Post-login open redirect via backslash bypass — SECURITY
`app/api/auth/start/route.ts:16` (`safeNext`). Rejects `//` but not `/\`. The callback
feeds `pkce.next` to `new URL(next, origin)`, and `new URL("/\\evil.com", origin).href`
=== `https://evil.com/`, so an authenticated user is 302'd off-origin.
- **Repro:** `/api/auth/start?next=/%5Cevil.com` → passes `safeNext` → stored in the
  signed pkce cookie → after login, redirect to `https://evil.com/`.
- **Fix:** reject any `next` that isn't a same-origin path — normalize backslashes, or
  resolve against origin and confirm the result's origin matches before redirecting.
  Reject control chars and any value where `new URL(next, origin).origin !== origin`.

### A2. Exchange route skips the `aud` check — SECURITY
`app/api/auth/exchange/route.ts:43`. `audience: process.env.OIDC_AUDIENCE || undefined`
— jose skips the aud check when undefined (the documented default). The **callback**
route correctly falls back to `clientId` (`callback/route.ts:95`).
- **Repro:** with `OIDC_AUDIENCE` blank, replay a valid ClassLink id_token issued to a
  *different* client at the same issuer → accepted → its sub minted into a session.
- **Fix:** mirror the callback — `OIDC_AUDIENCE || clientId`. Consider making a shared
  `verifyIdToken` the one place audience is resolved so the two routes can't diverge.

### A5. Test-issuer override gated on a client-exposed env var — SECURITY
`app/api/auth/exchange/route.ts:28`. The per-request `test_issuer`/`test_jwks` override is
gated only on `NEXT_PUBLIC_ALLOW_TEST_ISSUER` — a `NEXT_PUBLIC_*` build var that ships to
the client and is easy to leak into a deployed build.
- **Repro:** if that var is `"1"` in a deployed build, a POST with attacker-chosen
  `test_issuer` + `test_jwks` validates a self-signed token → forged session for any sub,
  no PKCE/nonce/secret.
- **Fix:** gate on a server-only var (e.g. `ALLOW_TEST_ISSUER`, never `NEXT_PUBLIC_`), and
  hard-fail if it's ever set while `NODE_ENV=production`.

### A6. Nonce only checked when the token carries one — SECURITY
`app/api/auth/callback/route.ts:101`. `if (claims.nonce && claims.nonce !== pkce.nonce)`
— an id_token that *omits* `nonce` bypasses replay binding to the PKCE cookie entirely.
- **Fix:** hard-require `claims.nonce === pkce.nonce` (a nonce was sent on the authorize
  request, so its absence in the token is a failure, not a skip).

---

## Group B — XSS / data-exfil surfaces

### B3. Bundle import stores attacker `content_type` → stored XSS — SECURITY
`lib/api/importBundle.ts:132` (and `:145`). Import inserts asset rows with the bundle's
`content_type` verbatim — no `ALLOWED_MIME` check, unlike `app/api/uploads/image/route.ts`
— and `/api/assets/:id` serves the bytes with that content type on the app origin.
- **Repro:** import a shared bundle whose assets map has `{content_type:"text/html",
  base64:<script>}` → `GET /api/assets/<id>` serves HTML on-origin → script runs in the
  importing teacher's session.
- **Fix:** validate each bundle asset's `content_type` against the upload allowlist
  (`lib/api/uploads.ts`) before insert; reject or coerce non-image types.

### B4. PII guardrail persists AND echoes the matched PII — SECURITY / compliance
`lib/safeguarding/guard.ts:89`,`:110` (+ `bedrockGuardrail.ts` `extractFindings`,
generate-item route `:74`). Findings carry the literal matched substring
(`piiEntities[].match`); `runGuarded` writes them into `guardrail_events.findings` **and** a
500-char `text_snippet`, while the file comment claims the full text is never stored — and
the route echoes findings to the client in the 422 body.
- **Repro:** paste a roster line with an SSN into an AI prompt with
  `GUARDRAIL_PROVIDER=bedrock` → the block writes the SSN into Postgres twice and returns it
  in the error the browser renders. The PII filter durably records the PII it exists to
  suppress.
- **Fix:** redact match values before persisting/returning (store finding *type* + a
  redacted marker, not the substring); shorten or drop `text_snippet` for PII findings; add a
  retention/redaction note to the guardrail_events schema.

### B7. SVG uploads served inline → latent stored XSS — SECURITY
`lib/api/uploads.ts:12` (`image/svg+xml` on the allowlist) + `app/api/assets/[id]/route.ts`
serves inline, no `Content-Disposition: attachment`, no CSP. Self-XSS today (owner-scoped);
cross-user the moment asset URLs are shared/embedded (and B3 already provides one route in).
- **Fix:** drop `image/svg+xml` from the allowlist, OR serve assets with
  `Content-Disposition: attachment` + a restrictive `Content-Security-Policy` response header,
  OR rasterize SVG on upload.

### B8. Hidden rubrics leak into the export bundle — SECURITY / correctness
`app/api/assessments/[id]/export/route.ts:86`. `student_visibility.during_test` is honored
only in the preview renderer; export emits `config.rubric` unconditionally.
- **Repro:** author an essay rubric with answer-shaping descriptors, leave "During the
  assessment" unchecked → preview hides it, export ships the full rubric to the student
  client.
- **Fix:** gate the exported `rubric` on `during_test` (or a dedicated
  `include_in_bundle` flag), mirroring the renderer. Decide whether hidden rubrics should be
  omitted entirely or shipped with a visibility flag the student client honors.

---

## Group C — publish lock

### C9. Publish→draft unlock is impossible from the UI — correctness (3 angles)
`AssessmentEditor.tsx:428` (`saveMetadata` sends 6 keys) vs `api/assessments/[id]/route.ts`
unlock check (requires a body with exactly one key `{status:'draft'}`). Following the lock
banner's own instructions 409s every time; `isLocked` follows the local select, so inputs
visually re-enable while every save fails.
- **Fix:** make the unlock check recognize a status→draft transition regardless of the other
  (unchanged) keys — e.g. allow the PATCH when the only *changed* field is status going
  published→draft — rather than keying on `Object.keys().length === 1`.

### C10. DELETE bypasses the publish lock — correctness
`api/assessments/[id]/route.ts:157`. Every edit path on a published assessment 409s, but the
DELETE handler has no `requireDraft`/publish guard — the published assessment + all items
hard-delete with a 204.
- **Fix:** decide policy — either block DELETE on published (409, consistent with edits) or
  require an explicit confirm. With C9 fixed, "unlock then delete" becomes the intended path.

### C11. Publish lock on overrides is client-side only — correctness (2 angles)
`api/assessments/[id]/overrides/route.ts:69` (POST) and
`overrides/[overrideId]/route.ts` (DELETE) — neither calls `requireDraft`, though the panel
disables its controls when published. Direct API calls mutate a published assessment's
per-student tools with no 409.
- **Fix:** add the `requireDraft` guard to both routes (the shared guard already exists).

> C9–C11 pair naturally with the reuse findings: `rejectIfPublished` in the item route is a
> hand-copy of `requireDraft`, and the ownership loader + `UUID_RE` are copy-pasted across
> ~6 routes. Consolidating those while fixing the lock is the efficient path.

---

## Group D — TIDE / accommodations

### D12. TIDE catalog drift silently revokes accommodations — DATA LOSS (2 angles)
`lib/api/importTide.ts:335`. When an incoming TIDE row fails catalog mapping (re-cased
value, new dropdown value, unmapped tool) it never enters `incomingIndex`; the soft-remove
sweep then treats the student's EXISTING live row for that tool as absent and sets
`removed_at`.
- **Repro:** a student's TTS row imported last year is still asserted this year, but the
  value no longer exactly matches `tide-catalog.json` → counted in `rows_dropped` AND the
  existing accommodation is revoked. Legally-entitled student silently loses a tool.
- **Fix:** an unmapped incoming row must NOT trigger removal of the matching existing row —
  only remove when TIDE actively omits the tool. Track "seen but unmapped" keys separately
  from "absent" keys and exclude the former from the sweep. This is the highest-stakes
  correctness bug in the ledger (student-rights impact).

### D13. accept-tide validation is a knowing no-op → audit-ledger corruption — correctness (3 angles)
`app/api/accommodations/import/diff/[accId]/accept-tide/route.ts:92`. `mapTideToCatalogId`
is called with an empty tool name (always null), result discarded via `void mapped`; any
client string is stored as canonical `tide_import` provenance with `tide_code` left stale.
- **Repro:** POST `{tide_value:'anything'}` on a `tide_then_edited` row → stored with
  source flipped to `tide_import`, `edited_at` cleared. DiffReviewPanel makes the teacher
  hand-type the value, so a typo becomes "TIDE truth."
- **Fix:** genuinely re-validate the `(subject, tool, value)` triple — `tideCatalog.ts`
  owns `TIDE_TOOL_TO_ID` and could expose an inverse lookup so accept-tide re-derives from
  the catalog instead of trusting client free-text; refresh `tide_code` alongside the value.

### D14. Phantom diffs listed forever after any re-import — correctness (2 angles)
`app/dashboard/accommodations/import/review/page.tsx:48`. `applyTideImport` refreshes
`last_imported_at` unconditionally, but the review predicate is
`last_imported_at > coalesce(edited_at, created_at)` — so every `tide_then_edited` row shows
as a pending diff after every import even when values are identical.
- **Fix:** either only bump `last_imported_at` when a diff actually exists, or make the
  review query compare values (not just timestamps) — a row where kept value == TIDE value is
  not a pending diff.

### D15. Shrinking allowed_accommodations orphans overrides — correctness (2 angles)
`api/assessments/[id]/route.ts:127`. PATCH auto-clamps `construct_altering` when
`allowed_accommodations` shrinks but leaves `assessment_student_overrides` untouched;
overrides for now-disallowed tools survive and are still served.
- **Fix:** in the same PATCH, delete (or flag) overrides whose `tool_id` is no longer in
  the clamped allowed set — mirror the construct_altering clamp.

---

## Group E — correctness batch (lowest-risk)

### E16. Frozen K12_MACROS breaks `\def` in the SSR renderer — correctness
`packages/schema/src/macros.ts:9`. `Object.freeze()` on the macros object; KaTeX mutates the
passed macros object for user-defined macros, so `\def`/`\gdef` stems throw TypeError
(uncaught by `throwOnError:false`) and render as red error spans — while PoC-B's fresh-object
path still renders them (the renderer drift slice 16 was meant to eliminate). Finder verified
by running the repo's katex 0.16.47 against a frozen object.
- **Fix:** pass a shallow copy `{...K12_MACROS}` at the two render call sites
  (`lib/math/renderLatex.ts:30`, `lib/items/renderItemContent.ts:36`) — keep the export frozen
  (good), copy at the boundary.

### E17. Meta CSP lacks img-src → preview/print images blocked — correctness (3 angles, 2 ranges)
`lib/preview/renderHtml.ts:228`. Inlined meta CSP is
`default-src 'none'; style-src 'unsafe-inline'; font-src 'self'` — no `img-src`, so images
fall back to `'none'`. The route header's `img-src 'self' data:` can't relax it (policies
intersect). Blocks every stem image, hotspot image, and the print/Save-as-PDF path; a
print-accommodation student gets a PDF with diagrams missing. `test/preview-render.test.ts`
asserts the meta string, locking the bug in.
- **Fix:** add `img-src 'self' data:` to the meta CSP to match the header; update the
  preview-render test assertion.
- **Note:** spec-level confirmation (no headless browser here per ADR 0013) — verify in a
  real browser after the fix.

### E18. AI item-gen accepts `essay` and returns wrong-type items — correctness (2 angles)
`lib/ai/types.ts:12` (`AI_GENERABLE_ITEM_TYPES`). The server enum still includes `essay`
(no provider implements it); the mock falls through to a canned `multiple_choice_multi`, and
the Bedrock tool enum lets the model emit invalid essay shapes (502 after a paid call).
- **Fix:** drop `essay` (and confirm match/order/hotspot/drawing are already excluded) from
  the server enum so it matches the client `AI_GENERABLE_TYPES` allowlist. Add a test posting
  `item_type:"essay"` and asserting 400.

### E19. Rubric editor seeds values its own schema rejects — correctness (3 angles)
`app/dashboard/[id]/RubricEditor.tsx:31` (`defaultCriterion` name `""`), `:60`/`:254`
(`defaultLevel("", 0)` for add-level and style-normalize padding). `RubricSchema` requires
`min(1)` on name and label, so saving an untouched new rubric 400s with a generic banner and
no field hint. Related: style switches destroy criteria/levels with no confirm/undo.
- **Fix:** seed with non-empty placeholders (e.g. name `"Criterion 1"`, label `"Level 1"`)
  or validate + surface field-level errors before PATCH; guard the destructive style switch
  with a confirm or preserve dropped data.

### E20. Guardrail outputText runs on unvalidated provider output — correctness
`lib/safeguarding/guard.ts` (output stage) + `lib/ai/itemGenCore.ts` `parseItemText`
blind-casts `JSON.parse` output; `itemProposalText` then dereferences `item.stem`. A model
reply of literal `null` (valid JSON) TypeErrors inside `runGuarded` → 502 `provider_failed`
instead of the intended `provider_returned_invalid_item`. Only bites with guardrails on
(i.e. production).
- **Fix:** validate the parsed proposal shape before the output-text extractor runs, or make
  `itemProposalText` null-safe and return a benign empty string on off-contract shapes.

---

## Cleanup / altitude (surfaced, NOT in the 20 — address opportunistically)

Not individually ranked; several pair naturally with the fixes above:

- **Dedup ownership guards:** `loadOwnedAssessment`/`loadOwned` copied across ~6 routes;
  `UUID_RE` in 22 places; `rejectIfPublished` duplicates `requireDraft`. Lift into `lib/api/`.
  (Pairs with Group C.)
- **Shared `escapeHtml`:** three private copies (`renderHtml`, `renderItemContent`,
  `renderLatex`) — the XSS chokepoint. Export one, import it.
- **Bedrock prompt caching claimed but not enabled:** `converseText`/`converseTool` send no
  `cachePoint`, so the ~0.1× input-cost saving the ADR 0007 comments promise is forfeited on
  100% of production Bedrock traffic. Either wire a cache point or correct the comments/
  cost model.
- **TIDE import N+1s:** `applyTideImport` runs thousands of sequential per-row queries in one
  transaction (student upsert, per-row merge, `ssidForStudent` re-query, soft-remove sweep);
  batchable to a handful of queries. Matters at district scale (~1,500+ students).
- **Duplicated env selectors + Anthropic client:** four hand-rolled `env → provider` chains;
  `anthropicProvider` duplicates the client that Bedrock centralizes.
- **`.env.local.example` drift:** already synced in `1efbc3e` (post-review-range) — the
  finders reviewed the old state; verify current file covers the AI/guardrail vars.
- **Editor re-render / preview-refetch:** rubric keystrokes re-render every item card; the
  preview iframe re-keys on unsaved `allowedAccommodations` (toggles fetch stale HTML). Memo
  the item card + re-key on saved state.
- **Swift KaTeX-macros codegen has no drift check** vs `K12_MACROS`.

## Remaining review roadmap (from the earlier plan)

- Dedicated `security-review` skill sweep over `design-tool/` (the ranged passes surfaced
  the auth/XSS cluster; a focused sweep may find more).
- Optional `/code-review ultra` as a capstone (user-launched, billed) — run AFTER these
  fixes so it doesn't re-report known issues.
