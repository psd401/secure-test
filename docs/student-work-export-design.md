# Student work export — printable class packets

Design note, 2026-09-14. Pilot-teacher feature request after the first
district-Mac sittings: "export class essays with names and class period, a
new page per student, one PDF per class, checkboxes for multi-select,
anonymous option, individual items or the full test with or without the
questions, at least one inch of margin for annotation, and scores /
feedback from the teacher, the AI, both, or neither." Design tool only;
nothing in the client or the shared schema moves. Decisions marked **D-n**
are James's (2026-09-14) and are listed at the end; **§Progress says what
is built** (nothing yet).

## What exists that this stands on

- **The results print report** (`app/dashboard/[id]/results/print/page.tsx`,
  R2 of `docs/reporting-design.md`) is the only print surface: a server
  component with no client JS beyond the `window.print()` button, owner-only
  (every failure is `notFound()`), `force-dynamic` + `no-store`, `?section=`
  and `?attempt=` query contract, `.student-page` blocks, `break-inside:
  avoid` feedback blocks. It carries a deliberate rule in its header: **never
  a free-text response**. This request inverts that rule on purpose, so the
  packet is a **new page**, not a mode of the report — the report's FERPA
  framing stays true of the report.
- **Print is client-side** (ADR 0013): "one PDF per class" is one printable
  page per section and the browser's Save as PDF. A one-inch margin is a
  `@page { margin: 1in }` rule; nothing server-side renders PDF.
- **`lib/reporting/answerView.ts`** (R1) already resolves every response
  kind against its item: `text` (essay / short text, newlines kept), `lines`
  (choice text, pairs, order, regions), `drawing` (bytes behind the owner-only
  `GET /api/responses/[responseId]/upload`, rendered as `<img>` in the queue
  since F-1), `table`. The per-student page draws all of them.
- **Scores** live in `scores`: `method IN ('auto','ai','human')`, `status IN
  ('proposed','final')`, one final per response. A teacher's score is the
  `human` final with `rationale.criterion_scores` + `rationale.note`; the
  AI's is the `ai` row (`proposed`, or `final` when a hybrid item
  auto-finalized). `lib/reporting/rubricScoreView.ts` +
  `printFeedback.ts` turn a rationale into criterion rows and an overall
  line. The corpus note (`docs/scoring-corpus-design.md`) adds a third
  status, `research`, which this page **never** shows.
- **Section label** per student is resolved the way the results matrix and
  the report do it (roster enrollment joined on `roster_ps_id`, the owner's
  current sections, else blank); the packet reuses that query.
- **Stems and choices** may carry `$…$` math; the per-student results page
  renders them with the design-tool KaTeX pass, and the packet uses the same
  component so the two never drift.

## Design

### The page

`/dashboard/<assessmentId>/results/work` — a server component in the same
shape and posture as the report: owner-only, `notFound()` on every failure,
`force-dynamic`, `no-store`, no client JS but the print button. It renders
**one page per handed-in attempt** in the section, ordered by student last
name (or by label when anonymous), each `break-before: page`, with the
options below applied uniformly.

Query contract (every option is a URL parameter so a packet is a link a
teacher can bookmark or re-print):

| Parameter | Values | Default |
|---|---|---|
| `section` | a resolved section label | required — one PDF per class means one URL per section; the toolbar lists them |
| `items` | comma-separated item ids | all items, in delivery order |
| `questions` | `1` show stems / choices / stimulus, `0` answers only | `1` |
| `scores` | `none` · `teacher` · `ai` · `both` | `none` |
| `anon` | `1` labels instead of names, key page last (D-1) | off |

**Per student page:**

- Header: student name and student number (or the label), section label,
  assessment title, handed-in date. In anonymous mode the header carries
  the label only — no number, no email.
