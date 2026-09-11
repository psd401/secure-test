# Time limit in the client, and what a teacher can do with an unfinished attempt

Design note, 2026-09-11. James's question: "if a student begins an
assessment and time expires, does the teacher have a way to see what they
have done so far?" — the answer was no. Decisions **D-1…D-4** are James's
(2026-09-11) and are listed at the end; **§Progress says what is built**.

## What exists that this stands on

- **`assessments.time_limit_seconds`** is authored on the Settings tab and
  stored, but nothing reads it: not `buildDeliveryBundle.ts`, not the
  shared `DeliveryBundleSchema`, not the client. The only clock a student
  meets is the sitting's `expires_at`, which the client shows as "closes
  3:08 PM" on the Your-tests list; when the lockdown session ends for any
  reason the client presents "Secure session ended — your answers are
  saved. You can keep working here, or go back to your tests."
- **Answers are saved as the student goes** (`POST /api/attempts/[id]/responses`
  per answer, drawing autosave), so an unfinished attempt's work is in
  `responses` already. `attempts.status IN ('in_progress','submitted')`,
  `started_at` is set on creation, `submitted_at` on hand-in; an attempt is
  unique per (assessment, student) and `POST /api/attempts` resumes it with
  every saved answer prefilled (P-1).
- **Every teacher surface is submitted-only**: `buildResults`
  (`lib/scoring/results.ts:114`) filters to `submitted`, and the matrix, the
  per-student page (which deliberately 404s an in-progress attempt), the
  review queue, the print report and the CSV all sit on it. The Monitor is
  the one place an in-progress attempt shows: the "k of N answered" bar and
  View screen, while the sitting is open.
- **Delete attempt** (`DELETE /api/attempts/[attemptId]`) is the model for a
  teacher action on someone else's attempt: owner-only, 409 `session_open`
  while the sitting is open and unexpired, cascade, audit row, a control on
  the per-student page and every Monitor row (disabled until the session
  is closed).
- **`attempt_events.kind`** is a CHECK-constrained list (quit, emergency_exit,
  focus_loss, …, client_error); the timeline on the per-student page and
  the print integrity line read it. Adding a kind is a migration.
- The client's `PeekNotice` is an amber, dismissable strip the page shell
  already renders for the View-screen disclosure — the right shape for an
  unobtrusive "5 minutes left".

## Design

### The clock (D-2, D-3)

- **Deadline = `attempts.started_at + time_limit_seconds`**, computed on the
  server and carried in the delivery bundle as `time_limit_ends_at` (ISO
  8601, optional; absent when the assessment has no limit). Per attempt,
  not per sitting: a student who relaunches or resumes in a later sitting
  keeps the same deadline, and the client never does the arithmetic from
  its own clock's idea of "now" beyond counting down from the server's
  instant (the bundle also carries `server_now` so the client can offset a
  skewed Mac clock).
- **Client banner**: a slim strip under the page shell's header showing
  "Time left 42:17", updating each second, with a × that hides it for the
  rest of the attempt (D-3). Hidden or not, at **5 minutes** and at
  **1 minute** the amber notice strip shows "5 minutes left" / "1 minute
  left" through the existing `PeekNotice` mechanism (auto-dismisses after
  ~8 s, never a modal, never steals focus from the answer field). Under
  the last minute the banner, if visible, turns the Clay danger colour.
- **At zero the client ends the secure session, it does NOT hand in (D-2)**:
  the existing `endLockdown` path runs with reason `time_expired`, an
  `attempt_events` row `time_expired` is posted, and the session-ended
  sheet reads "Time is up. Your answers are saved." with the single button
  "Back to your tests" (no "Stay here" — see the server rule next). The
  attempt stays `in_progress`.
- **Server rule**: `POST …/responses` and drawing-slot completion refuse
  with **409 `time_expired`** once `now > started_at + limit + 30 s` grace
  (the grace covers an in-flight autosave at the buzzer). `submit` by the
  student is refused the same way — handing in after time is the teacher's
  call (below). Assessments without a limit are untouched.
