# Phase 3 — slice plans

Status: drafted 2026-07-09. Phase 3 scope lives in
[`design-tool-plan.md`](design-tool-plan.md) lines 116–124 (scoring, results, advanced
imports). This file breaks the buildable subset into concrete slices, in the order James
approved 2026-07-09: **scoring tables first, then imports**.

## Build status

| Slice | Title | Status |
|---|---|---|
| 35 | Attempts + responses schema (+ dev seeding) | ✅ built (2026-07-09) |
| 36 | Per-item scoring method (config + picker UI) | ✅ built (2026-07-09) |
| 37 | Scores table + auto-scoring engine | ✅ built (2026-07-09) |
| 38 | AI scoring provider (essay × rubric) | ✅ built (2026-07-09) |
| 39 | Human review queue + manual scoring UI | ✅ built (2026-07-09) |
| 40 | Teacher results view + generic CSV score export | ✅ built (2026-07-09) |
| 41 | CSV item import (template-driven) | ✅ built (2026-07-09) |
| 42 | PDF item import (LLM-assisted extraction) | ✅ built (2026-07-09) — text-layer only; OCR deferred |

## Sequencing facts that shape the set

- **No real student responses exist, and none can arrive until the student app ships and
  ClassLink rostering lands.** Everything here is built and tested against dev-seeded
  response data (slice 35 includes the seeding mechanism). The production ingest API is
  sketched in slice 35's notes but explicitly deferred — it needs student auth
  (ClassLink) and the student-app sync protocol.
- **Rubric authoring already exists as scoring input.** Slice 33 shipped
  `config.rubric` on essay items (`RubricSchema`, `packages/schema/src/items.ts:57` —
  analytic / holistic / single_point with per-criterion levels and points). AI scoring
  (slice 38) consumes it; the "mandatory rubric" rule comes from
  `design-tool-plan.md:119`.
- **The AI provider pattern is established and reused, not reinvented.**
  `lib/ai/provider.ts` env-switches `AI_PROVIDER` with `mock` default for tests/CI;
  Bedrock via `bedrockConverse.ts` (ADR 0007/0011). Slice 38 adds a scorer provider the
  same way. Guardrails wrap it as a new surface (ADR 0012), which requires a
  `guardrail_events.surface` CHECK migration (`db/schema.ts:289`).
- **Score exports were deferred from Phase 2 for lack of scoring data** — slice 37
  unblocks them. Generic CSV lands in slice 40; PowerSchool / Schoology formats stay
  gated on sample export files (James to pull from each vendor; formats are
  reverse-engineered, `design-tool-plan.md:113`).

## Recommended order

`35 → 36 → 37` (data foundation) → `38 → 39` (AI + human scoring loop) → `40`
(read/export) → `41 → 42` (imports). 35–37 have no AI dependency; 38–39 depend on 37;
40 depends on 37 (39 enriches it); 41–42 are independent of scoring entirely and could
interleave if a scoring slice blocks on a decision.

---

## Slice 35 — attempts + responses schema (+ dev seeding)

- **Goal:** The tables everything else reads. One `attempts` row per (assessment,
  student) sitting; one `responses` row per answered item.
- **Changes:**
  - `db/schema.ts`: `attempts` (id, assessment_id FK cascade, student_id FK → existing
    `students` roster, status `in_progress|submitted` CHECK, started_at, submitted_at) +
    `responses` (id, attempt_id FK cascade, item_id FK, `response` jsonb, timestamps;
    unique `(attempt_id, item_id)`). Owner scoping flows through
    `assessments.owner_sub`, matching every existing query path.
  - `packages/schema/src`: `ResponseSchema` — discriminated by item type
    (`choice_ids: string[]` for MC, `text: string` for short_text/essay), snake_case
    wire format (ADR 0002), validated at the write boundary like `ItemConfig`
    (`db/schema.ts:57–66` pattern).
  - **Dev seeding:** `scripts/seed-attempts.ts` (dev-only, refuses to run when
    `NODE_ENV=production`) fabricates N attempts with plausible responses per item type
    against an existing assessment + roster. This is the substitute for the missing
    student app and is what every downstream slice's manual verification uses.
