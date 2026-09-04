# E3 — a table the student fills in

Design page, 2026-09-02. Decisions marked **D-n** are James's (all six
accepted the same day); **§Progress says what is built** — slices 1–5 all
landed 2026-09-02, the hand-runs wait on the deploy. Source:
`docs/pdf-import-enhancements.md` E3 (a hand-built fixture equivalent to
Unit 0 Exam item 8: a fill-in-the-table prompt over a chi-square table
with five labelled rows and four data columns, imported today as an
essay whose stem carries the table as Markdown pipes).

## What exists that this stands on

- **Item types are a closed union on both sides.** `ItemSchema` in
  `packages/schema/src/items.ts` is a `discriminatedUnion` of eight types;
  `DeliveryItemSchema` (`delivery.ts`) and `ItemResponseSchema`
  (`responses.ts`) mirror it. The client's `DeliveryItem` enum
  (`client/SecureTestCore/Sources/SecureTestCore/DeliveryItem.swift`) is
  exhaustive by design: a ninth type fails the build at every `switch` that
  must learn about it, and a bundle carrying a type the installed client
  does not know **fails the whole decode** ("unknown item type") rather
  than skipping the item.
- **No migration for a new type.** `items.type` is `text`; per-type extras
  and keys live in the `items.config` jsonb bag, guarded by Zod at the
  write boundary (`design-tool/lib/api/items.ts`: match keys in
  `config.pairs`, order in `config.sequence`, hotspot in
  `config.regions` / `config.correct_region_ids`). `DEFAULT_SCORING_METHOD`
  / `ALLOWED_SCORING_METHODS` there are keyed by type and must gain an
  entry.
- **Keys never ride the student bundle** (ADR 0016). Each delivery item
  schema omits the key field or, for match / order, changes shape so no
  field can hold one. The Swift mirror has no field that can hold one
  either.
- **Responses** are `responses.response` jsonb, discriminated by the same
  type literal; match uses a record (`matches: {left_id: right_id}`), which
  is the nearest shape to a grid of cells.
- **Auto scoring** (`design-tool/lib/scoring/auto.ts`) awards one point per
  item, all-or-nothing for MC-multi / match / order / hotspot; `short_text`
  compares with `shortTextMatches` (trim, collapse whitespace, case-fold;
  then the E7(b) plain-or-folded formula rule). `null` means "not
  scorable", counted as skipped. `AutoScoreResult` already carries
  `max_points`, so a multi-point item needs no new shape.
- **The client renders items in page JS** (`AssessmentPage.swift`):
  `answerFor(item)` switches on type; `emphasisNodes(text)` renders
  `$…$` math and E6 bold / italic into any label (match uses it for the
  left column); `shortTextField` shows how a text input posts
  `{type, text}` on change; `matchField` shows how a record is assembled
  and posted, and that a fully cleared item posts nothing (absence = no
  response).
- **Pipe tables render nowhere today.** Neither `renderItemContent.ts`
  (editor / preview), `lib/preview/renderHtml.ts` (print), nor the client
  turns `| a | b |` into a table; the Unit 0 stem shows its pipes raw in
  all three.

## Proposed shape

**Item (authoring; `items.config`).**

```
type: "table"
columns:   [{ id, label }]                 // 1–8, the header row
rows:      [{ id, label }]                 // 1–30, the first column
corner:    string                          // optional caption of the label column
cell_keys: { [row_id]: { [col_id]: string } }   // optional, any subset of cells
```

Labels follow match-pair rules: KaTeX and `**bold**` / `_italic_`
allowed, plain strings otherwise (no asset refs, v1), ≤ 500 chars. Keys are plain text like
`short_text.correct_answer` (E7(a): never KaTeX in a key). The stem stays
the prompt above the grid. Every body cell is a blank the student fills
(D-1). `cell_keys` is the only field that can hold an answer and is the
field the delivery schema drops.

**Response.**

```
{ type: "table", cells: { [row_id]: { [col_id]: string } } }
```

Blank cells are omitted; a table with every cell blank is the absence of a
response, same rule as match. Cell text ≤ 500 chars.

**Delivery.** `DeliveryTableItemSchema = { type, id, stem, columns, rows,
corner? }`. Nothing else. Swift: `TableItem` with the same three fields.