- **Not in scope**: pausing the clock, per-student extended time (the
  accommodations catalog has `extended_time`; wiring it as a multiplier on
  the limit is the obvious follow-up — noted, not built), a teacher-side
  "add 10 minutes".

### Teacher: review an unfinished attempt (D-1, B)

- **`buildResults` gains `include_in_progress`**; the results matrix and
  the per-student page pass it, the CSV, print report and review queue do
  not (they stay submitted-only — an unfinished attempt is not a result).
- **Matrix**: an in-progress row shows the student, section, "Not handed
  in — k of N answered", the cells as today's `no_response` / unscored
  shapes with no totals, and a **Hand in** action beside Results (enabled
  by the same rule as Delete).
- **Per-student page**: opens for an in-progress attempt (no more 404),
  with a "Not handed in" badge, `started_at`, the answered count, every
  saved answer rendered through `describeAnswer` exactly as for a submitted
  attempt, no score column, the integrity timeline (which now includes
  `time_expired`), and the **Hand in for this student** control next to
  Delete.
- **Monitor**: the Actions column gains **Hand in** beside Delete on
  in-progress rows, same enable rule.

### Teacher: force a submission (D-1, A)

- **`POST /api/attempts/[attemptId]/hand-in`** — owner-only; the attempt
  must be `in_progress`; **409 `session_open`** while the attempt's sitting
  is open and unexpired AND the attempt's deadline (if any) has not passed
  — the same "the student may be locked in and mid-answer" rule Delete
  uses, relaxed once time is up. Sets `status = 'submitted'`,
  `submitted_at = now`, **`submitted_by_sub`** (new nullable column: null =
  the student, a staff sub = handed in by the teacher), inserts an
  `attempt_events` row `teacher_hand_in`, then runs the shared auto-scoring
  (`lib/scoring/runAutoScoring.ts`) exactly as the student's own submit
  does. Idempotent: a second call on a submitted attempt answers 409
  `already_submitted`.
- **Results surfaces** show "Handed in by teacher" beside `submitted_at`
  on the matrix, the per-student page and the print report; the CSV keeps
  its header (D-R2) — no new column.
- **Migration 0034**: `attempts.submitted_by_sub text`, and the
  `attempt_events` kind CHECK widened with `time_expired` and
  `teacher_hand_in`.

### Confirm dialog copy

"Hand in for <student>? Their k answered questions become their final
answers and auto-scoring runs. They will not be able to change them." —
Hand in / Cancel. On 409 `session_open`: "Close the test session first."

## Slices

| # | What | Size / agent |
|---|---|---|
| 0 | This note; roadmap row | docs |
| 1 | Server: migration 0034; `time_limit_ends_at` + `server_now` on the delivery bundle (shared schema, additive); 409 `time_expired` on responses / upload completion / student submit after deadline + grace; `POST …/hand-in` (guards, `submitted_by_sub`, event, auto-score); `buildResults` `include_in_progress`; tests for every guard | M — Opus 5 / medium |
| 2 | Client: banner countdown (dismissable, danger colour under 1 min), 5-/1-minute notices via `PeekNotice`, session end at zero with reason `time_expired` + event + the "Time is up" sheet; clock offset from `server_now`; Swift tests on the pure countdown model (manual scheduler as the lockdown tests do); JSC test for the banner markup | M — Opus 5 / medium |
| 3 | Teacher UI: matrix in-progress rows + Hand in; per-student page for in-progress attempts + Hand in control; Monitor Hand in; "Handed in by teacher" labels; `HandInAttemptControl` beside `DeleteAttemptControl`; tests (reporting-views) | S — Sonnet 5 / medium |
| 4 | Rows: teacher rows (hand-in guards, in-progress review, labels) + client rows (banner, notices, zero, resume keeps the deadline, 409 after time) in the two check files; deploy + `migrate-aurora.sh` 0034; the client change ships in v1.3.0 | rows — Sonnet 5 |

Order 0 → 1 → (2 ∥ 3) → 4. Slice 2 depends on slice 1's bundle field
(the shared schema package builds to `dist` first).

## Decisions

