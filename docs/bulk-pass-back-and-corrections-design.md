# Bulk pass back, corrections, and full-test Google Docs (roadmap U-25)

Design note, 2026-11-02. Roadmap `docs/roadmap-2026-09.md` §"Unscoped" row
**U-25**. An open-beta teacher asked (2026-11-02) whether a whole class's
tests could be passed back at once instead of one by one, "to have kids take
another shot or do work with the questions they miss". James widened it the
same day to corrections and to sending the full test to Google Docs.
Decisions marked **D-n** are James's (2026-11-02) and are listed at the end;
**§Progress says what is built**.

## What exists that this stands on

- **Per-attempt pass back** (`docs/pass-back-design.md`, U-7):
  `passBackAttempt` in `lib/api/passBackAttempt.ts` flips one `submitted`
  attempt to `in_progress`, marks its `final` scores `superseded`, adds 1 to
  `pass_back_count`, and writes a `passed_back` event, all in one
  transaction. The route requires `edit`, refuses `not_submitted`, and needs
  a new deadline on a timed attempt. The helper was split out so a bulk
  caller would not fork what passing back means.
- **Bulk precedent**: Results' "Hand in all in progress" (U-14,
  `app/api/assessments/[id]/hand-in/route.ts`) takes the `attempt_ids` the
  page shows, re-checks each one, and acts on them in sequence with one small
  transaction each. It selects by id, not by `test_session_id`, because a
  resume rebinds an attempt to the last sitting joined.
- **The client needs nothing for slice 1**: a passed-back attempt opens on the
  next join with its answers in place.
- **Instant feedback** exists only as a screen after the student's own
  hand-in, never after a pass back (`lib/feedback/buildFeedback.ts`).
- **Google Docs release** (`lib/googleDocs/release.ts`, GD) sends one Doc per
  student per assessment, holding essays only, in the teacher's Drive
  (`drive.file` scope).
- **Gradebook push** sends `buildResults`' `total_points`, which is the latest
  `final` scores. A reopened attempt is not in `buildResults` (it lists
  handed-in attempts) until it is handed in again.

## Slice 1: Pass back everyone (D-1, D-2, D-3)

One new route, `POST /api/assessments/[id]/pass-back`, body
`{ attempt_ids: uuid[1..1000] | section: string, ends_at?: ISO }` (exactly
one of the two), built like U-14's hand-in:

