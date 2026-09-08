# Reporting — scoring hygiene, in-app views, exports, gradebook integration

Design page, 2026-09-03. Batches 1 (R0), 5 (R1–R2) and 6 (R3) of
`docs/roadmap-2026-09.md`. Decisions marked **D-n** are James's
(2026-09-03); recommendations not yet decided are marked as such.

## What exists that this stands on

- **One results surface.** `app/dashboard/[id]/results/page.tsx` renders a
  student × item matrix (`points/max_points` per cell, `AI ⏳`, `—`, `·`),
  a `Total` = final points / *scored* max, and a `Pending` count; fed by
  `lib/scoring/results.ts` `buildResults` (submitted attempts only;
  proposed AI scores never counted) and `GET /api/assessments/[id]/results`
  (`?format=csv` → `resultsToCsv`: `ssid,name,submitted_at,Q1..Qn,total,
  scored_max,unscored`, CRLF, formula-injection neutralised; golden test in
  `test/results.test.ts`). Reachable only from the editor header. Student
  identity on that path is `{ ssid, name }` from the per-teacher overlay —
  `ssid` is usually blank; no student number, email or section.
- **Scores are per response, append-only** (`scores`: `method auto | ai |
  human`, `points`, `max_points`, `rationale`, `status proposed | final`,
  one final per response). **No attempt-level total or status** beyond
  `in_progress | submitted`; every total is recomputed on read.
- **Auto-scoring is teacher-triggered.** `POST /api/attempts/[attemptId]/score`
  is idempotent and writes finals; `submit/route.ts` only flips the
  status. AI scoring (`score-ai`, `rescore-ai`) and manual scoring
  (`/api/responses/[responseId]/score`, `ManualScoreBody`, per-criterion
  scores) and approval (`/api/scores/[scoreId]/approve`, a new final row)
  all exist. The queue (`review-queue/route.ts` → `ScoringQueue.tsx`) lists
  non-auto responses without a final and renders the student's answer —
  except a drawing, which it renders blank (**F-1**: nothing under `app/`
  reads `response_uploads` back).
- **Section linkage exists, off the results path.** `attempts.test_session_id
  → test_sessions.section_ps_id` when the sitting was section-scoped;
  otherwise `students.roster_ps_id → roster_enrollments → roster_sections`;
  helpers `sectionsCurrentlyTaughtBy`, `studentsInTeachersSections`,
  `sectionLabel` ("Course · Period") in `lib/roster/`. `roster_students.ps_id`
  is the PowerSchool student number (`docs/roster-extract.md`); `email` is
  there too. The live monitor's attendance payload already does this join
  (`app/dashboard/[id]/attendanceView.ts`) — the template.
- **Print / PDF:** `/preview/[id]?print=1` renders the paper *form* only;
  no report print view; no PDF library; ADR 0013 rules out server-side
  Chrome here — PDF = a print-CSS view + the teacher's Save-as-PDF.
- **Per-attempt events** (`attempt_events`: quit, emergency_exit,
  focus_loss/regained, lockdown_*) have a write route and no read route;
  the monitor aggregates the newest only.
- **Does not exist:** a per-student view (teacher or student side), item
  analytics, standards / learning-target tags on items (no schema),
  weights (everything is worth 1 except rubrics and table cells), any
  vendor export, any outbound integration. PowerTeacher Pro / Schoology
  exports have been "gated on sample export files — action on James"
  since Phase 3 (`docs/phase-3-slices.md`, `docs/design-tool-plan.md` 1.8).

## R0 — scoring hygiene (batch 1, size S)

1. **Auto-score on submit (D-6, James: yes).** `submit/route.ts` runs the
   same idempotent pass the score route runs, after the status flip, in
   the same request (a handful of milliseconds per item); a scoring
   failure is logged and never fails the hand-in. The score route stays
   for re-runs. Tests: submit leaves finals for every auto item; a
   non-auto item is untouched; a scorer throw still returns 200 to the
   student.
2. **F-1 — a teacher can see a drawing.** `GET /api/responses/[responseId]/upload`
   (owner of the assessment; the response's `upload_id` looked up scoped
   to its attempt and item, the `readSavedUpload` posture from P-1; streams
   the stored bytes with the stored content type; `Cache-Control: private,
   no-store`). `ScoringQueue.tsx` renders `<img>` for drawing entries. Tests:
   owner 200 with bytes, another teacher 404, a pending slot 404. (A
   teacher-side render of a drawing on a `grid` / `axes` background needs
   nothing more — the PNG carries the paper.)