**Scoring (`auto`).** For each keyed cell, `shortTextMatches(cell, key)`
extended with one rule for numbers (D-3): when both sides parse as a plain
decimal number, compare the numbers (`1.50` = `1.5` = ` 1.5 `). Points:
one per keyed cell, `max_points` = number of keyed cells (D-2). No key
cells → `null` (skipped), like an unconfigured hotspot. Methods: `auto`
(default) and `human`, the hotspot pattern.

**Export / import.** `ItemBundleSchema` carries `columns`, `rows`,
`corner`, `cell_keys?`; import round-trips them. A keyless table is a
legal draft (slice B). The slice-C copy carries it as any other item.

**Editor.** "Table" joins the type picker. The form: the stem, a *Columns*
list and a *Rows* list (add / remove / rename, same list control as choices
or match pairs), the corner caption, and below them the grid itself with
one text field per cell captioned *Expected answers (optional) — leave a
cell blank to accept anything there*. The existing Bold / Italic buttons
and KaTeX preview apply to labels. Scoring method: Auto / Hand-scored.

**Preview and print.** The grid with blank cells; in print the cells get a
fixed height so the paper form can be written in
(`lib/preview/renderHtml.ts`, beside the match table).

**Review queue / results.** The student's grid; when the item has keys, a
✓ / ✗ per keyed cell and the expected value under the student's text
(teacher-only, never in a student surface). Points read "3 / 5 cells".

**Client.** `DeliveryItem.table`, `ItemResponse.table(cells:)`, and
`tableField(item)` in the page JS: a `<table>` with `<th scope>` labels
through `emphasisNodes`, one `<input type="text">` per body cell
(`autocomplete=off`, `spellcheck` following the accommodation gate exactly
as `shortTextField`, an `aria-label` of "<row> — <column>"), Tab moving
across cells in reading order. On change it posts the non-empty cells.
Plain input, no formula preview (D-4). (No prefill on resume — see slice 3
in Progress: no field in the page prefills from saved responses today.) No paging change: the table renders
inline like everything else until per-question paging lands.

**PDF import (after the type exists).** `normalizePdfCandidate` in
`lib/pdfImport/extractCore.ts` recognises a Markdown pipe table whose
body cells are all empty at the end of a stem — the exact form the model
emitted for Unit 0 — and turns the candidate into a `table` (columns from
the header row, rows from the first column, corner from the header's first
cell, stem = the text before the table). The prompt gets a rule and the
mock provider a `TB:` segment; the panel's *Add as* choice offers
*Table | Essay* the way drawing / essay does. Bedrock re-run of Unit 0 as
the evidence.

**Out of scope, v1.** Cells that are fixed text (a partly filled table),
the student adding rows, column-type validation (numeric-only cells),
per-cell point weights, AI item generation producing tables, tolerance
bands on numeric keys. Each is a follow-up with its own evidence.

## Slices

The template is how `drawing_upload` arrived: slice 50 (`9f607ae`,
authoring across schema / DB types / API / export / import / preview /
editor), slice 65 (`0170b5f`, the response variant), slice 68 (`49d656c`,
the client renderer). Two kinds of touchpoint, learned from that
inventory (2026-09-02):

- **Guards that fail the build and lead the way:** `assertNever` in
  `lib/api/buildDeliveryBundle.ts`, `lib/api/exportBundle.ts`,
  `lib/api/importBundle.ts`, `lib/preview/renderHtml.ts`; the exhaustive
  `Record<ItemType, …>` tables in `lib/api/items.ts` and
  `AssessmentEditor.tsx` (`TYPE_LABEL`, `SCORING_OPTIONS`,
  `SCORING_DEFAULT`); every `switch` in the Swift `DeliveryItem` and
  `ItemResponse`.
