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

## Slice 3: Corrections mode (D-8, D-9, D-10)

Two options in the pass-back dialog, single and bulk, chosen for that pass
back and not stored on the assessment:

- **Show right / wrong.** The reopened test marks each item correct, partly
  correct or incorrect from its attempt-1 final score. The dialog's choice
  overrides the assessment's `student_feedback` level for that pass back (D-9).
  The delivery bundle carries a mark per item and never a key (ADR 0016).
- **Lock correct answers.** Items with full credit become read-only; the
  student-write route refuses a change to them. Partial credit stays open (D-8).
- No "show only missed items" view (D-10).
- Needs a migration (the choices, on the attempt or the event), delivery
  bundle fields, server write refusal, and client rendering, which means a
  client release (AutoPkg next-day delivery). An older client ignores the
  marks; the server's write refusal still holds.

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