- **Deferred, documented here:** `POST /api/attempts` ingest for the student app —
  needs ClassLink student auth; do not build a speculative unauthenticated endpoint.
- **Tests:** migration applies; ResponseSchema round-trip per type; unique constraint;
  seed script produces schema-valid rows.

## Slice 36 — per-item scoring method (config + picker UI)

- **Goal:** Teacher declares how each item is scored: `auto | ai | human | hybrid`
  (`design-tool-plan.md:118`).
- **Changes:**
  - `ItemConfig` gains `scoring_method?` — jsonb config bag, **no DB migration**
    (slice 32 pattern, `db/schema.ts:57`); write-boundary validation in
    `lib/api/items.ts`.
  - Validation rules: `auto` invalid for essay (nothing to match); `ai` requires
    `config.rubric` present (mandatory-rubric rule); defaults when unset — MC/short_text
    → `auto`, essay → `human`.
  - Editor picker in `AssessmentEditor.tsx` per item; carry through export
    (`app/api/assessments/[id]/export/route.ts`) + import (`lib/api/importBundle.ts`)
    maps, mirroring how slice 32/33 config carried.
- **Tests:** invalid combos rejected; defaults; bundle round-trip.

## Slice 37 — scores table + auto-scoring engine

- **Goal:** Persist scores; machine-score the objectively markable types. No AI.
- **Changes:**
  - `db/schema.ts`: `scores` (id, response_id FK cascade, method CHECK
    `auto|ai|human`, points + max_points numeric, rationale jsonb, scorer text —
    `"auto"`, a model id, or a teacher sub — status CHECK `proposed|final`,
    reviewed_by_sub nullable, timestamps). Append-only; partial unique index enforces
    **one live `final` score per response**.
  - `lib/scoring/auto.ts` — pure functions: MC single = exact choice; MC multi =
    exact-set match, all-or-nothing (policy default, see open questions); short_text =
    normalized exact match against `correct_answer` (trim, collapse whitespace,
    case-fold).
  - "Score attempt" API action: runs auto over `scoring_method=auto` items, writes
    `final` scores (no human step needed for objective items).
- **Tests:** table-driven scoring cases per type; one-final-per-response invariant;
  idempotent re-score.

## Slice 38 — AI scoring provider (essay × rubric)

- **Goal:** Claude proposes a rubric-based essay score; a human always finalizes.
- **Changes:**
  - `lib/ai/types.ts` + new `EssayScorerProvider` following the `ItemGeneratorProvider`
    shape (`lib/ai/provider.ts:17` env-switch, `mock` default for tests/CI, Bedrock
    implementation reusing `bedrockConverse.ts`). Input: stem + response text +
    `config.rubric`. Output (Zod-validated): per-criterion level selection + points +
    rationale, summing within rubric bounds.
  - **Mandatory rubric enforced** — provider refuses items without `config.rubric`
    (`design-tool-plan.md:119`).
  - **Human-in-the-loop invariant: AI scores are written `status=proposed`, never
    `final`.** Finalization only happens in slice 39.
  - Guardrail wrap as new surface `essay-score`: extend `GUARDRAIL_SURFACES`
    (`db/schema.ts:262`) + migrate the `guardrail_events` surface CHECK — this is the
    one migration in the slice.
- **Tests:** mock provider contract; Zod output validation incl. out-of-bounds points
  rejected; rubric-missing refusal; proposed-not-final invariant; guardrail event
  written on block.

## Slice 39 — human review queue + manual scoring UI

- **Goal:** The queue where `human`/`hybrid` items get scored and AI `proposed` scores
  get approved or overridden (`design-tool-plan.md:119`).
- **Changes:**
  - Queue view per assessment: responses lacking a `final` score, grouped by state
    (unscored-human vs AI-proposed). Actions: score manually (rubric-driven UI — click
    criterion levels, auto-sum), approve AI proposal (copies to `final`,
    `reviewed_by_sub` stamped), override (new `final` row with human points; the
    `proposed` row is retained — append-only audit trail), re-run AI.
