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
