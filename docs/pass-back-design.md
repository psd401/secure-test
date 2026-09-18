# Pass back a handed-in attempt (roadmap U-7)

Design note, 2026-09-18. Roadmap `docs/roadmap-2026-09.md` §"Unscoped" row
**U-7** (pilot teachers, 2026-09-17: "pass back" an assignment so a student
can keep working — handed in → in progress). James decided the same day:
**existing scores are KEPT as a record.** Decisions marked **D-n** are
James's and are listed at the end; **§Progress says what is built**
(nothing yet).

## What exists that this stands on

- **`submitted` is terminal.** `attempts.status` flips to `submitted` on
  the student's submit or the teacher's Hand in (`submitted_at`,
  `submitted_by_sub`); nothing flips it back. The only exit is Delete
  attempt, which loses the work.
- **The client needs nothing.** `JoinOutcome` refuses a join only when the
  attempt's status is `submitted` (`client/…/JoinOutcome.swift`); an
  in-progress attempt is opened and rebound to the sitting being joined
  (`rebindIfMoved`), and the delivery bundle prefills every saved answer
  (P-1, `saved_responses` / `saved_uploads`, drawings inline). So an
  attempt put back to `in_progress` simply opens on the next join, with
  the student's answers in place. **Design tool only.** (The H-1 "earlier
  session" refusal is keyed on the same status and stops firing too.)
- **Answers are edited in place.** The response PUT is an upsert on
  `(attempt_id, item_id)`; a passed-back student who changes an answer
  overwrites the handed-in one. There is no answer history.
- **Scores hang off responses, one `final` per response** (partial unique
  index `scores_one_final_per_response_unq`; statuses `proposed | final |
  research`). `runAutoScoringPass` SKIPS every response that already has
  a `final` — so without a status change, a re-hand-in would keep the OLD
  score on a CHANGED answer. Results, the print report and the work packet
  read `status = 'final'` only.
- **The time limit is per attempt**: `started_at + time_limit_seconds`, or
  `deadline_override_at` when set (Extend time, 2026-09-17). A passed-back
  attempt on a timed assessment is past its deadline the moment it is
  passed back; every write would be refused with 409 `time_expired`.
- **Audit**: `attempt_events` has staff-only kinds (`teacher_hand_in`,
  `deadline_extended` with `detail.by`); the integrity timeline and the
  print report list them.
- **Monitor / attendance** already understands an in-progress attempt on a
  closed sitting (rows CS, T) and "Handed in (earlier session)" (H-1).

## Design

### The operation (D-1, D-2)

