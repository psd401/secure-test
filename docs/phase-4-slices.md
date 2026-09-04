# Phase 4 — slice plans (PDF OCR, new item types, Phase 3 code review)

Status: drafted + approved 2026-08-13. Order approved by James: **PDF OCR (43–45) →
new item types (46–50) → Phase 3 code review**. All three tracks are buildable with the
external blockers (Apple AAC entitlement, ClassLink client_id) still in place.

## Build status

| Slice | Title | Status |
|---|---|---|
| 43 | ADR 0015 + Converse document-block plumbing | ✅ built (2026-08-13, live-validated) |
| 44 | Scanned-PDF OCR extraction branch | ✅ built (2026-08-13) |
| 45 | OCR live validation + docs sync | ✅ built (2026-08-13) — real limit ≥10 MiB; 5/5 candidates from scanned fixture |
| 46 | Item-type dispatch hardening (prep) | ✅ built (2026-08-14) |
| 47 | `match` item type | ✅ built (2026-08-14) |
| 48 | `order` item type | ✅ built (2026-08-14) |
| 49 | `hotspot` item type | ✅ built (2026-08-14) |
| 50 | `drawing_upload` item type (authoring-only) | ✅ built (2026-08-14) |
| — | Phase 3 code review (slices 35–42, two passes) | ✅ done (2026-08-14) — 10 confirmed findings, all fixed (commits 655b300, 5ae67b9, ab6b989); slice-50 spot review fixed separately (8bd2cb4, 894b7e2) |

## Decisions (approved by James 2026-08-13)

- **OCR guardrail input stage:** skipped on the scanned branch — there is no extracted
  text to screen before the model runs. Output screening on candidate stems is retained
  unchanged. Recorded in ADR 0015 (slice 43).
- **OCR page cap:** 30 pages in v1 (`pageCount` is known from `unpdf` before any model
  call, so the cap costs nothing).
- **Auto-scoring for match/order/hotspot:** all-or-nothing exact match, consistent with
  MC-multi (`lib/scoring/auto.ts:41-50`). Partial credit deferred; per-item weights
  remain a future `items.config` concern (noted at `lib/scoring/auto.ts:11-12`).
- **Drawing/upload:** authoring-only. No student file-ingest path exists (`responses`
  is jsonb only, `db/schema.ts:377`) and the student runtime is AAC/ClassLink-blocked,
  so a drawing item cannot receive a real response yet. Response ingest is student-app
  work, not design-tool work.
- **New types excluded from CSV import, AI item-gen, and PDF import in v1.** Each
  surface rejects/excludes them explicitly (`AI_GENERABLE_TYPES` already sets this
  precedent for essay, `AssessmentEditor.tsx:85-87`).
- **Review depth:** local `/code-review high` (not ultra).

## Sequencing facts that shape the set

- **The OCR insertion point already holds the bytes.** Slice 42 rejects scanned PDFs at
  `app/api/assessments/[id]/items/import-pdf/route.ts:90-101` (422
  `pdf_looks_scanned`), and the raw `Uint8Array` is read at `route.ts:79` — the OCR
  branch replaces the rejection at exactly that point. The likely-path note in
  `phase-3-slices.md:207-212` (Bedrock-native document blocks, not local rasterization,
  per ADR 0013) is what slices 43–44 implement.
- **No SDK bump needed.** `@aws-sdk/client-bedrock-runtime ^3.1069.0` already supports
  the Converse `DocumentBlock` content member. The only gap is that
  `lib/ai/bedrockConverse.ts:71,107` hardcode a single `{ text }` content block — the
  opts need widening.
- **No SQL migrations for new item types.** `items.type` is plain text (not a pg enum,
  `db/schema.ts:74-110`) and per-type extras live in the `items.config` jsonb bag
  (slice 32 pattern). Integrity is enforced at the write boundary
  (`lib/api/items.ts`), so every new type is code + tests only.
