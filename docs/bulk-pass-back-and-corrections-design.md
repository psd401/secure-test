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

## Slice 2: Attempt 1 vs latest (D-5, D-6, D-7)

- Results and the per-student page show **attempt 1**, **latest**, and the
  **change** for any attempt with `pass_back_count > 0`. Only those two, even
  after several pass backs (D-6).
- Attempt 1 is rebuilt rather than stored: for each response, the last
  `final` or `superseded` score created before the attempt's first
  `passed_back` event. `proposed` and `research` rows never count.
- An incomplete attempt the teacher reopens does not count as its own
  attempt (D-15): no attempt 1 or change is shown for it, and the gradebook
  offers only the latest. Teachers may use pass back as an extension, and a
  total from an unfinished test is not a result. What counts as incomplete
  is open question 4.3.
- The gradebook send dialog offers **attempt 1** or **latest** (D-7). Anything
  else is entered by hand in PowerSchool.
- Still open for slice 2: whether a COMPLETE attempt 1 stays listed in
  Results and the gradebook while the student works on the reopened test.

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

## Open questions

- **4.3** (slice 2) What makes attempt 1 "incomplete" under D-15: any item
  unscored at the pass back, any item unanswered, or the student never
  handed it in themselves (time ran out, or Hand in everyone)?

## Progress

- 2026-11-02 — note written; D-1…D-15 decided. Slice 1 built on
  `feat/bulk-pass-back` (route + GET, three controls, rows 902–911); not
  run in a browser. Hand-run rows 902–911 wait until every slice is built,
  then run with the later slices' rows in one session (James, 2026-11-02).