3. **Identifiers on the results path.** `buildResults` joins the overlay
   to `roster_students` (student number, email) and resolves a section
   label (sitting's section first, else the student's enrollment in one of
   the owner's current sections, else blank). The CSV header becomes
   `student_number,name,email,section,submitted_at,Q1..Qn,total,max,percent,
   unscored` — the golden test changes deliberately. **D-R1 (recommended):
   `max` is the assessment-level denominator** = the sum of every item's
   constant maximum (rubric max, keyed table cells, else 1 — the same
   constants the manual-score route pins), not the scored-only sum;
   **D-R2 (recommended): `percent` is blank until `unscored` is 0.**
   Tests: the join, the fallback order, another owner's roster never
   leaks, the denominator with a table and a rubric item.

## R1 — in-app views (batch 5, size M)

- **Results matrix**: the new columns; a section filter; a "complete"
  marker when `unscored` is 0; the matrix reachable from the Assessments
  list, not only the editor.
- **Per-student attempt page** `/dashboard/[id]/results/[attemptId]`: each
  item with the student's response rendered by the queue's renderer, the
  final score with method and rationale (AI proposal state shown, never
  counted), and an **integrity timeline** — a new teacher-authed
  `GET /api/attempts/[attemptId]/events` (owner only) mapped to plain
  words ("Left the test window 2:14 PM · back 2:15 PM", "Secure session
  ended by the student"). Drawings show inline (R0.2).
- **Item analytics** as a footer block on the matrix: per item, mean
  points / max (the p-value), % answered, and for MC the count per choice
  with the key marked — one query over `responses` + `scores` per
  assessment. No standards view (D-7, later).
- Tests: the events route (owner 200, other 404, order); analytics on a
  seeded assessment (known p-values, distractor counts); the attempt page
  renders every type (server component test through the route).

## R2 — exports (batch 5, size S + M)

- **Gradebook CSV — one shape for both systems (D-R3, recommended,
  confirmed by test imports).** Public documentation as of 2026-09-03:
  PowerTeacher Pro imports scores per assignment (Grading → Assignment
  List → gear → Import Scores) from a UTF-8 CSV whose minimum is *a student
  identifier column (the school-defined student number) and a score
  column*; a name column and extra score columns are allowed; one
  assignment is imported at a time even if the file has several; a file
  whose score type (points or percent) differs from the assignment's is
  translated on import (PowerSchool docs, "Importing and Exporting
  Scores", read 2026-09-03). Schoology
  imports grades (Enterprise instructors) by mapping a **Unique User ID**
  column and one column per assignment (the material's title) in its
  import dialog, the other columns left blank, then Preview; institutions
  differ on what the Unique User ID holds (an SIS id or an email) — at PSD
  it is expected to be the PowerSchool student number (SIS-provisioned
  accounts), **to confirm on the district instance**. So one file serves
  both: `Student Number,Student Name,<Assessment title>` with points
  (the teacher sets the assignment's points possible to `max`; percent is
  a second, optional column). Exploration before build (D-5, James: "want
  to explore this"): (a) a sample PowerTeacher Pro score export and a
  Schoology gradebook export from PSD instances; (b) a test import of one
  generated file into each; (c) which gradebook PSD teachers actually
  grade in. The existing analysis CSV stays as "Full results".
- **Print report** (ADR 0013 pattern): a no-script, server-rendered
  `/dashboard/[id]/results/print` — page one the assessment summary
  (title, section, date, N, mean, the item-analytics table), then one page
  per student (score, per-item marks, the integrity line count) with
  `@media print` page breaks; Save-as-PDF in the browser. Reuses nothing
  from `renderHtml.ts` (that is the paper form). A per-student page
  printed alone is the family-facing report.
- **FERPA posture** for both: owner-only, `no-store`, student numbers and
  names only where the teacher already sees them, no free-text responses
  in the gradebook file.
- Tests: the gradebook CSV's exact header and one row (golden), the
  percent rule, injection neutralised; the print view's structure and
  page-break markers.

## R3 — gradebook integration (batch 6, later)

PowerSchool is the gradebook of record; the export must serve Schoology
users too (D-5). Paths, with what each needs from the district:
- **PowerTeacher Pro CSV import** (R2) — no district action; the teacher
  imports per assignment.
- **Schoology REST API grade write** (OAuth 1.0a; admin-issued API keys;
  a Schoology app) — grades land in Schoology; whether they reach
  PowerSchool depends on PSD's Schoology → SIS grade passback being on for
  those courses (**to explore**).
- **LTI 1.3 with Assignment and Grade Services** — a tool registration
  in Schoology (admin), a line item per assessment, score passback per
  student; aligns with `docs/plan.md` Phase 4's LTI direction and is the
  standards route.
- **PowerSchool directly** — a plugin / PowerQuery, the heaviest (district
  install, vendor review); listed for completeness.
Recommended (D-R4): CSV for the pilot; then LTI 1.3 AGS to Schoology if
PSD's passback covers PowerSchool, else revisit. All of R3 joins the IT /
admin ask list (sample files, API keys or the LTI registration).

## Decisions

- **D-5 (James)** PowerSchool official; export covers both; sample files
  and integration path are an exploration. **D-6 (James)** auto-score on
  submit. **D-7 (James)** standards tags later.
- **D-R1 / D-R2 accepted 2026-09-03** (R0). **D-R4** recommended above.
- **D-R3 gradebook CSV — WAIT for the sample exports (James, 2026-09-07):**
  not built in batch 5; the shape is confirmed against a PowerTeacher Pro
  score export and a Schoology gradebook export from PSD instances plus one
  test import each, then built as a small Sonnet slice. The analysis CSV
  stays the only export until then.
- **D-R5 accepted for v1 (James, 2026-09-07):** the per-student page and
  the events route are owner-only (no sharing semantics; staff sharing
  copies assessments, not attempts).

## Model and effort

R0: Sonnet 5 / medium (three small, well-specified commits). R1: Opus 5 /
medium (a new page + two routes + analytics query). R2: Sonnet 5 / medium
for the CSV once the shape is confirmed; Opus 5 / medium for the print
view. R3: design later, with the district answers in hand.

## Progress

**R0 BUILT 2026-09-03** (three Sonnet 5 / medium slices, each reviewed
and re-run in the main session): `eb2c969` auto-score on submit — the
pass moved verbatim into `lib/scoring/runAutoScoring.ts`, shared by the
score route and `submit/route.ts` (try/catch, the hand-in never fails);
`df899b2` F-1 — `GET /api/responses/[responseId]/upload` (owner-only,
every failure 404, slot scoped to attempt + item and `complete`,
`private, no-store`) and the queue renders `<img>` for a drawing, capped
at the text answers' height (R1's per-student page is the full-size
render); `7d9a3e0` identifiers — **D-R1 and D-R2 accepted by James
2026-09-03** (D-R1 for v1; uneven per-question weights are a later
pass): roster join for number + email, section = sitting → owner's
current enrollment → blank, `max` = the constant sum, `percent` integer
and blank until `unscored` is 0, the CSV header as specified, the page
shows number · section under the name and a % column; `scored_max_points`
stays in the JSON. Hand-run rows 59–61 in
`docs/design-tool-manual-checks.md` — NOT run. R1–R3 unbuilt.

**R1 in-app views BUILT 2026-09-07** (one Opus 5 / medium pass; no
migration, D-R5 assumed — owner-only, no sharing semantics). What landed:

- **`lib/reporting/`, pure by design** so the R2 print view imports the same
  sentences and the same arithmetic rather than a second copy.
  `timeline.ts` maps `attempt_events` to plain words — a `focus_loss` and
  the `focus_regained` after it collapse into ONE line with the gap spelled
  out ("Left the test window 2:14 PM · back 2:15 PM (1 min)"), an unpaired
  loss says "did not return before handing in", lockdown begin/end are
  "Secure session started / ended", `emergency_exit` is "Secure session
  ended by the student", `quit` is "Quit the app", `lockdown_failed` /
  `lockdown_interrupted` reuse the monitor's `eventLabel` verbatim, and
  `client_error` reads "The app hit a problem: <detail.kind>" (the message
  stays off the line). Times are Pacific, through `lib/ui/format`.
  `analytics.ts` is aggregation over rows the caller fetched — mean over
  the responses carrying a FINAL score, the p-value as a whole percent of
  the item's constant max, % answered over the submitted attempts, and per
  choice the count with the key marked; a proposed AI score arrives as
  `points: null` and is counted nowhere. `answerView.ts` resolves a response
  against its item so a report reads "Copper" and "Water → H2O" rather than
  the queue's `c2` / `p1 → p1`.
- **`GET /api/attempts/[attemptId]/events`** — added beside the client's
  POST. Staff role, then attempt → assessment ownership; every failure after
  the role check is 404 (the R0.2 posture: no existence oracle), a student
  session is 403, the body is `{ events: [{ at, kind, detail }] }` ordered
  by `at` asc, `Cache-Control: private, no-store`. This is the first route
  file whose methods split by role, so `auth-role-enforcement.test.ts` grew
  a `STAFF_METHODS_ON_STUDENT_ROUTES` map and a mirror-image test rather
  than an exemption.
- **The matrix** (`results/page.tsx`): a section filter as a plain GET form
  (no client component, so the page still needs no JavaScript), "All
  sections" / each resolved label / "No section"; a last column reading
  "✓ Complete" or "n to score" (text AND glyph, never colour alone); every
  student name links to their attempt page; and the item-analytics footer,
  fed by `results/analyticsQuery.ts` — one left join of `responses` to its
  final `scores` row over the assessment's submitted attempts. The footer is
  assessment-wide and says so; the section filter narrows the table only.
- **The per-student page** `results/[attemptId]/page.tsx`, server-rendered:
  identity, totals and the section label all come from `buildResults`, so it
  cannot disagree with the row it was opened from (and an in-progress
  attempt 404s, because `buildResults` is submitted-only). Stems render
  through `renderItemContent` (KaTeX + owner-scoped image refs) exactly as
  the queue does; a drawing is the R0.2 upload route at full size; a table
  is the queue's grid with the expected cell beside each keyed one; the
  final score names its method in words and shows its rationale; an
  unapproved proposal reads "AI proposal: k / n (not counted)". The
  integrity timeline sits at the foot.
- **Reachability**: a "Results" button on every Published row of the
  Assessments list (`app/dashboard/page.tsx`) — until now the matrix was
  only reachable from inside the editor.

Tests: 1180 → 1221 pass, `bun run typecheck` clean. New files
`test/reporting-timeline.test.ts` (pairing, the unpaired loss, every kind in
`ATTEMPT_EVENT_KINDS` mapped, the `client_error` detail),
`test/reporting-analytics.test.ts` (hand-computed p-values, answered %,
distractor counts with the key, a proposal counted as answered-not-scored),
`test/reporting-views.test.tsx` (the three pages rendered through their own
page functions on a seeded assessment carrying every item type), plus a GET
block in `test/attempt-events-api.test.ts`. **Hand-run rows 69–74** in
`docs/design-tool-manual-checks.md` — NOT run; they want the demo student on
the origin with a real focus loss and a real End secure session, so they
pair with the batch 0b rows. Not built here: R2 (the print view is a
parallel agent's; the gradebook CSV is unstarted) and R3.

**R2 print report BUILT 2026-09-07** (Opus 5 / medium, its own worktree,
in parallel with R1). `GET /dashboard/[id]/results/print` is a server
component with no client JS bar one line that wires the "Print / Save as
PDF" button to `window.print()` — the ADR 0013 bargain, the same one
`/preview/[id]?print=1` struck, and it reuses none of `renderHtml.ts`
(that renders a blank form to write on). Owner-only, and every failure —
a non-uuid id, a missing row, another teacher's assessment — is the same
`notFound()`, so the URL cannot be used to probe for an assessment.
`export const dynamic = "force-dynamic"` is what keeps it out of caches
(Next answers an uncached dynamic render with `private, no-cache,
no-store, …`); a page cannot set a response header itself, and the proxy
sets none, so that is the whole of the `no-store` posture — worth a
second look if the header is ever wanted verbatim. `?section=<label>`
filters on the resolved section label; `?attempt=<attemptId>` prints that
one student's page ALONE with no summary page — the family-facing report.
Page one: title, section or "All sections", the hand-in date range, N
handed in, mean total and mean percent over COMPLETE rows only with
"k of N still have unscored items" beside them, then a Q# / type / max /
mean points / p-value table. Then one `.student-page` per student —
name · number · section, handed in, total / max with percent or
"n unscored", a marks row (`points/max`, `AI ⏳` for a proposal, `—` for
unanswered or unscored) and an integrity line in plain words. No free-text
response appears anywhere on the page, and a test asserts it. Two new
pure helpers: `lib/reporting/printIntegrity.ts` (counts `attempt_events`
by kind and says them — "Left the test window 2 times", "Secure session
ended by the student", `No integrity events` when there are none; a fixed
reading order, unknown kinds last under their raw name; deliberately
independent of R1's `timeline.ts`) and `lib/reporting/printSummary.ts`
(the cohort and per-item numbers). **`summarizeItems` is a stand-in**:
once R1's `lib/reporting/analytics.ts` merges, the print view should call
that for the per-item block — analytics owns the p-value and can supply
the item's CONSTANT max, where this helper can only read a max off the
scored cells and shows "—" for an item nothing has scored yet.
`summarizeCohort` has no analytics equivalent and stays. The results page
gained a "Print report" link beside "Download CSV". Tests:
`test/reporting-print.test.tsx` (12, test DB — structure, order, the
break markers, both query modes, owner-only) and
`test/reporting-print-helpers.test.ts` (12, pure). Design-tool suite 1180
→ 1204 pass, typecheck clean, no migration. Hand-run rows R2-P1…R2-P6 in
`docs/design-tool-manual-checks.md` — NOT run.

**Batch 5 (R1 + R2 print) MERGED 2026-09-07 evening** (`78b1638`; design-tool
1245 tests, typecheck clean, `next build` compiles; no migration). The
gradebook CSV waits for the sample exports (D-R3). Follow-up inside the
batch: the print page's per-item summary (`printSummary.summarizeItems`)
still folds `buildResults` cells and should call `lib/reporting/analytics.ts`
now that both are on `main` (constant max, p-value, % answered). Rows
69–74 and R2-P1…P6 in `docs/design-tool-manual-checks.md` are unrun; the
timeline rows need a real focus loss + End secure session on the origin.

**DEPLOYED 2026-09-07 21:39 PT — rev 13, rollout COMPLETED, /api/health 200; no migration.** The cdk CLI reported `SignatureDoesNotMatch: Signature expired` after a hung monitoring request and exited 1; CloudFormation had already completed.

**Fix slice 2026-09-08 (P5-1…3), hand-run rows R2-P1 / R2-P3.** Three defects
from the 2026-09-08 hand-run, all in the print report, none deployed yet.
**P5-1:** the page's own `formatDate` / `formatDateTime` used
`toLocaleDateString` / `toLocaleString` with no time zone, so a hand-in
printed in the server's UTC (a 3:50 PM Pacific submission read 10:50 PM);
deleted in favor of `lib/ui/format.ts`'s `formatDate` / `formatWhen`
throughout the page, the same helpers the per-student results page already
used. **P5-2:** `lib/reporting/printIntegrity.ts`'s `PHRASES` contradicted
`lib/reporting/timeline.ts` — `lockdown_end` read "ended by the student"
(that line belongs to `emergency_exit`) and `quit` said "Quit the test"
instead of "Quit the app". Brought into agreement: `lockdown_end` is now
"Secure session ended", `emergency_exit` "Secure session ended by the
student", `quit` "Quit the app"; `lockdown_failed` / `lockdown_interrupted`
now import `eventLabel` from `app/dashboard/[id]/attendanceView.ts` rather
than keeping a second copy of the monitor's words (the module stays pure —
`attendanceView.ts` has no DB import either, the same way `timeline.ts`
already gets away with it). `focus_regained` dropped out of the printed
line entirely (it only duplicated the paired `focus_loss` count) while
`countByKind` still tolerates and counts it. **P5-3:** the summary table's
Max column came from `printSummary.summarizeItems`, which read an item's
max off a scored cell and printed "—" when nothing had scored it yet
(exactly the follow-up flagged when R2 first merged). The print page now
calls `results/analyticsQuery.ts`'s `loadItemAnalytics` and feeds the
table from `lib/reporting/analytics.ts`'s `buildItemAnalytics` — the same
numbers the results page's footer already shows (constant max, mean,
p-value, % answered) — with a one-line note that these are assessment-wide
and the `?section=` filter narrows the student pages only, not this table.
`summarizeItems` and its `ItemStat` type are deleted from
`lib/reporting/printSummary.ts` (nothing else referenced them);
`summarizeCohort` stays, unchanged. Files: `app/dashboard/[id]/results/print/page.tsx`,
`lib/reporting/printIntegrity.ts`, `lib/reporting/printSummary.ts`,
`test/reporting-print.test.tsx`, `test/reporting-print-helpers.test.ts`. No
migration. Design-tool suite 1245 → 1246 pass, typecheck clean. Not
verified by a hand-run yet — redeploy pending.
