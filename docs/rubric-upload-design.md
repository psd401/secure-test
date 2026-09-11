# Rubric upload, single-point scoring, rubric reuse, student feedback

Design note, 2026-09-11. Asked for by James the same day: the pilot is the
chance to exercise AI scoring and feedback, and teachers cannot get a rubric
into the design tool except by typing it. Design tool only; the client and
the shared schema do not move (one optional field is added to the shared
`RubricSchema`, additive and byte-stable for old bundles). Decisions marked
**D-n** are James's and are listed at the end; **§Progress says what is
built** (nothing yet).

## What exists that this stands on

- **The rubric model is done.** `RubricSchema` (`packages/schema/src/items.ts`)
  — `style analytic | holistic | single_point`, criteria with levels, each
  level `{id, label, points, descriptor?}`; the `superRefine` fixes the
  cardinality per style. It lives in `items.config.rubric` on essay items,
  is edited in `app/dashboard/[id]/RubricEditor.tsx`, rides the delivery
  bundle only when `student_visibility.during_test` is set, and can also
  arrive through the CSV importer's `rubric_json` column. **No AI path
  produces one**; the PDF importer's prompt has no rubric shape.
- **AI essay scoring is done** (slices 38–39): `lib/ai/essayScorer/`
  (mock | bedrock, Sonnet 4.6, temperature 0, JSON-only, two-pass
  validation in `scoreCore.ts`), `lib/scoring/aiScoreResponse.ts`
  (guardrail surface `essay-score`; `ai` → proposed, `hybrid` → final at
  confidence ≥ 0.85), routes `score-ai` / `rescore-ai` / `approve`, and the
  review queue's proposal cards. Scores are append-only rows in `scores`
  with the per-criterion selections and rationales in `rationale` jsonb.
  Auto-score on submit (batch 1) runs auto-method items only; AI scoring is
  teacher-triggered from the queue.
- **`single_point` is authorable but not scorable.** `isScorableRubricStyle`
  excludes it and both providers throw; the queue lists those responses for
  hand scoring. A single-point criterion has ONE level (the target) whose
  `points` the editor collects.
- **`student_visibility.with_feedback` has zero readers.** It is the hook
  wired in slice 33 for "Phase 3". The per-student results page
  (`results/[attemptId]/page.tsx`) shows the **teacher** the
  `overall_rationale` of the final and the proposed score; the per-criterion
  rationales are shown nowhere; the family-facing print page
  (`results/print?attempt=`) shows scores only. There is no student-side
  results view at all — the family-facing print page is the only surface a
  student ever sees after handing in.
- **File ingestion exists for one shape only:** `import-pdf` takes a
  multipart PDF (25 MiB cap), extracts text with unpdf and, when the PDF
  looks scanned, sends the bytes as a Converse `document` block
  (`lib/ai/bedrockConverse.ts`, hard-coded `format: "pdf"`). Nothing reads
  DOCX or Markdown; no mammoth / remark dependency.
- **No token accounting.** `converseText*` and `converseTool` discard
  `response.usage`; the only spend controls are static caps.

## Design

### Formats and the ingestion path (D-1)

Rubrics are tables. unpdf's text extraction flattens a table's columns into
reading order, so a criterion's four level descriptors come out as an
undifferentiated run — the Converse document block, where the model sees
the layout, is **more accurate** for a PDF rubric, not merely a fallback
for scans. Bedrock Converse accepts `pdf | docx | doc | md | txt | html |
csv | xlsx` document blocks natively, so no parser dependency is needed.

| Input | How it reaches the model | Why |
|---|---|---|
| PDF | document block, `format: "pdf"` | table layout survives; scans work for free |
| DOCX | document block, `format: "docx"` | same; the commonest teacher source after PDF |
| Markdown, plain text | text in the user turn | already structured; cheapest; guardrail input stage runs |
| Pasted text | text in the user turn | covers Google Docs (copy the table or download as DOCX / PDF) — no Drive scope exists in the app and none is added |