- Per included item, in order: the question number; the stem, stimulus /
  sources and choices when `questions=1`; then the answer:
  - essay / short text — the text in a `white-space: pre-line` block, the
    same rule the client uses for stems.
  - multiple choice single / multi — **every** choice printed with a
    checkbox glyph, `☑` for selected and `☐` otherwise, so the teacher sees
    what was and was not chosen (the request's "checkboxes for multiselect").
    With `questions=0` only the selected choice texts print. Keys are never
    printed — this is a reading packet, not an answer key.
  - match / order / hotspot / table — `answerView`'s lines and grid, as on
    the per-student page; a hotspot prints the picture and the selected
    region labels beneath it (no overlay drawing in v1).
  - drawing — the `<img>` via the upload route, capped at the content width.
- Scores block, when `scores != none`, after the item's answer:
  - `teacher` — the `human` final: points / max, criterion rows, the note.
  - `ai` — the **latest `ai` row** by `created_at`, whatever its status,
    headed "AI proposal" (proposed) or "AI score (accepted)" (final); points
    / max, criterion rows, overall rationale. `research` rows are excluded
    by status.
  - `both` — the two blocks side by side in a two-column grid, teacher
    left, collapsing to stacked when either is absent.
  - An item with no row of the chosen kind prints "No <teacher|AI> score".
  - `auto` scores (keyed items) print as ✓ / ✗ per line under `teacher`
    and `both`, since the teacher's key made them.
- Footer on every page: assessment title · label or name · page n — so a
  loose annotated sheet finds its way back.

**The key page (D-1):** in anonymous mode a final page, `break-before:
page`, headed "Teacher key — do not distribute", a two-column table label →
student name + number, section and date. **Labels** are `Student 01 …
Student NN` assigned by sorting the section's handed-in attempts by attempt
id, zero-padded to the count's width. Given the same set of attempts the
labels are stable across re-prints; a new hand-in after the first print can
shift them, so the key page states the print date and attempt count. That
caveat is on the page, not just here.

**What is omitted, stated on screen:** students in the section without a
handed-in attempt are not in the packet. The toolbar shows "N of M students
in <section> handed in" before printing; in-progress attempts are never
printed (their answers may still change).

### The toolbar

Above the packet on screen only (`@media print { display: none }`): a plain
`GET` form that rebuilds the URL — a section `<select>`, an item checklist
(every item, all checked by default; "Select all / none" is two links, not
JS), the questions toggle, the scores radio, the anonymous checkbox, and
the Print / Save as PDF button. No client component: the form submits to
the same route. The results list page gains a **"Print student work"**
button beside "Print report" that lands here with the first section
selected.

### Print CSS

`@page { size: letter; margin: 1in }`; body font 11pt; `.student-page
{ break-before: page }`; `.item, .scores { break-inside: avoid }` where the
block is short, and plain flow for a long essay so it paginates rather than
overflows; `img { max-width: 100% }`. Margins are the request's one hard
number, so a hand-run row measures them in the saved PDF.

### FERPA posture

- Owner-only, same helper chain as the report; `no-store`.
- The page prints student names, numbers and free-text responses by the
  teacher's explicit action; the header comment says so and points here.
  Nothing about students who are not the teacher's.
- Anonymous mode exists so a packet can leave the teacher's hands (peer
  review, calibration, a PLC); the key page is the only place the mapping
  lives, and it is last so it tears off.
- No student identifier goes into the URL beyond the section label.

### Tests

The repo has no DOM harness for React clicks; the dashboard tree is
rendered headless by `reporting-views.test.tsx`, so:

- Pure helpers, each with its own test file: `lib/reporting/workPacket.ts`
  — `parsePacketQuery` (defaults + rejection of unknown `scores` values),
  `anonymousLabels` (width, stability, ordering), `selectPacketScores`
  (teacher final / latest ai / both / auto lines; `research` excluded),
  `choiceCheckboxLines` (every choice with its glyph).
- Rendering: the packet page rendered headless for a fixture with every
  item type, asserting the per-student page count, the checkbox glyphs, the
  key page in anonymous mode and its absence otherwise, and that the
  `research` row never appears.
- Hand-run rows in `docs/design-tool-manual-checks.md`: margins measured in
  the PDF, one PDF per section, a multi-page essay paginating, the anonymous
  key page, `both` with one side missing, a drawing printing.

## Slices