- **Preview stays static.** The preview iframe has no `script-src` and no
  `allow-scripts` (ADR 0006; `app/preview/[id]/route.ts:17-18`,
  `AssessmentEditor.tsx:508`). Match/order/hotspot render as paper-style static HTML
  (as print mode already does for MC); real interactivity belongs to the student
  runtime. The dashboard editor is ordinary client JS and is unaffected — the hotspot
  region editor lives there.
- **Silent mis-export is the worst failure mode of adding types.** Bundle export and
  import both end in a catch-all that treats unknown types as `short_text`
  (`app/api/assessments/[id]/export/route.ts:98-104`, `lib/api/importBundle.ts:232-239`).
  Slice 46 removes that before any new type lands.

## Recommended order

`43 → 44 → 45` (OCR; 45 needs live AWS) → `46` (hardening, independent — could
interleave earlier if OCR blocks) → `47 → 48` (config-only types) → `49` (asset-backed)
→ `50` (authoring-only) → review passes. The review targets `0a49d61..212e173`
(slices 35–42) and is independent of slices 43–50.

---

## Slice 43 — ADR 0015 + Converse document-block plumbing

- **Goal:** Decide and document the OCR mechanism; make the shared Bedrock wrapper able
  to carry a PDF document block. No behavior change for existing callers.