- **Tests:** state transitions; append-only retention; reviewed_by stamping;
  hybrid/human items appear, auto items don't.

## Slice 40 — teacher results view + generic CSV score export

- **Goal:** Read side: per-assessment matrix (student × item, totals, scoring status)
  + a generic CSV download. Teacher-facing only.
- **Explicitly not in scope:** the student results page and LLM feedback double opt-in
  (`design-tool-plan.md:121`) — blocked on student identity (ClassLink). PowerSchool /
  Schoology formats — gated on sample files.
- **Tests:** totals math (finals only, proposed excluded); CSV golden-file.

## Slice 41 — CSV item import (template-driven) — BUILT

- **Goal:** Row-per-question CSV → items on a draft assessment
  (`design-tool-plan.md:122`). No AI.
- **What shipped:** RFC-4180 CSV parser (`lib/api/csvParse.ts` — no CSV dep existed);
  `lib/api/importItemsCsv.ts` validates each row through the SAME `CreateItemBody`
  union+superRefine the manual editor uses, so scoring-method/choice/rubric rules match
  exactly; `POST /api/assessments/:id/items/import` with `{ csv, commit }` — `commit:false`
  is preview (no writes), `commit:true` appends valid rows after the current max position
  and reports invalid rows per-line (not all-or-nothing); draft-locked + owner-scoped.
  Editor gained a collapsible `ImportItemsPanel` (paste/upload → Preview report → Commit).
- **Template columns:** `type,stem,choices,correct,scoring_method,max_word_count,placeholder,rubric_json`.
  MC `choices` = `id:text` pairs joined by `|` (first `:` splits, so text may contain
  colons); MC `correct` = choice id(s), `|`-joined for multi.
- **Decision made in-slice (2026-07-09):** rubrics ride a single `rubric_json` column (a
  JSON Rubric string) rather than being flattened into many columns — keeps the template
  flat while preserving full rubric fidelity via the existing `RubricSchema`. Revisit if
  teachers need to author rubrics in the CSV by hand (JSON-in-a-cell is awkward for that).
- **Tests:** CSV parser unit tests (quoting, embedded comma/quote/newline, CRLF, trailing
  newline); golden CSVs (all four types incl. essay+rubric, partial-invalid with per-row
  errors, reordered/subset header, colon-in-choice-text); route preview-vs-commit, append
  positioning, header-error 400, draft-lock 409, cross-teacher 403, and an import→export
  round-trip asserting scoring_method + rubric survive.

## Slice 42 — PDF item import (LLM-assisted extraction) — BUILT (text-layer only)

- **Goal:** Teacher uploads an existing test PDF → proposed items they review and edit
  before save (`design-tool-plan.md:122`), same propose-then-edit flow as AI item gen.
- **Spike (2026-07-09):** `unpdf` (pure JS, no native deps, serverless-friendly) extracts
  text-layer PDFs in this bun env — 66-page OSPI PDF → 170k chars in ~490ms. Confirms the
  no-headless-browser constraint (ADR 0013) is satisfiable with a library.
- **What shipped:** `lib/pdfImport/` — `extractText.ts` (unpdf wrapper + `looksScanned`
  chars-per-page detector), `PdfExtractorProvider` (mock default / bedrock Sonnet 4.6,
  env `PDF_EXTRACTOR_PROVIDER`), `extractCore.ts` (prompt + `validatePdfCandidates` runs
  each candidate through `CreateItemBody` — one write-shape authority — with a
  `MAX_PDF_CANDIDATES` cap). `POST /api/assessments/:id/items/import-pdf` (multipart,
  owner+draft guarded, guardrail surface `pdf-import` via migration 0011) extracts →
  rejects scanned (422) → LLM proposes → validates → returns candidates. **Writes
  nothing**; the editor's `PdfImportPanel` shows one review list, teacher Adds the keepers
  (each through the normal item-create path, then editable in place).