Every slice is one commit, diff reviewed and the suite re-run in the main
session before the commit. No migration.

| # | Slice | Agent |
|---|---|---|
| 0 | This note | — |
| 1 | `lib/reporting/workPacket.ts` helpers + tests; the `/results/work` page rendering every item type, the scores blocks, the key page, print CSS | **Opus 5 / medium** — touches the reporting helpers, the score-selection rules and the print layout together |
| 2 | The toolbar form, the results-page button, the headless rendering test, the hand-run rows | **Sonnet 5 / medium** — form + rows, no new rules |
| 3 | Hand-run on the origin after the next deploy (Claude in Chrome on the teacher side; a real PDF saved and measured) | Sonnet 5 / low |

Order: after the corpus note's slice 1 (the `research` status) lands, so
slice 1 here can exclude it from the start.

## Decisions

- **D-1 anonymous = labels + key page** (James, 2026-09-14). `Student NN`
  labels, a teacher-key last page, no student identifier anywhere else.
- **D-2 every item type in v1** (James, 2026-09-14). Not essays only;
  `answerView` already covers them, drawings via the upload route.
- **Scores shown are the teacher's final and the latest AI row** — a
  recommendation in this note, not yet a decision; the alternative (only
  the AI row the teacher acted on) hides the proposal the teacher has not
  reviewed yet, which is the one they most want to annotate.
- **Handed-in attempts only** — recommendation; in-progress answers can
  still change and a packet is a record.

## Progress

- 2026-09-14 — note written; nothing built.
- 2026-09-14 — **slice 1 BUILT** (not hand-run). `lib/reporting/workPacket.ts`
  carries the rules — `parsePacketQuery` (defaults, unknown `scores` → `none`
  rather than a throw, uuid-filtered `items`), `anonymousLabels` (lexical by
  attempt id, width ≥ 2), `selectPacketScores` + `packetScoreHeading` (teacher
  = the `human`-or-`auto` final, ai = the latest `ai` row whatever its status,
  `research` never), `choiceCheckboxLines`, `packetOrdering` (last name, with
  "Last, First" and "First Last" sorting together) — each tested in
  `test/work-packet.test.ts` (26 tests).
  `app/dashboard/[id]/results/work/page.tsx` is the page: the report's posture
  (owner-only, `notFound()` everywhere, `force-dynamic`, one inline print
  script), handed-in attempts only, one `.student-page` per attempt with an
  identity footer, every item type through `describeAnswer` / the per-student
  page's table grid, a set's stimulus and sources once above the first of its
  included questions through `renderItemContent`, the hotspot picture, the
  drawing via the owner-only upload route, the score blocks through
  `rubricScoreRows` / `overallRationale`, the anonymous key page, and
  `@page { size: letter; margin: 1in }`. `test/work-packet-page.test.tsx` (19
  tests) renders it headless. Deviations from the note: `selectPacketScores`
  takes (mode, rows) only — the auto ✓ / ✗ lines come from `answerView`'s
  `AnswerLine.correct`, which the page already has, so no third argument was
  needed; and with `section` absent the page renders a section chooser (links +
  per-section handed-in counts) rather than nothing, which is the thing slice
  2's toolbar replaces. Slice 2 still owns the toolbar form, the results-page
  button and the hand-run rows; an HTML comment marks where the form goes.
