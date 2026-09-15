# Close session ends every attempt — design note (scoped 2026-09-15, for a fresh session)

**Status:** scoped, nothing built. Needed before the pilot sittings on
2026-09-17 (the pilot teachers' first feedback). Server half is a
design-tool deploy; client half is **v1.3.3** (bundled with the client
hygiene slice already on `main`) and reaches the fleet only through IT's
AutoPkg runs — see §Timing.

## Problem

Today three clocks govern a sitting (`docs/pilot-quick-start.md` "Three
clocks"), and only the per-attempt time limit ends a student who is already
working:

- `assessments.time_limit_seconds` → per-attempt deadline
  (`lib/api/attemptDeadline.ts`: `started_at + limit`, 30 s grace). The
  client ends the secure session at zero (D-2 of the time-limit note); the
  server refuses writes and student submits after the grace (D-4).
- `test_sessions.expires_at` ("How long") and `POST …/close` govern only
  who may **start or resume** (`lib/api/mySittings.ts` lists open +
  unexpired; the join route resumes through a sitting). An in-progress
  attempt keeps accepting writes; nothing tells the client the session
  closed.

Teachers expect **Close session** (and, they will assume, the session
running out) to end the test for everyone. The quick-start documents the
current behaviour as a "looks wrong but isn't"; this note replaces it.

## Decisions to make (recommendation first)

- **D-1 What Close does to in-progress attempts.** Recommend: hand them in
  as they stand through the existing teacher hand-in path — `status =
  submitted`, `submitted_at = now`, `submitted_by_sub` = the teacher, one
  `teacher_hand_in` attempt event per attempt (exactly what
  `POST /api/attempts/[id]/hand-in` writes today, `route.ts:82-93`), then
  `runAutoScoring` per attempt. Alternative: a new terminal status
  (`ended_by_teacher`) — rejected: every reader (results, print, corpus,
  delete) would need to learn it, and "handed in by the teacher" is already
  a first-class state the per-student page names.
- **D-2 Does session expiry (`expires_at`) do the same?** Recommend: yes —
  the teacher who picked "This period · 55 min" means the period. No timer
  fires at expiry, so it is enforced **lazily**: the next student write,
  submit, or peek poll against an expired-or-closed sitting hands the
  attempt in (server) and answers `sitting_closed` so the client stops.
  Same 30 s grace as the deadline for an autosave already in flight.
- **D-3 Client behaviour on learning the session is over.** Recommend:
  reuse security slice 1's return-home path (`ebe20ab`): flush the focused
  field and dirty drawings, end the secure session, `showEntry()`, one
  button sheet — "Your teacher ended the test session. Your answers were
  handed in." The attempt is already `submitted` server-side, so the flush
  is best-effort within the grace.
- **D-4 How the client learns.** Recommend: the existing 5-second peek poll
  (`PeekResponder`, `GET /api/attempts/[id]/peek`) gains a `sitting`
  field in its response — `"open" | "closed"` — and the answer-write 409
  `already_submitted` gains `reason: "sitting_closed"`. No new channel, no
  new timer; a closed session reaches a working client within ~5 s. The
  poll already runs only while an attempt is on screen.
- **D-5 Teacher-side copy.** The Close dialog (`SittingsPanel.tsx` ~886)
  says how many are still working: "3 students are still working — their
  tests will be handed in as they stand." Monitor rows flip to Handed in on
  the next poll; the per-student page shows "Handed in by <teacher>" as it
  does for a manual Hand in today.
- **D-6 Interim without the client half.** With only the server half
  deployed, a v1.3.2 student's screen keeps going after Close, but every
  later write is refused (409) and the attempt is final and scored — the
  teacher's view is right, the student's is stale. Acceptable for Thursday
  if v1.3.3 has not reached the fleet; say so in the quick-start.

## Mechanism

**Server (design-tool).**
- `lib/api/sittings/endAttempts.ts` (new): `handInOpenAttempts(db,
  sitting, bySub, reason: "closed" | "expired")` — selects `attempts` where
  `test_session_id = sitting.id AND status = 'in_progress'`, then per
  attempt the same writes as the hand-in route (factor the route's body into
  a shared `teacherHandIn(db, attempt, bySub)` so both call one function),
  then `runAutoScoring`. Returns the count.
- `POST /api/test-sessions/[id]/close`: after `status = closed`, call it;
  return `{ ok, handed_in: n }`.
- Lazy expiry: a shared `refuseIfSittingOver(db, attempt)` beside
  `refuseIfPastDeadline`, used by the response write, submit and peek
  routes: if the attempt's sitting is `closed` or `expires_at + 30 s <
  now`, hand the attempt in (idempotent) and answer 409
  `{ error: "already_submitted", reason: "sitting_closed" }` (peek: 200
  with `sitting: "closed"`). Attempts not bound to a sitting (`--token`
  dev, offline) are untouched.
- Monitor / attendance: nothing new to store — `submitted_by_sub` already
  distinguishes a teacher hand-in.

**Client.**
- `PeekResponder`: decode `sitting`; on `"closed"` call a new
  `onSittingClosed` once. `AssessmentViewController`: on a 409 with
  `reason: "sitting_closed"` call the same. AppDelegate wires it to the
  return-home path with the D-3 copy; a `sitting_closed` attempt event is
  NOT needed (the server wrote `teacher_hand_in`).
- Core tests: decode; the responder fires once; the controller maps the 409.

## Slices

1. **Server** (Opus, one commit): shared `teacherHandIn`, close route hands
   in + returns the count, lazy `refuseIfSittingOver` on write / submit /
   peek, Close dialog count copy. Tests: close with 0 / n in-progress
   attempts; expired sitting's next write hands in and 409s; peek reports
   closed; hand-in route unchanged; time-limit rows still pass. Rows.
   **Deploy Wednesday** (no migration).
2. **Client** (Opus, one commit): poll field + 409 reason → return-home
   sheet. `swift test`, both builds. Rows. **Cut v1.3.3 with the hygiene
   slice**, psd-sign, `gh release create` (James).
3. **Docs**: quick-start "Three clocks" rewritten (Close and expiry now end
   tests; Hand in remains for one student), time-limit note §Progress,
   roadmap row, this note §Progress.

## Timing

- Server half can be live Wednesday morning with a day of soak.
- Client half: v1.3.2 published 11:24 PT Tuesday had not reached James's
  student Mac by 14:30 PT; IT's recipe runs "a few times a day" and never
  over a running app. Cut v1.3.3 Tuesday evening or Wednesday first thing
  and ask IT for an extra run; if it is not on the fleet by Thursday, D-6
  applies.

## Rows (to write in slice 1 / 2)

Teacher: close with a student mid-essay → Monitor row Handed in within a
poll, per-student page "Handed in by …", the essay text as it stood; close
dialog names the count; results matrix final; a second Close is a no-op.
Client (v1.3.3, real session): the student's Mac ends the session within
~5 s of Close with the D-3 sheet; a student who was typing loses at most
the unflushed sentence; an expired session's next keystroke ends the same
way; a v1.3.2 client against the new server keeps its screen but every
write is refused (D-6, observe the 409s on stderr).

## Open questions for James (fresh session)

- D-1 reuse hand-in vs. new status — confirm reuse.
- D-2 expiry ends attempts too — confirm.
- Grace after Close: 30 s (matches the deadline) or 0?
- Cut v1.3.3 tonight or Wednesday?

## Progress

- 2026-09-15: scoped (this note). Nothing built.