Cap 5 MiB and one document per request (a rubric is one to three pages;
25 MiB is the item importer's cap for whole tests). Reject any other type
with 415 `unsupported_type`. Google Docs / Sheets get no integration
(D-1): the dialog's help text says "download as DOCX or PDF, or paste".

`bedrockConverse.ts` gains a `format` on `document` (default `"pdf"` so the
PDF importer is untouched) and the `sanitizeDocumentName` stays.

### The extraction (D-2)

- **Route** `POST /api/assessments/[id]/rubrics/extract` — staff, owner,
  `requireDraft`; multipart (`file`) or JSON `{ text }`. **Writes nothing.**
  Response `{ rubric, warnings: [{code, message}], source: {kind, chars |
  bytes} }`, or the structured errors the PDF importer uses
  (`rubric_extract_invalid_output` 422, `rubric_extract_failed` 502, each
  with a teacher-facing `hint`). Same shape whether the rubric is destined
  for one item or the library (below).
- **Provider** `lib/ai/rubricExtractor/` mirroring `pdfImport/`:
  `RUBRIC_EXTRACTOR_PROVIDER = mock | bedrock`, `types.ts`, `extractCore.ts`
  (prompt, parse, normalise, warn), `bedrockProvider.ts` (Sonnet 4.6 via
  `BEDROCK_RUBRIC_EXTRACT_MODEL`, temperature 0, `converseTextWithMeta` so
  `max_tokens` maps to a truncation error), `mockProvider.ts` (a fixed
  analytic rubric; a `MOCK_RUBRIC_STYLE` knob so tests reach the
  single-point and holistic branches).
- **Prompt contract:** ONE JSON object, `{ style, criteria: [{ name, levels:
  [{ label, points | null, descriptor }] }], title? }`. Rules: keep
  criterion and level wording verbatim; a rubric whose rows are criteria and
  columns are performance levels is `analytic`; one criterion with several
  levels is `holistic`; one column of "criteria / target" statements with
  at most a yes-no or below / meets / above split is `single_point` with
  the target as the one level; when a level's points are printed, copy
  them, otherwise `null`; never invent a criterion. `RUBRIC_EXTRACT_MAX_TOKENS
  = 6000`.
- **Normalise + validate** (server, `extractCore.ts`): assign ids
  (`c1…`, `l1…`), drop empty criteria, then run `RubricSchema`; a Zod failure
  is 422 with the issues. **Points missing → auto-assign + warn (D-3):**
  for analytic / holistic, levels with `null` points get a descending
  ladder `n-1 … 0` (or, when SOME levels carry points, a linear fill between
  the printed neighbours); single-point targets get `1`. Warning
  `points_assigned` names every level it touched. Other warnings:
  `style_guess` when the style was inferred from shape rather than named,
  `few_levels` (a criterion under two levels in an analytic rubric is padded
  with an empty "Not evident, 0" level and warned), `truncated_text` (any
  descriptor over 2000 chars is cut).
- **Guardrail:** `runGuarded` surface `rubric-extract`; input stage on the
  text path, skipped on the document path (as `pdf-import` does for scans);
  output stage on the joined criterion names + descriptors.
- **Tests:** mock-provider route tests (owner 200 with warnings, other
  owner 404, Published 409, 415, 413, invalid JSON 422, `max_tokens` 422);
  `extractCore` unit tests for the point ladders (all missing, partial,
  single-point), style inference, id assignment.

### The editor dialog

`RubricEditor` gains **"Upload rubric…"** beside the style select: a dialog
with a file input (`.pdf,.docx,.md,.txt`) and a paste box, one Extract
button. On success it renders the proposed rubric as the read-only table
`renderHtml.ts` already draws for previews, with the warnings above it
("Points were not printed — assigned 3, 2, 1, 0 on every level; check
them"), and **"Use this rubric"** replaces the editor's state; the item's
existing Save persists it. When a rubric is already authored the existing
`criteriaAndLevelsLost` confirm runs first. Nothing is saved by the dialog.

### Rubric library and reuse (D-4)

- **Storage:** new table `rubrics` — `id, owner_sub, title, rubric jsonb,
  source ('upload' | 'editor'), created_at, updated_at`; **migration 0033**
  (0032 went to slice 1's guardrail-surface CHECK).
  Owner-scoped like everything else; sharing rides the existing
  staff-share copy semantics later, not now.
- **Items point at a library rubric optionally:** `config.rubric` stays the
  item's authoritative copy (scoring, bundles and export do not change), and
  `config.rubric_id` records where it came from. Editing the item's rubric
  after applying one detaches it (`rubric_id` cleared) — copy semantics, the
  same rule as shared assessments, so a change in the library never rescores
  an item behind a teacher's back (E11 territory).
- **Routes:** `GET/POST /api/rubrics`, `GET/PATCH/DELETE /api/rubrics/[id]`
  (DELETE detaches items, never edits their copy). The extract dialog's
  second button, **"Save to my rubrics"**, POSTs the proposed rubric with a
  title (defaults to the model's `title` or the file name).
- **Applying:** `RubricEditor` gains **"Use a saved rubric…"** — a list of the
  teacher's rubrics (title, style, criteria count, max points), pick one,
  the same confirm, the editor state becomes a copy with fresh ids. Apply to
  several essays = open each item and pick it; no bulk apply in v1.
- Not in scope: sharing rubrics between staff, versioning, a rubric page
  outside the editor (the list lives in the dialog).

### Single-point scoring (D-5)

A single-point criterion carries one target; scoring it means judging
below / at / above. That does reduce to level selection if the scorer sees
a **derived ladder**: for each criterion, three synthetic levels
`{ below: 0, meets: P, exceeds: P }` where `P` is the target's points (the
extractor assigns 1 when none was printed, and the editor's total-points
rule already refuses a 0-point rubric). `exceeds` earns the same points as
`meets` because a single-point rubric's max is the target; the value of the
distinction is the rationale, which is the whole point of single-point
rubrics.

- `scoreCore.ts`: `isScorableRubricStyle` accepts every style;
  `scoringView(rubric)` returns the rubric unchanged for analytic /
  holistic and the derived ladder for single-point (ids `<criterion>.below`
  / `.meets` / `.exceeds`); the prompt and `validateAgainstRubric` run
  against the view; `rubricMaxPoints` is unchanged (max of the ladder = P).
- The stored `rationale.criterion_scores[].level_id` holds the derived id;
  the queue and the results page render it as "Below target / Meets /
  Exceeds" with the rationale. The manual-score route accepts the same
  derived ids for single-point items.
- The system prompt gains one sentence for the single-point case ("each
  criterion states a target; judge below / meets / exceeds and quote the
  evidence").

### Student feedback (D-6)

`with_feedback` gets its readers. The only surface a student or family
sees is the print page, so:

- **Family-facing print page** (`results/print?attempt=`): for each essay
  item with a FINAL score whose rubric has `with_feedback`, a "Feedback"
  block under the answer — the chosen level per criterion (label, points)
  and its rationale, then the overall rationale. Proposed scores never
  print (they are not decisions yet). Items without the flag print the
  score only, as today.
- **Per-student teacher page:** the per-criterion table for every rubric
  score, final and proposed, regardless of the flag (the teacher is
  reviewing, not publishing), replacing the overall-only text.
- **The review queue's proposal card** gains the per-criterion rows too, so
  the teacher approves what the family will read.
- The rationale wording is the model's; there is no edit-before-publish in
  v1. A teacher who disagrees scores manually (the manual form takes
  `criterion_scores`; the queue can pre-fill it from the proposal — one
  small addition) and the manual rationale prints instead.
- Plain-language framing on the print page: "Scored with a rubric; the
  comments below explain each score" — no mention of AI on the family page
  (D-6, the score is the teacher's once final; the results page and queue
  say "AI proposed" as today).

### Token usage logging (D-7)

`converseTextWithMeta` and `converseTool` read `response.usage` and emit one
structured line through `lib/log.ts`: `{ event: "ai_usage", surface, model,
input_tokens, output_tokens, latency_ms, owner_sub }`. Callers pass
`surface` (item-gen, math, pdf-import, essay-score, rubric-extract,
guardrail). A CloudWatch metric filter on `event:"ai_usage"` is a later
infra slice; the log line is what the pilot needs to see spend per surface.
No table.

## Slices

| # | What | Size / agent |
|---|---|---|
| 0 | This note; roadmap row | docs |
| 1 | Extractor: `bedrockConverse` `format`, `lib/ai/rubricExtractor/` (mock + bedrock + core: prompt, parse, point ladders, warnings), the `rubrics/extract` route + guardrail surface, tests | M — Opus 5 / medium |
| 2 | Editor dialog: Upload rubric… (file + paste), proposal table + warnings, Use this rubric, existing confirm; editor test | S — Sonnet 5 / medium |
| 3 | Library: migration 0033 `rubrics`, `/api/rubrics` routes, `config.rubric_id` (+ detach on edit), Save to my rubrics, Use a saved rubric…; tests | M — Opus 5 / medium |
| 4 | Single-point scoring: `scoringView`, prompt sentence, queue / results / manual-score rendering of the derived levels; tests with the mock provider | S — Opus 5 / medium |
| 5 | Feedback: per-criterion tables on the queue card and the per-student page; the print page's Feedback block gated on `with_feedback` + FINAL; the manual form pre-filled from a proposal; tests (print golden) | S — Sonnet 5 / medium |
| 6 | `ai_usage` log line on every Converse call, `surface` on each caller; test with the mock client | XS — Sonnet 5 / medium |
| 7 | Rows in `docs/design-tool-manual-checks.md` (a real PDF rubric, a DOCX, a pasted Google-Doc table, a single-point one; score a demo essay hybrid; print the family page); deploy, then `migrate-aurora.sh` for 0032 + 0033 | rows — Sonnet 5 |

Order: 0 → 1 → 2 → (3 ∥ 4) → 5 → 6 → 7. Slice 6 can ride earlier if a
deploy happens first. One commit per slice, diffs reviewed and `bun test` +
typecheck re-run in the main session before each commit, as in the
2026-09-09 batches.

## Decisions

- **D-1** Formats: PDF, DOCX, Markdown, plain text, pasted text; PDF / DOCX
  as Converse document blocks (no parser dependency), Google Docs via
  download or paste, no Drive integration. — James, 2026-09-11 (formats
  asked for; the document-block route is the recommendation, taken)
- **D-2** Extraction is a proposal — nothing is written until the teacher
  accepts, the same pattern as PDF import. — recommendation, taken
- **D-3** Missing points: auto-assign a descending ladder and warn, never
  refuse. — James, 2026-09-11
- **D-4** A per-teacher rubric library with copy-on-apply, so one upload
  serves several essays. — James, 2026-09-11
- **D-5** Single-point rubrics become AI-scorable through a derived
  below / meets / exceeds ladder. — James, 2026-09-11
- **D-6** Student feedback ships in the same batch: per-criterion rationale
  on the family-facing print page when the teacher opts in, final scores
  only, no "AI" label on the family page. — James, 2026-09-11 (scope);
  print-page-only placement and the no-label framing are recommendations
- **D-7** Token usage is logged per Converse call now, as a structured log
  line. — James, 2026-09-11

## Progress

- **Slice 0 — 2026-09-11, `d7008cb`.** This note; the roadmap row points here.
- **Slice 1 — 2026-09-11.** `lib/ai/rubricExtractor/` (mock | bedrock,
  `extractCore.ts`: prompt contract with `style_inferred`, one-object parse,
  `normalizeRubric` — ids `c1…` / `l1…` unique across the rubric, D-3
  ladders incl. linear fill between printed neighbours, `few_levels`
  padding, a declared style the shape contradicts falls back to analytic +
  `style_guess`, descriptor cut at 2000); `POST /api/assessments/[id]/rubrics/extract`
  (multipart pdf / docx as document blocks, md / txt decoded to the text
  path, JSON `{text}`; 415 / 413 / 422 / 502 with hints; guardrail surface
  `rubric-extract`, **migration 0032** widens the `guardrail_events` CHECK);
  `bedrockConverse` document `format` (default pdf). Mock-provider markers
  (`THROW_TRUNCATED` etc.) instead of module mocks, as `mockPdfExtractor`.
  1440 tests (+27), typecheck clean; 0032 applied to dev + test.
- **Slice 2 — 2026-09-11.** `RubricUploadDialog.tsx` mounted by
  `RubricEditor` beside "+ Add rubric" AND beside the style select (a
  teacher should not have to add a blank rubric first); file input
  (`.pdf,.docx,.md,.txt`) + paste box, one Extract, warnings as amber notes
  above a read-only proposal table (single-point rows read "Target"), "Use
  this rubric" keeps the editor's `student_visibility`, confirms through an
  AlertDialog when the current rubric is anything but the pristine
  `defaultRubric()` (`isDefaultRubric`); 413 / 409 fixed copy, otherwise
  the route's `hint` + `issues`. No DOM harness exists in the repo, so the
  logic is exported and tested directly (`renderToStaticMarkup` for the
  markup). 1460 tests (+20), typecheck clean.
- **Slice 4 — 2026-09-11** (built in parallel with slice 3).
  `scoringView(rubric)` in `scoreCore.ts` expands each single-point target
  into `<id>.below` 0 / `.meets` P (descriptor kept) / `.exceeds` P; the
  view reports `style: "analytic"` so it satisfies `RubricSchema`'s
  cardinality (nothing reads the view's style — the prompt keys on the
  labels); `isScorableRubricStyle` is always true; both providers, the AI
  route and the manual-score route validate against the view (the authored
  target id now 400s on a single-point item — no such score could exist
  before); `describeLevel` resolves derived ids for UIs;
  `lib/reporting/rubricScoreView.ts` (`rubricScoreRows`, `overallRationale`)
  feeds a per-criterion table on the queue's proposal card and the
  per-student page (final AND proposed) — slice 5 reuses it for print; the
  queue's level picker (it already was one) offers Below / Meets / Exceeds
  and pre-fills from the proposal. +12 tests across four files; the queue
  card needs a hand-run row (no DOM harness).
- **DEPLOYED 2026-09-11 ~10:55 PT** (`bf56c1f`, which also sets
  `RUBRIC_EXTRACTOR_PROVIDER=bedrock` on the task definition — the essay
  scorer was already bedrock): task def rev 22, rollout COMPLETED,
  `/api/health` commit = HEAD, Aurora at 0033 via `migrate-aurora.sh` (34
  journal rows). Rows 122–153 still unrun (row 153's deploy half done).
- **Slice 7 — 2026-09-11.** Rows 122–153 written in
  `docs/design-tool-manual-checks.md`, NOT run: upload-dialog rows (PDF /
  DOCX / Markdown / pasted-text ingestion, missing-points warning,
  single-point / holistic proposals, non-rubric 422, .pptx 415, >5MB 413,
  Published 409, confirm-vs-no-confirm apply, `student_visibility` survives,
  Save persists, Cancel is a no-op), library rows (save, list, apply with
  fresh ids + `rubric_id`, hand-edit detach, library PATCH/DELETE leave the
  item's copy alone, cross-owner 404 blocked pending a second staff
  account), single-point AI-scoring rows on a real sitting (proposal table,
  override picker, approved final, manual save), feedback rows (the print
  page's framing line + per-criterion table gated on `with_feedback` +
  FINAL, flag off, proposed-only, the section view never shows it), one
  `ai_usage` CloudWatch row, and the deploy row for 0032 + 0033. Fixture
  recipe: a Draft with one essay item per rubric style plus a hand-built
  PDF/DOCX/Markdown-table rubric file for the upload rows, and a second
  Published copy with one single-point hybrid essay for the
  `<demo-student-A>` sitting.
- **Slice 3 — 2026-09-11.** The library. **Migration 0033** `rubrics`
  (`owner_sub`, `title`, `rubric jsonb`, `source` CHECK upload|editor,
  owner index; applied to dev + test); `GET/POST /api/rubrics` (summaries:
  title, style, criteria count, max points, source, newest updated first)
  and `GET/PATCH/DELETE /api/rubrics/[id]` — ownership is in the WHERE
  clause, so another teacher's rubric is 404 rather than 403, and DELETE
  detaches every item of the owner that names it (drops `rubric_id`,
  NEVER touches `config.rubric`). `config.rubric_id` on essay items:
  optional uuid on create/PATCH, 400 `rubric_not_found` when it is not the
  caller's, and the copy semantics — an explicit id attaches, an explicit
  null detaches, an omitted id survives a PATCH that leaves the rubric
  alone and is cleared when the rubric changed (content compare, key order
  ignored). Editor: "Save to my rubrics" beside "Use this rubric" on the
  proposal pane (title pre-filled from the file name, stays on the pane
  after a save so an apply can carry the saved id) and `SavedRubricsDialog`
  — "Use a saved rubric…", the same confirm, a deep copy with fresh
  `c1…`/`l1…` ids keeping the editor's `student_visibility`;
  `RubricEditor`'s `onChange` gained `meta?.rubric_id`, and
  `AssessmentEditor` writes `rubric_id: meta?.rubric_id ?? null` so a hand
  edit detaches client-side too. `rubric_id` is editor metadata only —
  both bundle builders project config by key, and a test proves neither the
  export nor the delivery bundle carries it. New tests: 21 route /
  item-config, 20 editor-logic. (The list summary's max points imports
  `rubricMaxPoints` from `scoreCore` — the agent's local copy was folded
  after slice 4 landed.)
- **Slice 5 — 2026-09-11.** `lib/reporting/printFeedback.ts`
  (`selectPrintFeedback(rubric, finalRationale)` — gated on
  `with_feedback === true` and a FINAL score's rationale, rows through
  `rubricScoreRows` so the level label prints, never the raw id). The
  print page's `?attempt=` view fetches the essay items with the flag,
  their responses and the final scores, and prints a "Feedback — Qn"
  block (criterion / level / points / comment, then the overall rationale)
  under the student's marks — the page never renders the answer text, so
  "under the answer" became "under the marks and integrity line" — with
  one framing line before the first block and no "AI" wording;
  `break-inside: avoid`. Proposed scores never print; the section view is
  unchanged. +9 tests (helper + page).
- **Slice 6 — 2026-09-11.** `converseText` / `converseTextWithMeta` /
  `converseTool` take a required `surface` (`ConverseSurface` union, the
  same five values as the guardrail surfaces) and an optional `ownerSub`,
  and emit one `log.info("ai_usage", { surface, model, input_tokens,
  output_tokens, total_tokens, latency_ms, owner_sub })` after every
  successful send (nulls when `usage` is absent, never throws). The five
  provider interfaces gained an optional `ownerSub` second parameter and
  every route / action passes the session sub it already held.
  `bedrockGuardrail` untouched — ApplyGuardrail's `usage` is policy-unit
  counts, not tokens. Metric filter = a later infra slice
  (`docs/observability-design.md`). +5 tests. **Full suite after slices
  1–6: 1532 pass, typecheck clean.**