- 2026-09-14 — **slice 2 BUILT** (not hand-run). The toolbar is a plain `GET`
  form on `/results/work` (no client component, no JS beyond the existing
  print-button script): a section `<select>` (every section with a
  handed-in attempt, the current one selected — `sectionCounts` is now
  computed once, above the `?section=` branch, so both the chooser and the
  toolbar read it), an item checklist in delivery order (every item, `Qn` +
  `stemExcerpt(item.stem)` — a new pure helper in `workPacket.ts` that strips
  image refs, `$…$` math markers and light markdown, then cuts to 60 chars),
  a `questions` checkbox, a `scores` radio (`PACKET_SCORE_MODES`) and an
  `anon` checkbox, and an Update submit button beside the existing Print
  button. The `questions` mechanism: a `<input type="hidden" name="questions"
  value="0">` immediately before the checkbox (`value="1"`) — an unchecked
  box submits nothing, so the hidden field's `0` is what reaches the server;
  a checked box's `1` sits later in the form and so later in the query
  string. `parsePacketQuery`'s parameter reader was renamed `lastParam` and
  changed from first-wins to **last**-wins to make that work (a repeated
  `section` in a hand-edited URL now resolves the same way — the existing
  test for that was updated, not just left green by accident). `items`
  changed from "one comma-joined value" to "one comma-joined value OR one
  value per repeated parameter" (`allValues`), because the checklist is one
  checkbox per item, all named `items` — both shapes parse to the same set.
  Deviations from the note: (1) "Select all" is a link (`packetHref` rebuilds
  the query with `items` omitted); there is no "Select none" — an empty
  packet prints nothing useful, so the note's fallback ("`items=` of the
  first item only") was skipped in favor of just not building it, noted in
  an HTML comment on the page; (2) the "no section" bucket is NOT a select
  option — slice 1 only ever counted unsectioned attempts, it never gave
  them a route, so there is nothing for a select option to link to; the
  count still prints as unstructured text where slice 1 left it, in the
  chooser branch only. The results list page (`results/page.tsx`) gained a
  "Print student work" link beside "Print report", landing on the chooser
  (no `?section=`, since the packet needs one). Tests: `test/work-packet.test.ts`
  gained `stemExcerpt` cases, the `lastParam`/`items`-as-array cases, and the
  existing repeated-`section` case now expects the last value; `test/work-packet-page.test.tsx`
  gained a "slice 2's toolbar" describe block (the select's selected option,
  every checkbox checked by default and following `?items=`, "Select all"'s
  href, the scores radio and anon checkbox following the query, and the
  `questions=0` hidden-field-then-checkbox rendering) — a `packetBody()` test
  helper scopes a handful of pre-existing "not printed" assertions to
  `<main class="packet">` onward, since the toolbar's checklist now
  legitimately prints every item's stem regardless of `?items=`/`?questions=`;
  `test/reporting-views.test.tsx` gained one assertion for the results page's
  new link. Counts: design-tool 1707 (was 1693; `resultsToCsv`'s golden-CSV
  test is separately flaky, unrelated to this slice — see below), typecheck
  clean. Rows 168–184 added to `docs/design-tool-manual-checks.md`, all NOT
  RUN — slice 3 hand-runs them after the next deploy.
- 2026-09-14 — the pre-existing `golden CSV` flake in `test/results.test.ts`
  was diagnosed and FIXED the same evening: the fixture inserted both
  attempts in one statement, so they shared `started_at = now()` and
  `buildResults` (ordered by `started_at` alone) returned them in either
  order. The fixture now seeds distinct `started_at`, and `buildResults`
  tie-breaks on attempt id. Three full-suite runs clean.
- 2026-09-14 — **DEPLOYED (rev 26, `018a37c`, Aurora 0035) and rows 168–179 RUN
  on the origin** (Claude in Chrome, teacher side; fixtures `Client rows
  hand-run 2026-09-08` + `Multi-source hand-run 2026-09-09`): 168 / 169 / 172 /
  174 / 176 / 177 / 178 ✅, 173 half, 170 CSS-only (PDF not measured), 171 /
  175 / 179 NOT RUN (no long essay, no AI proposal, no second staff account
  on the origin). **Finding W-1, fixed the same evening:** ✓ / ✗ on keyed
  lines and the table's `expected <key>` cells printed under `scores=none`
  and `scores=ai` — the key in a packet that may leave the teacher's hands.
  Now they print only with `scores=teacher` / `both` (`showKey`), with a
  test. The toolbar's stem excerpt kept a bare `\times` after
  stripping the `$` — FIXED the same night: common LaTeX commands map to
  their symbol (× ÷ · ± ≤ ≥ ≠ π √ ° ∞), the rest and their braces vanish. Fixture readings, not defects: a `$`-before-digit
  stem prints raw on every page by C-2's rule; one stored short-text answer
  is `4^2^`.