- **Changes:**
  - `docs/adr/0015-*.md`: scanned-PDF OCR via Bedrock Converse document blocks (Claude
    reads the PDF directly — consistent with ADR 0013's no-headless-Chrome constraint).
    Records the approved guardrail-input-skip and the 30-page cap.
  - `lib/ai/bedrockConverse.ts`: widen `converseText` opts with an optional
    `document?: { bytes: Uint8Array; name: string }`; build the `content` array from it
    (document block + text block) instead of the hardcoded single `{ text }`. Callers
    (`lib/pdfImport/bedrockProvider.ts`, `lib/ai/mathTranslator/bedrockProvider.ts`,
    `lib/ai/essayScorer/bedrockProvider.ts`) pass no document and are untouched.
  - `scripts/bedrock-smoke.ts`: add a document-block probe (small in-script PDF).
- **Tests:** request-construction unit test (document present/absent shapes); existing
  provider tests stay green unchanged.

## Slice 44 — scanned-PDF OCR extraction branch

- **Goal:** A scanned PDF no longer 422s — it flows through the same propose-then-edit
  candidate review as a text-layer PDF. No writes from the route, unchanged.
- **Changes:**
  - `lib/pdfImport/`: extend `PdfExtractRequest` so the bedrock provider can receive
    the raw bytes; when `looksScanned()` fires (`extractText.ts:25-31`), the bedrock
    provider sends the document block with the existing `PDF_EXTRACT_SYSTEM_PROMPT`
    (`extractCore.ts:12-24`) instead of the extracted text. Candidates go through the
    single validation authority `validatePdfCandidates()` (`extractCore.ts:58-78`)
    exactly as today. Mock provider gains a deterministic scanned-path fixture and
    stays the default.
  - `app/api/assessments/[id]/items/import-pdf/route.ts`: the `pdf_looks_scanned` 422
    becomes an OCR dispatch when the provider supports it; mock keeps a deterministic
    path so tests never touch AWS. Guardrail call (`route.ts:115-126`): input stage
    skipped on the scanned branch per the approved decision; output stage on candidate
    stems unchanged; surface stays `pdf-import` (already in the
    `guardrail_events.surface` CHECK — no migration).
  - Page cap: scanned branch rejects `pageCount > 30` with a clear hint (422,
    `pdf_too_many_pages`).
  - `app/dashboard/[id]/PdfImportPanel.tsx`: replace the "OCR isn't supported yet"
    hint; show a "scanned PDF — extracted via AI OCR" note on results.
- **Tests:** route tests with an image-only PDF fixture built in-test (hand-rolled like
  `makeTextPdf` in `test/pdf-import-route.test.ts` — bun `mock.module` leaks across
  files, so no module mocking); scanned → candidates (mock provider); page-cap 422;
  guardrail output-block on the scanned branch → 422 + `guardrail_events` row;
  writes-nothing invariant.

## Slice 45 — OCR live validation + docs sync

- **Goal:** Empirical proof against real Bedrock; close the known coverage gap that
  `bedrockPdfExtractor` has zero tests.
- **Changes:**
  - Live run with a genuinely scanned PDF (photograph/scan of a paper test) through
    the full route; record model used, latency, candidate quality.
  - Verify Bedrock's actual Converse document-size limit against the route's 25 MiB
    `MAX_BYTES` (`route.ts:21`); lower the scanned-branch cap if Bedrock's limit is
    smaller. Record the empirical numbers in ADR 0015.
  - Add a unit test for `bedrockPdfExtractor` request construction (mocked client —
    text-layer and document-block shapes).
  - Docs: `phase-3-slices.md` deferred entry updated (OCR no longer deferred),
    `design-tool-plan.md` Phase 3 import bullet, `.env.local.example` if any new env
    var landed.
- **Tests:** the new provider unit test; everything else is manual-run evidence
  recorded in the ADR.

## Slice 46 — item-type dispatch hardening (prep)

- **Goal:** Unknown item types fail loudly instead of silently becoming `short_text`.
  Lands before any new type exists.
- **Changes:**
  - `app/api/assessments/[id]/export/route.ts:98-104` and
    `lib/api/importBundle.ts:232-239`: replace the short_text catch-all with exhaustive
    per-type handling + explicit error on unknown type (export: 500 with item id in the
    log; import: per-item rejection in the report, not all-or-nothing).
  - Exhaustiveness backstop: `never`-check helper so TS errors at compile time when
    `ITEM_TYPES` grows without a branch (the pattern
    `DEFAULT_SCORING_METHOD`/`ALLOWED_SCORING_METHODS` already get for free as
    `Record<ItemType, …>`, `lib/api/items.ts:67-82`).
- **Tests:** export/import of a forged unknown-type row errors as specified; existing
  round-trip tests unchanged.

## Slices 47–49 — shared shape for `match`, `order`, `hotspot`

Each is one slice, one commit, same checklist. Per-type specifics below.

- **Schema/contract:** new member in `ItemSchema` (`packages/schema/src/items.ts:137-143`)
  + response variant (`packages/schema/src/responses.ts:39-44`) + type exports;
  `ITEM_TYPES` (`db/schema.ts:49-54`); `ItemConfig` extras (`db/schema.ts:63-72`).
- **Write boundary:** `CreateItemBody` member + `itemConfigForWrite` branch
  (`lib/api/items.ts:116-123`, `:128-136` — note the `type !== "essay"` early return
  at `:131` goes away in slice 47); `DEFAULT_SCORING_METHOD` = `auto`,
  `ALLOWED_SCORING_METHODS` = `auto | human`.
- **Export/import:** explicit branches (slice 46 made omission a compile/test error);
  CSV import rejects the type with a clear per-row error.
- **Editor UI (`AssessmentEditor.tsx`):** local union, `ItemView`, `TYPE_LABEL`,
  `SCORING_OPTIONS`/`SCORING_DEFAULT`, `defaultItemFor`, `persistItem`, new edit-form
  arm as a dedicated sub-component (the `:962` ternary chain is already unwieldy);
  excluded from `AI_GENERABLE_TYPES`. Server cast at `app/dashboard/[id]/page.tsx:71-74`.
- **Preview (`lib/preview/renderHtml.ts`):** static render + print variant; disabled
  inputs like existing types; CSS in the inline block.
- **Scoring:** `lib/scoring/auto.ts` branch (all-or-nothing exact); response variant
  renders in `ScoringQueue.tsx` `responseText` (currently duck-typed on
  `text`/`choice_id`/`choice_ids` at `:26,57-62` — new shapes must not render blank).
- **Seeding:** `lib/dev/seedAttempts.ts` switch gains the type so scoring slices stay
  manually verifiable.
- **Tests:** schema round-trip; write-boundary accept/reject; bundle round-trip;
  auto-score right/wrong/mismatched-type; preview render; review-queue rendering.

### Slice 47 — `match`

- `config.pairs: [{ id, left, right }]` (rich-text stems not needed in pairs v1 —
  plain strings). Response: `{ type: "match", matches: Record<leftId, rightId> }`.
- Preview: two-column table; print mode adds a blank answer column (mirrors the MC
  paper variant at `renderHtml.ts:146-158`).
- Auto-score: every left matched to the keyed right, all-or-nothing.

### Slice 48 — `order`

- `config.sequence: [{ id, label }]` in correct order; editor shuffles for display.
  Response: `{ type: "order", ordered_ids: string[] }`.
- Preview: numbered blank lines + the items in shuffled order (deterministic shuffle
  seeded from item id, so preview is stable).
- Auto-score: exact sequence, all-or-nothing.

### Slice 49 — `hotspot`

- `config.image_asset_id` (existing asset layer, ADR 0008/0010 — owner-scoped,
  `sha256`-deduped, served via `/api/assets/[id]`) + `config.regions:
  [{ id, x, y, w, h }]` normalized 0–1 + `config.correct_region_ids`.
- Editor: click-drag region editor over the image in the dashboard (client JS —
  unaffected by the preview CSP).
- Preview: `<img src="/api/assets/…">` (already allowed by `img-src 'self'`) with
  static absolutely-positioned outlined/numbered region overlays. No JS.
- Auto-score: selected region ids = correct set, all-or-nothing.
- Bundle export/import: the image rides the existing `assets` base64 bundling +
  `rewriteAssetRefs` path (`export/route.ts:107-161`, `importBundle.ts:34-41`) —
  extend ref extraction to read `config.image_asset_id`, not just stem markdown.

## Slice 50 — `drawing_upload` (authoring-only)

- **Goal:** Teachers can author and preview the item; the response side is explicitly
  out of scope until the student runtime exists.
- **Changes:** same checklist as 47–49, minus auto-scoring (scoring methods
  `human` only; `lib/scoring/auto.ts` returns `null` = skipped, the existing essay
  behavior). `config.prompt_asset_id?` (optional reference image) +
  `config.canvas?: { width, height }`. Preview: bordered blank canvas box + optional
  reference image. No response variant is added — `packages/schema/src/responses.ts`
  untouched; the review queue never sees these until ingest exists.
- **Documented deferral:** student upload ingest (multipart response capture, asset
  quota per student, review-queue rendering of submitted images) belongs to the
  student-app plan.
- **Tests:** schema/write-boundary/bundle round-trip; preview render; auto-score
  returns null; review queue skips cleanly.

---

## Phase 3 code review (slices 35–42)

Scope: `0a49d61..212e173` — 67 files, ~11.5k insertions. Two passes; findings James
approves get applied as normal commit-per-group slices afterward.

- **Pass 1 — correctness:** `/code-review high` over the range. Focus: append-only
  `scores` invariants (one live `final` per response — partial unique index), authz on
  every new route (owner scoping + `requireDraft`), hybrid auto-finalize threshold
  (`HYBRID_AUTO_FINALIZE_CONFIDENCE`, `lib/ai/essayScorer/scoreCore.ts`), CSV tokenizer
  edge cases (`lib/api/csvParse.ts` is hand-rolled RFC-4180).
- **Pass 2 — security:** security-review pass over the import surfaces — multipart
  handling, PDF/CSV parsing, prompt injection via PDF text into the extractor LLM
  (free-text JSON parse, not tool-forced — `extractCore.ts:32-47`), guardrail bypass,
  size limits/DoS.
- **Candidate findings already surfaced during planning (verify, don't assume):**
  `bedrockPdfExtractor` has no tests (slice 45 closes this); export short_text
  fallback (slice 46 closes this); `ScoringQueue.tsx:57-62` duck-typed response
  rendering (slices 47–49 touch this).

## Deferred / blocked (unchanged from Phase 3)

Comparative judgement (needs own ADR), student results + LLM feedback (ClassLink),
response ingest API (ClassLink), PowerSchool/Schoology exports (sample files — action
on James), Google Docs import (DPA check first), admin safeguarding page (ClassLink
roles), PoC-A/PoC-C empirical runs (Apple AAC / ClassLink Partner Portal — see
`unblock-checklist.md`).