- **Places that silently do the wrong thing for an unknown type** (no
  guard — the checklist): `app/dashboard/[id]/readiness.ts`
  `questionGaps` (reports no gaps), `scoring/ScoringQueue.tsx` (duck-types
  the response fields — renders a blank answer), `lib/scoring/auto.ts`
  (returns unscorable), `lib/api/requireDraft.ts` `isAnswerKeyOnlyPatch`
  (which config fields count as key-only after publish — `cell_keys`
  must join `correct_region_ids`), `lib/items/extractAssetRefs.ts` (config
  fields that carry asset uuids — labels stay plain-text-with-refs in the
  stem rules, so nothing to add unless labels get their own refs),
  `lib/api/importItemsCsv.ts` (the explicit unsupported list),
  `lib/pdfImport/extractCore.ts` (the prompt's type list),
  `lib/dev/seedAttempts.ts` (fake responses), `lib/api/itemIntegrity.ts`,
  `lib/safeguarding/itemText.ts`, and the client's `answerFor` default
  ("not available yet").

1. **Schema + write boundary + scoring + bundles.** `packages/schema`
   (items, delivery, responses, tests; `bun run build` for `dist`),
   `db/schema.ts` (`ITEM_TYPES` + `ItemConfig` fields — no migration),
   `lib/api/items.ts` (body schema, `itemConfigForWrite`, scoring tables,
   id-uniqueness + key-cells-exist validation), `requireDraft.ts`,
   `lib/scoring/auto.ts` (per-cell + numeric rule), `buildDeliveryBundle`
   / `exportBundle` / `importBundle` / `importItemsCsv` (unsupported),
   `itemIntegrity`, `safeguarding/itemText`, `seedAttempts`,
   `scripts/generate-delivery-fixture.ts` (regenerates the client's test
   fixture and `sample-delivery.json`). Tests: `packages/schema/test`
   (items / responses / delivery), `items-api`, `delivery-api`,
   `import-api`, `attempt-ingest-api`, `scoring-auto`, `item-readiness`,
   `safeguarding`, `answer-key-only-patch`. Size M.
2. **Editor + preview / print + review queue + results.**
   `AssessmentEditor.tsx` (`TYPE_LABEL`, `defaultItemFor`, add / save
   payloads, the form branch) + a new `TableEditor.tsx`; `readiness.ts`
   (a table with no rows or columns is a gap; no key is not — keyless is
   legal); `lib/preview/renderHtml.ts` (+ print branch);
   `ScoringQueue.tsx` and `results/page.tsx` (grid with ✓ / ✗ and points
   "n / m cells"). Tests: `preview-render`, `review-queue`, `results`,
   `item-readiness`. Size M.
3. **Client.** `DeliveryItem.swift` (`TableItem` + case + `Kind`),
   `ItemResponse.swift` (all four switches), `AssessmentPage.swift`
   (`tableField`, CSS, `answerFor`), resume prefill; new
   `RendererTableTests.swift` on the JavaScriptCore harness +
   `DeliveryBundleTests`; the regenerated fixture from slice 1;
   `swift test` + `xcodebuild`; rows in `client/MANUAL-CHECKS.md`.
   Size M. **Ships in the same deploy as the client rebuild** (D-6).
4. **PDF import detection** (`extractCore.ts` prompt list + rule +
   `normalizePdfCandidate`, `mockProvider.ts` `TB:` segment,
   `PdfImportPanel.tsx` Add-as choice; tests `pdf-extract`,
   `pdf-import-route`) + Unit 0 Bedrock re-run as evidence. Size S–M.
5. **Hand-run rows** in `docs/design-tool-manual-checks.md` (create, key,
   preview, print, export / import, review-queue marks) and the client
   rows (answer, resume, hand in, auto score).

Not touched: AI item generation (`lib/ai/types.ts` allow-list stays as
is — a table is not AI-generable in v1), CSV import (listed as
unsupported, like match / order), per-student stimulus sources
(`SOURCE_ITEM_TYPES` stays essay / short_text).

## Progress

**Slice 1 BUILT 2026-09-02 (local, not committed at the time of writing).**
Decisions D-1…D-6 all ACCEPTED as recommended (James, 2026-09-02).

- `packages/schema`: `TableItemSchema` (`columns`, `rows`, `corner?`,
  `cell_keys?`), `DeliveryTableItemSchema` (no `cell_keys` — the strip test
  proves a leaked key is dropped), `TableResponseSchema` (`cells`, at least
  one cell, 500-char cap). `dist` rebuilt. 103 schema tests pass.
- Design tool: `ITEM_TYPES` + `ItemConfig` gain the type and its four config
  fields (no migration — `items.type` is text); `lib/api/items.ts` body
  schema with the design limits (8 × 30, 500-char labels / keys, corner
  200), `validateTable` (unique ids, keys name real cells),
  `itemConfigForWrite` + `compactCellKeys` (an empty key object stores no
  key), scoring tables (`auto` default, `auto` / `human`); the publish
  lock's key-only PATCH admits `cell_keys`; `lib/scoring/auto.ts`
  `tableCellMatches` (D-3 numeric rule, else the short-text rule) and
  per-keyed-cell points (D-2); delivery / export / import branches; CSV
  import lists it unsupported; `itemIntegrity` refuses an empty grid;
  the guardrail text includes labels; `seedAttempts` fabricates cells.
- **Pulled into slice 1 by the build guards:** the preview / print grid
  (`renderHtml.ts` `assertNever` would not compile without a branch) and
  the editor's three exhaustive `Record<ItemType, …>` entries. The editor
  form itself is slice 2; until it lands the picker hides "Table"
  (`NOT_YET_PICKABLE`), so nothing can be created that the page cannot
  edit.
- **Deferred to slice 3 on purpose:** `scripts/generate-delivery-fixture.ts`
  and the regenerated Swift fixture — a ninth item there fails the client's
  decode until the client knows the type.
- Tests added: schema (items / responses / delivery), `items-api` (8 cases),
  `scoring-auto` (5), `delivery-api` (9-item scan + grid shape),
  `import-api` (2), `answer-key-only-patch` (2), `item-integrity` (1),
  `preview-render` (3), `attempt-ingest-api` (2). Full design-tool suite:
  1080 pass against the test DB; `bun run typecheck` clean.

**Slice 2 BUILT 2026-09-02 (local).** The editor form, readiness, the review
queue and the hand-score denominator.

- `TableEditor.tsx` (new): column headings and row labels as lists
  (add / remove, 1–8 × 1–30, a KaTeX / emphasis preview under each input
  as for stems), the corner caption (shown only once some row has a
  label, D-5), and the key grid — one text field per cell captioned
  *Expected answers (optional) — leave a cell blank to accept anything
  there*, with a live count ("3 cells checked, one point each" / "no cells
  are checked yet, so this table is hand-scored"). Removing a column or
  row prunes its keys. `AssessmentEditor.tsx`: `ItemView` / row mapping /
  `defaultItemFor` (2 × 2 to start) / Add ("New table", Column A / B,
  Row 1 / 2) / save payload / the form branch; the slice-1 picker filter
  is gone — "Table" is offered.
- `readiness.ts`: a table needs at least one column and one row, no
  empty column heading, and no seeded headings; **no key is not a gap**
  (a keyless table is hand-scored by design).
- **Hand-scoring denominator.** The manual score route pins `max_points`
  to a per-item constant (rubric max, else 1) so a column never carries
  different maxima per student. A table is now worth `tableMaxPoints`
  (`lib/scoring/auto.ts`): keyed cells when there are any — the same
  count the auto branch produces — else every body cell. The review-queue
  route emits `item.max_points` for every entry (rubric max / table cells
  / 1) and the queue's points field uses it instead of a hard-coded 1.
- Review queue: entries for a table carry `item.table` (columns, rows,
  corner, cell_keys — teacher-only surface); `ScoringQueue.tsx` renders
  the student's cells as the grid, with "✓ / ✗ expected <key>" under each
  keyed cell (same `tableCellMatches` rule as auto) and "n of m keyed
  cells match". Results matrix and CSV needed no change — they already
  print `points / max_points` per cell.
- Tests: `item-readiness` (complete keyless table clean; empty grid, empty
  heading, seeded headings named), `scoring-auto` (`tableMaxPoints`),
  `review-queue` (entry carries grid + keys + cells and max_points =
  keyed cells; keyless = every cell and a `max_points: 1` manual score is
  refused with `max_points_mismatch` while 3 / 4 is accepted; a non-table
  entry still says 1 and `table: null`). Full suite 1086 pass; typecheck
  clean. `TableEditor.tsx` and the queue grid are TSX without component
  tests — the hand-run rows (slice 5) cover them.

**Slice 3 BUILT 2026-09-02 (local).** The client.

- `DeliveryItem.swift`: `TableColumn`, `TableRow`, `TableItem` (id, stem,
  columns, rows, corner?) and the ninth case / `Kind` / decode / id / stem
  arms — no field can hold a cell's expected text. `ItemResponse.swift`:
  `.table(cells: [String: [String: String]])` in all four switches.
- `AssessmentPage.swift`: `tableField` — a `<table>` with `<th scope>`
  headings and row labels through `emphasisNodes` (KaTeX + E6), the label
  column and corner only when some row has a label (D-5), one text field
  per body cell (`autocomplete=off`, `spellcheck` on the accommodation gate,
  `aria-label` "<row>, <column>" with "Row n" / "Column n" for blank
  labels). Every change posts the cells that hold text; an all-blank grid
  posts nothing (the match rule). No formula preview (D-4). CSS for the
  grid. The script still carries no `</`, no innerHTML.
- **No prefill on resume**, deliberately: no field in the page prefills
  from saved responses today (the E12 outline is the one exception, fed by
  the bundle); the table follows the convention rather than inventing a
  channel. The design page's "resume prefill" line was wrong and is
  withdrawn.
- Fixture: `scripts/generate-delivery-fixture.ts` seeds a keyed table
  (position 9) and `Fixtures/delivery-bundle.json` was regenerated — every
  id churns on regeneration (fresh uuids + sealed ids derived from them),
  which is the existing behaviour, not new noise. `sample-delivery.json`
  in the app is a separate hand-placed sample and is untouched.
- Tests: `RendererTableTests` (one field per cell under the headings,
  emphasis as elements, aria-labels, posts only cells with text, records
  `H_2O` without judging, clearing posts nothing further, D-5 hides the
  label column, spell-check gate), `ItemResponseTableTests` (page message
  decode / encode round trip, missing `cells` refused),
  `DeliveryBundleTests` (9 kinds, the grid arrives without keys — the
  fixture bytes carry no `cell_keys` and not the key value); the three
  suites that count fixture items say 9. `swift test`: 315 pass;
  `xcodebuild … build` succeeds. Client rows added to
  `client/MANUAL-CHECKS.md` ("E3 slice 3").

**Slice 4 BUILT 2026-09-02 (local).** PDF import.

- Prompt (`lib/pdfImport/extractCore.ts`): a `table` shape — `columns` and
  `rows` as label lists, an optional `corner` — and the rule: a table
  printed with EMPTY cells for the student to fill is a table item (stem =
  the instruction before it); a table whose cells are filled is a
  stimulus, not an item; labels take KaTeX like stems.
- `normalizePdfCandidate`: a model table's bare-string / id-less labels get
  `c1…` / `r1…` (the match-pair convention); a blank corner is no corner.
  **Backstop** `fillableTableFromStem`: an essay or short-text candidate
  whose stem carries a Markdown pipe table with an all-blank body (what the
  model did on 2026-09-01) becomes a table — header → columns, first body
  column → row labels when any row has one (its header cell → corner),
  text before and after the table → stem; a table with data in its cells
  is left alone; a stem that is only a grid stays what it was.
- Mock: `TB: <stem> | cols=A,B | rows=X,Y | corner=Z`. Panel: `table · 4 × 2
  cells` label; *Add as: Table | Essay text box* on table candidates (the
  drawing / essay choice generalised to `workTypeOptions`).
- **Evidence — Bedrock re-run of Unit 0, 2026-09-02** (`samples/import-run/`,
  gitignored): 13 candidates, 0 rejected, types MC 6 / short 3 / essay 2 /
  drawing 1 / **table 1** — the chi-square question came back as a `table`
  from the prompt rule alone (the backstop was not needed). Two things for
  the teacher's eye, recorded rather than fixed: the model **transposed**
  the grid relative to the printed one (the data-column headers and the
  row labels swapped axes; the 2026-09-01 run had it the other way), and
  it made the trailing summary-formula line a sixth column. Both are
  edits in the editor; orientation is not something the text layer
  settles.
- Tests: `pdf-extract` (the Unit 0 shape → corner / columns / labelled rows
  / stem before + after; unlabelled grid and `Column n` for a blank
  heading; data tables and separator-less pipes left alone; the essay's
  fields dropped on conversion; grid-only stem stays; bare-string labels
  get ids, ids pass through, blank corner dropped; the TB segment;
  the prompt carries the shape), `pdf-import-route` (a TB candidate comes
  through and adds as a table with its grid and no keys). Full suite 1095
  pass; typecheck clean.

**Slice 5 WRITTEN 2026-09-02.** Hand-run rows 48–53 in
`docs/design-tool-manual-checks.md` (editor grid + readiness, keys / export
/ import / the answer-key-only door after Publish, preview + print, the
delivery bundle carries no key, auto and hand scoring, the Unit 0 import)
and the client rows in `client/MANUAL-CHECKS.md` ("E3 slice 3"). **Not run
yet**: they need the deploy (with the client rebuild) and, for the client
rows, a student sign-in.

**Hand-run 2026-09-03 (origin, rev 9): rows 48, 49, 50, 53 ✅** — the
editor grid, keys / export / import / the key-only door, preview + print,
and the Unit 0 import (this run: `table · 5 × 4`, transposed again, the
formula line folded into the Total row rather than a column). Rows 51 and
52 and the client rows wait on a student.

**Client hand-run 2026-09-03 (origin, rev 9, one student):** the grids
rendered in the client, one post per edited cell, and the keyed table
scored 3 / 3 in Results after the scoring pass. **Finding E3-F1 (decision
pending):** a keyless table left on the default `auto` is skipped by auto
AND never reaches the Scoring queue (which lists non-auto methods only),
so it sits unscored — while the editor caption says "hand-scored until you
fill some in". **DECIDED 2026-09-03 (James): a keyless table defaults to
`human` and flips to `auto` when a key is entered** — the caption was
right, the default was wrong. Not built yet; scope for the slice: the
effective method for a table with no `cell_keys` and no explicit
`scoring_method` is `human` (`effectiveScoringMethod` / the editor's
`SCORING_DEFAULT` read the config, not just the type); entering the first
key flips the effective default to `auto`, an explicit teacher choice
always wins; the review queue then lists keyless tables; tests for both
transitions and for the queue membership.

**E3-F1 BUILT 2026-09-03 (9f89a51, second-terminal branch `claude/e3-f1`;
deployed rev 10) and hand-run ✅ 2026-09-03 afternoon (row 57,
`docs/design-tool-manual-checks.md`):** a 2 × 2 keyless table on the
client-fixes fixture read "Default — Human (teacher scores)" in the editor,
flipped to "Default — Auto (machine-scored)" on the first key, and — left
keyless and published — reached the Scoring queue after the demo student
filled it, with `max_points` 4 (every cell) and the student's grid on the
entry.

**What could still fail** (before the hand-run, none of it was verified): the editor
form and the queue grid are TSX without component tests; the client grid
is proven in the JavaScriptCore harness, not in WebKit under AAC; the
model's table orientation varies (see slice 4).

## Decisions (James, 2026-09-02 — all recommendations accepted)

- **D-1 grid shape.** v1 = fixed header row + labelled rows, every body
  cell fillable. The general form (each cell either fixed text or a blank)
  is a v2 if a real teacher PDF needs it. Recommended: v1 as stated.
- **D-2 points.** One point per keyed cell (`max_points` = keyed cells),
  versus the all-or-nothing one point every other objective type uses.
  Recommended: per keyed cell — the table is N short answers in a grid,
  and the result shape already carries `max_points`.
- **D-3 numeric cells.** Compare as numbers when both sides parse as a
  plain decimal; otherwise the short-text rule. Recommended: yes, exact
  equality only; tolerance is a later knob.
- **D-4 cell input.** Plain single-line text, no formula preview or hint.
  Recommended: plain; a student typing `H_2O` into a cell is scored by
  the same folded rule as short text anyway.
- **D-5 blank row labels.** Allowed (a table of N empty trials); the label
  column is hidden only when every row label is blank. Recommended: allow.
- **D-6 deploy sequencing.** Because the installed client refuses a bundle
  with an unknown type, slices 1–3 go out together, in the deploy that
  already waits on the E12 client rebuild. Until then a published table
  item cannot reach a student; the readiness checklist does not need to
  say so if the deploy is one unit. Recommended: one deploy.