- **D-1** Both: teachers can review an in-progress attempt AND force its
  submission. — James, 2026-09-11
- **D-2** The time limit is enforced by the client by ending the secure
  session at zero — it does NOT hand in; the attempt stays in progress for
  the teacher. — James, 2026-09-11
- **D-3** A small, dismissable banner bar carries the countdown;
  unobtrusive notices at 5 and 1 minute remaining. — James, 2026-09-11
- **D-4** The server refuses answers and student submits after the
  deadline plus a 30-second grace (409 `time_expired`), so the limit holds
  without trusting the client. — recommendation, taken with D-2

## Progress

- **Slice 0 — 2026-09-11, `90731f0`.** This note; roadmap row T.
- **Slice 1 — 2026-09-11.** **Migration 0034** (`attempts.submitted_by_sub`,
  kinds `time_expired` + `teacher_hand_in`; applied to dev + test);
  `lib/api/attemptDeadline.ts` (`deadlineFor`, `isPastDeadline` with the
  30 s grace, `refuseIfPastDeadline`) used by the delivery bundle
  (`time_limit_ends_at` + `server_now`, both or neither, so limit-less
  bundles are byte-identical), the responses POST **and DELETE**, the
  upload completion and the student submit (409 `time_expired`);
  `POST /api/attempts/[attemptId]/hand-in` (owner-only via the new
  `lib/api/staffAttempt.ts` shared with Delete; 409 `already_submitted`;
  409 `session_open` on `status = open` alone — an expired-but-open sitting
  still accepts writes, so it stays protective — relaxed once the deadline
  passed; `submitted_by_sub`, `teacher_hand_in` event, auto-scoring pass);
  `teacher_hand_in` is NOT client-postable (`CLIENT_ATTEMPT_EVENT_KINDS`);
  `buildResults(…, { include_in_progress })` rows carry `status`,
  `submitted_by_sub`, `answered_count`, null totals in progress; timeline /
  print labels for both kinds. Design-tool 1562 (+29), schema 123 (+2),
  typecheck clean.
- **Slice 2 — 2026-09-11** (client, built ∥ slice 3). `DeliveryBundle`
  decodes the two instants and `deadline(receivedAt:)` = receipt +
  (`ends_at` − `server_now`), so a skewed Mac counts the right seconds;
  `TimeLimitCountdown` (pure, injectable scheduler, reads the clock every
  tick so a sleeping Mac loses the time it slept; `mm:ss` / `h:mm:ss`
  rounded up; notices once each incl. the late-start case; danger under
  60 s; expiry once; dismiss suppresses only the tick); the renderer's
  `.time-limit` strip (tokens only, first child of `#items` so it survives
  page turns, `window.__timeLimit.update`, × on a new `timer` channel,
  `aria-live="off"` — the notices are the announced channel); the view
  controller shows the notices through the peek strip in Ochre with an 8 s
  auto-dismiss (peek disclosures unchanged); at zero `AppDelegate` reports
  `time_expired`, ends the lockdown with that reason and shows "Time is
  up. / Your answers are saved." with one button; post-deadline 409s are
  logged, not raised. `swift test` 587 (+19), `xcodebuild` green. Ships in
  the next client release.
- **Slice 3 — 2026-09-11** (teacher UI). `HandInAttemptControl` (mirrors
  Delete; `handInConfirmCopy`; `attemptHandInErrorCopy` 409 texts) +
  `HandInAttemptAndReload`; `ResultsRow.sitting_open`; the matrix passes
  `include_in_progress` — in-progress rows read "Not handed in — k of N
  answered" in the Scoring column with the Hand in control (there is no
  separate Results column; the name is the link), no totals, the Complete
  verdict and analytics stay submitted-only; the per-student page renders
  an in-progress attempt (badge, started time, answered count, every saved
  answer, no score section) with Hand in beside Delete, both disabled
  while the sitting is open; Monitor gains Hand in on in-progress rows;
  print and the pages say "Handed in by teacher". Enable rule = sitting
  open only (the deadline relaxation surfaces as the 409 text). Design-tool
  1572 (+10), typecheck clean.