`POST /api/attempts/[attemptId]/pass-back` — staff, `edit` on the
assessment (`authorizeAttempt(…, "edit")`: the owner or a co-teacher; a
substitute's `run` does not reach it). Body `{ ends_at?: ISO }`.

1. Refuse 409 `not_submitted` unless `status === "submitted"`.
2. Every `final` score on the attempt's responses → `status = 'superseded'`
   (new fourth status; the partial unique index frees the slot; nothing
   that reads `final` sees them; the corpus's `research` rows untouched).
   `proposed` AI rows stay `proposed` — a proposal on the old answer is
   still a proposal, and the teacher re-runs "Score with AI" if the answer
   changed. **D-2: keep as a record = superseded, visible on the
   per-student page under "Earlier scores (before pass back)".**
3. `attempts`: `status = 'in_progress'`, `submitted_at = null`,
   `submitted_by_sub = null`, `pass_back_count += 1` (new column, default
   0), `updated_at`.
4. Time limit: if the assessment has a limit OR the attempt carries an
   override, `deadline_override_at = ends_at` — REQUIRED in that case
   (400 `ends_at_required`), because the old deadline is already past. The
   teacher's dialog defaults it to tomorrow 23:59 like Extend time. On an
   unlimited assessment `ends_at` is ignored.
5. `attempt_events` kind `passed_back`, `detail = { by, previously_submitted_at,
   superseded_scores: n, ends_at }`. Staff-only (the client schema refuses
   it).
6. Returns `{ ok, attempt_id, status, deadline_override_at, superseded_scores }`.

Idempotent in effect: a second press is a 409 `not_submitted`.

### What the student sees

Nothing until they join a sitting: the teacher starts (or reuses an open)
session, the student picks the test, the attempt opens with every answer
prefilled and the new countdown if timed. They change what they need and
hand in again; auto-scoring runs on every response (no `final` blocks it
now) and the teacher's queue fills with the new answers. **No client
change; no release.** The student is never told "this was passed back" —
the teacher tells them (D-3 says whether the entry row should).

### Teacher UI (D-4)

- **Pass back** on the per-student results page beside Hand in / Delete
  (visible only while `submitted`), and on each Monitor row whose status
  is `submitted` / `submitted_earlier`. A small dialog: "Pass back to
  <student>? Their answers stay; they can change them and hand in again.
  Their k scores are kept as a record and the test is scored again on the
  next hand-in." + the deadline picker when timed → Pass back / Cancel.
- The per-student page shows "Passed back <when> by teacher" in the
  timeline and the superseded scores in a collapsed "Earlier scores"
  section; the matrix marks the row in progress again (T's review of an
  in-progress attempt already covers it).
- Hand-in-all and H-1 are unchanged: a passed-back attempt is in progress
  and hands in like any other.

### Not in this note

- Answer history (the handed-in answer text before the change) — the
  superseded score row carries the points, not the answer. If a teacher
  needs the old essay, that is a `response_versions` table; not built.
- Passing back to a DIFFERENT student, or re-opening for a retake with a
  blank sheet — that is Delete attempt + a new join.
- The client's copy on the entry row ("Handed in ✓" today) — the
  assessment simply reappears as open; a "Passed back" hint would be a
  client change and waits for a release (D-3).

## Slices

| # | Slice | Size / model |
|---|---|---|
| 0 | This note; D-1…D-4 | — |
| 1 | Server: **migration 0039** (`scores.status` CHECK gains `superseded`; `attempts.pass_back_count`; `attempt_events` kind `passed_back`), `lib/api/passBackAttempt.ts`, the route, timeline / print-integrity labels, results + packet + print summary proven blind to `superseded`, tests | S–M — Opus 5 / medium |
| 2 | Teacher UI: `PassBackControl` (dialog + deadline picker reusing Extend time's helpers) on the per-student page + Monitor rows, "Earlier scores" section, error copy; rows | S — Sonnet 5 / medium |
| 3 | One deploy + `migrate-aurora.sh`; rows run with a demo student (hand in → pass back → rejoin → change → hand in → new scores; timed variant) | — |

## Decisions (James)

- **D-1** Pass back = the status flip + superseded scores + a required new
  deadline when timed, one route, `edit`-level (owner or co-teacher). —
  **DECIDED as recommended (James, 2026-09-18)**
- **D-2** "Keep scores as a record" = a fourth score status `superseded`,
  shown on the per-student page, invisible to results / print / packet /
  CSV. — **DECIDED as recommended (James, 2026-09-18)** (James 2026-09-17: keep as a record)
- **D-3** No client change: the student's entry row shows the test open
  again with no "passed back" hint until a later release. — **DECIDED as recommended (James, 2026-09-18)**
- **D-4** Placement: per-student page + Monitor rows, not the results
  matrix. — **DECIDED as recommended (James, 2026-09-18)**

## Progress

- 2026-09-18 — note written; D-1…D-4 decided the same day.
- 2026-09-18 — **slice 1 (server) BUILT, not deployed.** **Migration 0039**
  (`db/migrations/0039_pass_back.sql`): `scores.status` CHECK +
  `SCORE_STATUSES` gain `superseded`, `attempts.pass_back_count integer not
  null default 0`, `attempt_events` kind CHECK + `ATTEMPT_EVENT_KINDS` +
  `STAFF_ONLY_ATTEMPT_EVENT_KINDS` gain `passed_back`; applied to dev and test,
  **Aurora needs `migrate-aurora.sh` after the deploy**.
  `lib/api/passBackAttempt.ts` is the write (one transaction: finals →
  `superseded` and counted, status flip, `submitted_at` / `submitted_by_sub`
  nulled, `pass_back_count + 1`, the override only when an instant is given so
  an earlier extension is never erased, the `passed_back` event with its
  detail); `POST /api/attempts/[attemptId]/pass-back` owns the refusals —
  `edit` through `authorizeAttempt` (404), 409 `not_submitted`, and on a timed
  assessment (a limit OR an override already on the attempt) 400
  `ends_at_required` / `ends_at_past`, with an unlimited assessment ignoring
  `ends_at` rather than gaining a deadline. An open sitting is deliberately not
  a refusal. Labels: `attendanceView`'s `eventLabel`, `timeline.ts` ("Passed
  back by teacher 2:07 PM · new deadline 3:00 PM") and `printIntegrity.ts`
  (phrase + a `KIND_ORDER` slot after the hand-ins).
  `lib/scoring/supersededScores.ts` `listSupersededScores` is slice 2's reader
  — **no supersession instant exists** (`scores` carries `created_at` only, no
  `updated_at`), so the row's `created_at` is when the score was GIVEN; the
  instant it was set aside is on the `passed_back` event.
  **One reader was NOT blind and was fixed:** `selectPacketScores` skipped
  `research` but would have picked a superseded AI final as its "latest `ai`
  row, whatever its status" and headed it "AI proposal"; it now skips
  `superseded` too. Results / CSV / print summary / review queue /
  `runAutoScoringPass` needed no change (they key on `final`) and each now has
  a test proving it. Tests: `test/attempt-pass-back-api.test.ts` (19) and
  `test/superseded-scores.test.ts` (6), plus rows in the timeline, print-helper
  and attempt-events suites; design-tool 2065 pass, typecheck clean. Both
  enforcement sweeps (`test/access-enforcement.test.ts`,
  `test/auth-role-enforcement.test.ts`) enumerate routes from disk, so the new
  route is covered without a registration edit. Slice 2 (teacher UI) next.