- **OCR decision (James, 2026-07-09):** DEFER for now, but a **definite future need** —
  scanned/image PDFs are detected and rejected with a helpful message, not silently
  mishandled. When revisited, the likely path is Bedrock-native PDF document blocks
  (Claude reads PDF images directly) rather than local rasterization, since headless/native
  rasterization is unavailable here.
- **Tests:** real OSPI-PDF extraction + garbage rejection; `looksScanned` thresholds;
  `validatePdfCandidates` (valid/invalid-by-index, truncation); mock provider contract;
  route via REAL generated PDFs (candidates + rejected count, scanned 422, unparseable
  400, guardrail block + telemetry, draft-lock 409, cross-teacher 403). Note: the route
  test builds minimal real PDFs rather than mocking the extractor — bun's `mock.module`
  leaks across files, which corrupted a co-run; real extraction avoids that.

---

## Deferred / blocked (with reasons)

- ~~**OCR for scanned/image PDFs (slice 42 follow-up)**~~ — **SHIPPED in Phase 4**
  (slices 43–45, 2026-08-13): Bedrock Converse document blocks per ADR 0015, exactly the
  path anticipated here. See `phase-4-slices.md`.
- **Comparative judgement (Bradley-Terry)** (`design-tool-plan.md:120`) — needs its own
  ADR (pairing strategy, convergence, where it fits alongside `scores`). Sequence after
  39, only if wanted for this year's essay scoring.
- **Student results page + LLM feedback double opt-in** — blocked on ClassLink (student
  identity + roles).
- **Response ingest API (student app → design tool)** — blocked on ClassLink student
  auth; protocol sketch belongs to the student-app plan, not here.
- **PowerSchool / PowerTeacher + Schoology score exports** — unblocked by slice 37 data
  but gated on sample export files to reverse-engineer. **Action on James.**
- **Google Docs import** (`design-tool-plan.md:122`) — needs a Google Workspace API
  auth decision (service account vs OAuth in-tenant); also the one Phase 3 feature that
  leaves the AWS bubble, so DPA posture should be confirmed first. Hold.
- **More item types (match / order / hotspot / drawing)** (`design-tool-plan.md:123`) —
  not sliced yet; slice after imports land. Drawing/upload has its storage dependency
  already met (ADR 0008 / slice 31).
- **Admin safeguarding page** — still deferred on ClassLink role claims (unchanged from
  Phase 2 plan).

## Open policy decisions (resolve before or during the named slice)

- **38/39 — `hybrid` semantics.** RESOLVED (confirmed by James 2026-07-09): `ai` = AI
  proposes → human must approve every score; `hybrid` = AI proposes, confidence ≥ 0.85
  (`HYBRID_AUTO_FINALIZE_CONFIDENCE`, `lib/ai/essayScorer/scoreCore.ts`) auto-finalizes
  with the model id recorded as scorer, below the gate routes to human review like `ai`.
- **38 — scope cuts made in-slice (2026-07-09):** `single_point` rubrics are NOT
  AI-scorable yet — scoring them means judging below/at/above target, which doesn't
  reduce to level selection; those items stay human-scored. Scoring model defaults to
  the same Sonnet 4.6 profile as item gen (`BEDROCK_ESSAY_SCORE_MODEL` overrides);
  quality should be measured on seeded essays before a live rollout. Re-proposing after
  a rejected AI score is the slice-39 "re-run AI" action, not automatic.
- **37 — MC-multi partial credit.** RESOLVED as drafted (2026-07-09, in-slice):
  all-or-nothing exact-set match. Partial credit changes the scores shape
  (per-choice points) — revisit only with a real request.
- **37 — short_text match strictness.** RESOLVED as drafted (2026-07-09, in-slice):
  trim/whitespace/case fold, no fuzzy matching. Anything fuzzier belongs to `ai`
  method, not `auto`. Every scorable item is worth 1 point this slice; per-item
  weights would live in `items.config` later.
- **38 — scoring model.** Reuse item-gen Sonnet (ADR 0007) or route to a
  cheaper/faster model; measure quality on seeded essays before deciding.
