# Close session ends every attempt — design note (scoped 2026-09-15, for a fresh session)

**Status:** scoped and decided (D-1…D-7), nothing built. Needed before the
pilot sittings on 2026-09-17 (the pilot teachers' first feedback). Server
half is a design-tool deploy; client half sits on `main` for **v1.3.3**,
which James is holding — see §Timing.

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

## Decisions (James, 2026-09-15)

- **D-1 What Close does to a student who is still working: it ends their
  SITTING, not their attempt.** Handing in is the wrong status — a teacher
  may want a student to work on a task across several sessions. The attempt
  stays `in_progress`; the server refuses every further write from it while
  its sitting is closed or expired; the student is returned to Your tests
  and can **Resume** when the teacher opens another session (the join route
  already rebinds an in-progress attempt to a new sitting, finding 8.2).
  Finalising remains the teacher's: **Hand in** on the Monitor / results
  row (enabled once the session is closed — T-2), or the student's own
  Finish in a later session.
- **D-2 Session expiry (`expires_at`) does exactly the same.** "This
  period · 55 min" means the period. Enforced lazily — no timer fires at
  expiry; the next write, submit or peek poll from an attempt whose sitting
  is closed or expired is refused / answers `sitting_closed`.
- **D-3 No grace.** A write that arrives after Close or expiry is refused
  outright (the deadline's 30 s grace does not apply here). Consequence: an
  autosave in flight at the moment of Close can be lost — the last field the
  student was typing in. Accepted.
- **D-4 Client behaviour.** Reuse security slice 1's return-home path
  (`ebe20ab`): flush (best-effort — it will be refused if it lands after the
  close), end the secure session, `showEntry()`, one-button sheet — "Your
  teacher ended the test session. Your answers are saved." The Your tests
  list then shows the test again with **Resume** only while some open
  session admits the student.
- **D-5 How the client learns.** The existing 5-second peek poll
  (`PeekResponder`, `GET /api/attempts/[id]/peek`) gains `sitting: "open" |
  "closed"`; the answer-write and submit routes answer 409
  `{ error: "sitting_closed" }`. No new channel, no new timer; a closed
  session reaches a working client within ~5 s.
- **D-6 Teacher-side copy.** Close dialog: "N students are still working —
  they will be returned to Your tests with their answers saved. Hand in
  their work from the Monitor when you are ready, or open another session
  for them to continue." Monitor rows stay In progress with Hand in enabled;
  nothing changes on the per-student page.
- **D-7 Interim without the client half.** Server half alone: a v1.3.2
  student's screen keeps going after Close but every write is refused
  (409 `sitting_closed`, spooled then dropped as `responses_dropped`); the
  teacher's view is right and Hand in works. **Superseded the same day:**
  no server-side lever can end a v1.3.2 client's session (the time limit is
  a client clock read once from the bundle; a write 409 is logged and the
  page continues; the peek poll carries only the look flag), so James
  decided to **ship the client half in v1.3.3 today** (2026-09-15, with
  the hygiene slice) and ask IT for an AutoPkg run Wednesday afternoon and
  one before first period Thursday. Fallbacks written into the quick-start
  for any Mac still on 1.3.2: the 55-minute per-student limit ends the
  client session on its own; teachers announce "Finish and hand in" before
  Close.

## Mechanism

**Server (design-tool).**
- `lib/api/sittingOver.ts` (new): `sittingIsOver(sitting, now)` = `status
  !== "open" || expires_at <= now`; `refuseIfSittingOver(db, attempt)` —
  loads the attempt's `test_session_id` row (attempts with no sitting: the
  `--token` dev posture and offline are untouched) and returns the 409
  response `{ ok: false, error: "sitting_closed" }` or null. Used by the
  response write (`attempts/[id]/responses/[itemId]` PUT + DELETE), the
  drawing upload slot, and `submit`. Order: after `attemptAcceptsWrites`,
  before `refuseIfPastDeadline`.
- `GET /api/attempts/[id]/peek`: response gains `sitting: "open" |
  "closed"` (computed the same way; unchanged otherwise).
- `POST /api/test-sessions/[id]/close`: unchanged semantics; returns
  `{ ok, in_progress: n }` so the dialog can say the count (the dialog reads
  the count from the attendance rows it already has BEFORE confirming).
- No status change, no event write on the server: the client reports its
  own `lockdown_end` as today; a `sitting_closed` attempt event is written
  by the CLIENT (new kind) so the per-student timeline explains the exit.
- Results / Monitor: nothing new to store.

**Client.**
- `PeekResponder`: decode `sitting`; on `"closed"` fire `onSittingClosed`
  once per attempt. `AssessmentViewController`: a 409 `sitting_closed` on
  any write fires the same. AppDelegate: report `sitting_closed`, then the
  D-4 return-home path. Core tests: decode, fires once, 409 mapping, the
  event kind.
- `DeliveryBundle` / schema: the new attempt-event kind `sitting_closed`
  in the shared enum (packages/schema) + migration if the kind is a CHECK.

## Slices

1. **Server** (Opus, one commit): `sittingOver`, the three guarded routes,
   the peek field, the close route's count, the Close dialog copy, the new
   event kind (schema + migration if needed). Tests: open sitting passes;
   closed → 409 on write / upload / submit; expired → same; peek reports
   closed; time-limit rows unaffected; hand-in unchanged; a `--token`
   attempt with no sitting unaffected. Rows. **Deploy Wednesday.**
2. **Client** (Opus, one commit): poll field + 409 → return-home sheet +
   `sitting_closed` event. `swift test`, both builds. Rows. **Then cut
   v1.3.3 (MARKETING_VERSION bump, psd-sign, `gh release create` James)
   the same day and ask IT for the extra AutoPkg runs.**
3. **Docs**: quick-start "Three clocks" rewritten (Close and expiry return
   students to Your tests with answers saved; Hand in finalises; Resume in
   a later session), time-limit note §Progress, roadmap row CS, this note.

## Timing

- Both halves built 2026-09-15 (fresh session, same day); server deployed
  the same evening or Wednesday morning; v1.3.3 published 2026-09-15
  evening; IT asked for AutoPkg runs Wednesday afternoon + Thursday before
  first period. D-7's fallbacks cover any Mac the runs miss.

## Rows (to write in slice 1 / 2)

Teacher: close with a student mid-essay → the row stays In progress with
Hand in enabled; the dialog named the count; Hand in then finalises the
essay as it stood; open a NEW session for the same section → the student
sees Resume and continues with their text intact; a second Close is a
no-op. Client (v1.3.3, real session): the student's Mac ends the session
within ~5 s of Close with the D-4 sheet and a `sitting_closed` event on
the timeline; a student who was typing loses at most the unflushed field;
an expired session's next keystroke ends the same way; a v1.3.2 client
against the new server keeps its screen but every write is refused (D-7,
the 409s on stderr).

## Open questions for James (fresh session)

- Should a closed session's Close dialog offer "Hand in everyone now" as a
  second button (one click instead of a row at a time)? Not required for
  Thursday.
- The `sitting_closed` attempt event: client-written (recommended, matches
  `lockdown_end`) or server-written at Close?

## Progress

- 2026-09-15: scoped (this note). D-1…D-7 decided by James the same day: end the sitting, not the attempt (no hand-in, attempt stays in_progress and resumable); expiry counts; no grace. Hold on v1.3.3 LIFTED: the client half ships in v1.3.3 today, since nothing server-side can end a v1.3.2 client's session. Nothing built yet.