- `edit` on the assessment, the same as the per-attempt pass back (a
  substitute's `run` does not reach it).
- The caller sends the ids it shows; the server never trusts the list. It
  skips an id on another assessment, a practice attempt, or one that is not
  `submitted`.
- A deadline is required (400 `ends_at_required`) when any selected attempt is
  timed (`attemptIsTimed`), and refused when it is in the past
  (`ends_at_past`). It is written only to the timed attempts; an untimed one
  gains no deadline, matching the per-attempt route.
- Each attempt goes through `passBackAttempt` in sequence, one transaction
  each. A second press passes back 0 and says so; it is not an error.
- The response reports `passed_back`, `skipped` and `superseded_scores`.

Callers (one shared dialog, `PassBackAllControl`):

- **Results page**: "Pass back all handed in" over the rows shown, so the
  section filter decides the class (D-1, by section).
- **Monitor** and each **Test sessions** row: "Pass back everyone" over the
  sitting's handed-in rows (D-1, by sitting).
- **Test sessions list header**: "Pass back a class…" opens a section picker
  (D-14). It has no results rows in hand, so `GET …/pass-back` lists every
  section with someone handed in (label, count, whether a deadline is
  needed) and the POST sends `section`. Both resolve sections through
  `buildResults` (`lib/api/passBackSections.ts`), so a section there is exactly
  the Results filter's.
- Dialog copy: "Pass back N students? Their answers stay; they can change
  them and hand in again. K scores are kept as a record." plus the deadline
  picker when timed.

Why one route and not a sitting route plus a section route: the sitting's
attendance rows already carry attempt ids, so both callers can send ids, and
selecting by `test_session_id` misses rebinds (U-14's reason).

## Slice 2: Attempt 1 vs latest (D-5…D-7, D-15…D-20)

- Results and the per-student page show **attempt 1**, **latest**, and the
  **change** for an attempt that has an attempt 1. Only those two, even after
  several pass backs (D-6). The CSV gains the same columns only when someone
  on the test has an attempt 1 (D-18).
- **Which hand-in is attempt 1** (D-15, D-16, D-20): the first pass back that
  reverses a hand-in the student made themselves. A student cannot hand in
  after their deadline, so time running out always ends in a teacher hand-in
  (`teacher_hand_in` event); a pass back of one of those is an extension and
  not an attempt. After extensions, attempt 1 is the first round the student
  handed in themselves. Read from `attempt_events`, so pass backs made before
  this slice are covered.
- **Its score**: for each answer that existed at that pass back, the last
  `final` or `superseded` score given in that round. An answer with none makes
  attempt 1 **"not fully scored"**: shown, no total, and an attempt-1
  gradebook send leaves the student out (D-17).
- A student with no attempt 1 has one score; attempt 1 and latest are the
  same for them.
- **While the test is reopened** (D-19): the student stays listed as working
  again with their attempt-1 score. An attempt-1 send includes them; a latest
  send holds them back until they hand in.
- **Gradebook** (D-7, D-20): the send dialog chooses **Latest** or
  **Attempt 1**. The choice is stored on the section's push
  (`gradebook_pushes.basis`), so Send again keeps it; switching re-sends only
  the scores that change.
- Built in three commits: 2a the calculator (`lib/scoring/attemptOne.ts`),
  2b the display, 2c the gradebook.

## Slice 3: Corrections mode (D-8…D-10, D-21…D-27)

Two checkboxes in every pass-back dialog (one student, Pass back everyone,
Pass back a class): **Show right/wrong** and **Lock correct answers**. They
apply to everyone that press passes back (D-25) and are stored on the
attempt, not the assessment.

What the student sees on the reopened test:

- **Marks** (D-21): each question shows ✓ correct, "partly correct" or ✗
  incorrect — no points, never the answer. The delivery bundle carries the
  mark only (ADR 0016: the student's wire format has no field for a key).
- **Which scores** (D-24): the hand-in just passed back — the last `final` or
  `superseded` score per answer in that round (the round rule from
  `lib/scoring/attemptOne.ts`, applied to the latest round instead of the
  first). After two pass backs, marks follow the second.
- An unreviewed AI final counts (D-22): it already counts in totals.
- A question with no score in that round gets no mark and stays open (D-23).
- **Locks** (D-8): only full-credit answers; partial credit stays open. A
  locked question is read-only on the page, and the response write routes
  refuse a change to it (409 `item_locked`).
- Instant feedback stays off after the re-hand-in, as today (D-26).
- **Older clients and renderers** (D-27): marks and locks reach a student only
  when the client is 2.0+ AND the served renderer is new enough to draw them.
  Otherwise the bundle carries neither and the server refuses nothing — the
  `allow_highlighting` precedent (H-1), not the calculator's refusal. The
  attempt records whether locks were delivered; the write guard refuses only
  then, so a student is never shown a field that silently will not save.

No client release: the page is the signed served renderer (v2.0), whose
source is extracted from `client/SecureTestCore/…/AssessmentPage.swift`. A
new renderer is built and signed (James) and named by `renderers/current.json`
in the deploy.

### Commits

- **3a — the choice.** Migration: `attempts.corrections` jsonb (null, or
  `{ show_marks, lock_correct, passed_back_at, locks_delivered }`).
  `passBackAttempt` takes the two options and writes them (cleared on a pass
  back without them); the per-attempt route, the bulk route (ids and section)
  and all three dialogs send them. No student-visible change yet. Tests: the
  route and helper write and clear it; dialog copy.
- **3b — the server half.** `lib/feedback/correctionMarks.ts` (pure, plus a
  loader): marks per item from the latest round's scores with
  `buildFeedback`'s correct / partial / incorrect rule; locks = full credit.
  `DeliveryBundleSchema` gains an optional `corrections: { marks, locked }`
  (`packages/schema`, `bun run build` there). `buildDeliveryBundle` adds it
  only past the gate (client ≥ 2.0.0 and the current renderer's version ≥
  `MIN_RENDERER_VERSION_FOR_CORRECTIONS`, null until 3d — so nothing is
  delivered yet) and sets `locks_delivered`. The response and upload write
  routes refuse a locked item when `locks_delivered`. Tests: marks rules,
  bundle never carries points or keys (the delivery-api key sweep), the gate
  both ways, the write refusal, instant feedback still off after the
  re-hand-in.
- **3c — the page.** `AssessmentPage.swift`: a mark beside each question
  number and on the question; a locked answer drawn read-only with "Correct —
  locked"; VoiceOver labels; never colour alone. Swift tests in
  `SecureTestCore` (headless). Manual-check rows in `client/MANUAL-CHECKS.md`
  (VoiceOver per the VoiceOver method). Then James builds and signs the
  renderer.
- **3d — turn it on.** A renderer's version is the committer time of the
  `main` commit it is built from (`packages/renderer/scripts/build.ts`), and
  `main` is linear, so every renderer built at or after the merge of 3c has
  a version ≥ that merge's time `T`, and every older one is below it. After
  the slices 1–3c PR merges, read `T` (`git log -1 --format=%ct origin/main`
  right after the merge); a second small PR sets
  `MIN_RENDERER_VERSION_FOR_CORRECTIONS = T` and adds the help-page text.
  Then ONE deploy after school (D-29): `deploy.sh` re-signs the renderer
  (Touch ID) with a version ≥ `T` because the page files changed. A floor
  taken from a branch commit is not safe — a renderer built from `main`
  before the merge could carry a later time without 3c, and the server would
  then refuse writes on a page that shows the field as editable. Hand-run
  rows 902–920 and the client "Corrections mode" rows run after that deploy.

## Slice 4: Full test to Google Docs (D-11, D-12, D-13)

- The GD send gains a "whole test" option: every item, not only essays.
- The Doc holds the student's answers and approved scores only, **never the
  correct answers** (D-11).
- Choice items list every option with the student's choice marked (D-12).
- A passed-back student's Doc shows the **latest** attempt (D-13).
- Drawings, graphs and hotspots go in as images. The work packet's per-type
  layout is the starting point, converted to Docs-safe HTML.
- No new Google scope; GD's skips (safeguarding alert, no email, not handed
  in) still apply.

## Decisions (James, 2026-11-02)

- **D-1** Bulk pass back by sitting **and** by section.
- **D-2** Everyone handed in; no score filter.
- **D-3** The control appears on Results and on the Test sessions list (and
  on Monitor beside "Hand in everyone").
- **D-4** Build slices 1 and 2; discuss slice 3 before building it.
- **D-5** Attempt 1 with any unscored item shows "incomplete" (refined by
  D-15).
- **D-6** Show only attempt 1 and latest.
- **D-7** Results show attempt 1, latest and the change; the gradebook send
  chooses attempt 1 or latest.
- **D-8** Corrections: the teacher chooses whether to show right/wrong and
  whether to lock correct answers. Partial credit is never locked.
- **D-9** The pass-back dialog's right/wrong choice overrides the assessment's
  feedback level.
- **D-10** No "only missed items" view.
- **D-11** Full-test Docs: student answers and scores only, no keys.
- **D-12** Choice items show every option with the student's choice marked.
- **D-13** A passed-back student's Doc shows the latest attempt.
- **D-14** (4.1) Both Results and the Test sessions list have a section
  picker.
- **D-15** (4.2) An incomplete test the teacher reopens does not count as its
  own attempt: no "attempt 1" is shown for it (slice 2).
- **D-16** (4.3) Incomplete = the student did not hand it in themselves (time
  ran out, or a teacher hand-in).
- **D-17** (5.1) Attempt 1 handed in by the student but not fully scored at the
  pass back shows "not fully scored" and is left out of an attempt-1 send.
- **D-18** (5.3) CSV attempt-1 columns only when someone was passed back.
- **D-19** (5.2) A complete attempt 1 stays listed while the test is reopened;
  an attempt-1 send includes it, a latest send holds it back.
- **D-20** (5.4, 5.5) The send's basis is remembered per section push; after
  extensions, attempt 1 is the first time the student handed in themselves.
- **D-21** (6.1) Marks are ✓ / partly / ✗ only: no points, no answers.
- **D-22** (6.2) An unreviewed AI final produces a mark.
- **D-23** (6.3) A question unscored at the pass back gets no mark and stays
  editable.
- **D-24** (6.4) Marks and locks follow the hand-in just passed back, not
  attempt 1.
- **D-25** (6.5) In a bulk pass back the options apply to everyone in it.
- **D-26** (6.6) Instant feedback stays off after the re-hand-in.
- **D-27** (6.7) A client or renderer too old for marks gets no marks and no
  locks, and the server refuses none of its writes.
- **D-28** (7.1) Slices 1–3c go to `main` in one PR, with the renderer floor
  still null.
- **D-29** (7.2) That PR is not deployed on its own: one deploy after 3d,
  so teachers never see corrections checkboxes that do nothing.
- **D-30** (7.3) Slice 4 (whole test to Google Docs) starts on a fresh
  branch after this ships.

## Open questions

None open for slices 1–2.

## Progress

- 2026-11-02 — note written; D-1…D-15 decided. Slice 1 built on
  `feat/bulk-pass-back` (route + GET, three controls, rows 902–911); not
  run in a browser. Hand-run rows 902–911 wait until every slice is built,
  then run with the later slices' rows in one session (James, 2026-11-02).
- 2026-11-02 — D-16…D-20 decided; slice 2a (attempt-1 calculator) built.
- 2026-11-02 — slice 2b (Results / per-student page / CSV) built; rows 912–916.
- 2026-11-02 — slice 2c (gradebook Latest / Attempt 1, migration 0068) built; rows 917–920.
- 2026-11-02 — the rescore note's "Send again" section list made basis-aware (an attempt-1 push is not named for attempts with an attempt 1).
- 2026-11-02 — D-21…D-27 decided; slice 3 planned as 3a–3d. Nothing built.
- 2026-11-02 — slice 3a built (migration 0069 `attempts.corrections`, the two checkboxes in all three dialogs). Until 3d the checkboxes are stored but change nothing a student sees, so 3a should not reach production on its own; the help page is updated with 3d.
- 2026-11-02 — slice 3b built (marks/locks, bundle field, gate with a null renderer floor, write guard). Delivery also needs `RENDERER_DELIVERY=on`; the deployed service sets it (`design-tool/infra/lib/app-service.ts`).
- 2026-11-02 — slice 3c built: the page draws the notes and locks (`AssessmentPage.swift`: `correctionNote`, `lockAnswer`; `post` / `withdraw` / `postDrawing` refuse a locked item). `RendererCorrectionsTests` (7). Hand-run rows in `client/MANUAL-CHECKS.md` ("Corrections mode in the test page"). Not drawn on the paged strip or review page. Next: 3d — confirm how a renderer version is numbered, set the floor, deploy.
- 2026-11-02 — D-28…D-30 decided; 3d planned (floor = the merge commit's time).
