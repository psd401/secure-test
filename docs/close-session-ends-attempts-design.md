# Close session ends every attempt — design note (scoped 2026-09-15, for a fresh session)

**Status:** BUILT 2026-09-15, all three slices (see §Progress); server half awaits deploy + `migrate-aurora.sh` (0036), client half awaits the v1.3.3 release. Needed before the
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
- **D-3 No grace** — as scoped. **Amended 2026-09-16 (James):** the WRITE
  guards (response PUT / DELETE, both upload halves) accept for **10 s**
  after the close or expiry instant (`SITTING_CLOSE_GRACE_SECONDS`); the
  peek poll reports `closed` at once and the student's own submit gets no
  grace, so nothing about the close is delayed. Reason: the 2026-09-16
  real-session run showed the client's own flush of the focused essay
  (sent after the poll said closed, on the way home) refused — the last
  words lost for no gain. Ten seconds covers the 5 s poll plus the post.
  Outside that window, or with the Mac asleep, the words are still lost;
  the client-side answer (essay autosave while typing + a deferred spool
  entry retried on Resume) is queued for v1.3.4, post-pilot.
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

## Open questions (resolved at build time, 2026-09-15)

- "Hand in everyone now" — BUILT 2026-09-16 as its own button beside Close
  (not on the Close dialog), per sitting: `POST
  /api/test-sessions/[sessionId]/hand-in-all` + `HandInAllControl`
  (`4b05479`, `1562ae4`; rows 206–214 in `docs/design-tool-manual-checks.md`).
- The `sitting_closed` attempt event is CLIENT-written (matches
  `lockdown_end`); the close route writes no event.

## Progress

- 2026-09-15: scoped (this note). D-1…D-7 decided by James the same day: end the sitting, not the attempt (no hand-in, attempt stays in_progress and resumable); expiry counts; no grace. Hold on v1.3.3 LIFTED: the client half ships in v1.3.3 today, since nothing server-side can end a v1.3.2 client's session. Nothing built yet.
- 2026-09-15: **slice 1 (server) BUILT.** `lib/api/sittingOver.ts` (`sittingIsOver` / `attemptSittingIsOver` / `refuseIfSittingOver`, no grace) guards the response write (PUT + DELETE), both drawing-upload halves (the slot mint as well as the completion — a slot that can never settle is worse than a refusal) and the student's own submit, placed after `attemptAcceptsWrites` and BEFORE the deadline so a closed sitting says `sitting_closed` even when time also ran out; the teacher's hand-in route is untouched. `GET …/peek/pending` gains `sitting: "open" | "closed"` (D-5; an attempt with no `test_session_id` — the `--token` posture, the seeder — reads "open" and is never refused). `POST …/close` keeps its semantics and idempotency and adds `in_progress: n`. New attempt-event kind **`sitting_closed`** (client-postable, labelled "Session closed by the teacher — returned to Your tests" in `attendanceView.eventLabel`, hence also the timeline, plus `printIntegrity`), **migration 0036** (drop + re-add `attempt_events_kind_check`), applied to dev and test. Close dialog copy (D-6) via the pure `closeDialogCopy(n)` / `countInProgress(rows)` in `attendanceView.ts`, used by both the Monitor (which always holds rows) and SittingsPanel (which holds rows only for a sitting whose Attendance has been expanded — it falls back to the old wording otherwise). `attemptAcceptsWrites`'s doc comment now points here instead of arguing the opposite. Tests: design-tool **1855** (from 1825) — `test/sitting-over.test.ts` (pure) + `test/sitting-closed.test.ts` (open sitting untouched; closed and expired × response / withdrawal / both upload halves / submit; no grace at one second past expiry; sitting-before-deadline ordering both ways; no-sitting attempt untouched; peek open→closed; close route count + idempotency + attempt untouched; teacher hand-in after a close; the new event kind accepted); typecheck clean. Teacher rows **195–200** in `docs/design-tool-manual-checks.md`, NOT RUN. Not deployed yet.
- 2026-09-15: **slice 2 (client) BUILT** — `PeekPoll` carries `sitting` (absent or unrecognised = open; `PeekResponder.onSittingClosed` fires once per attempt and stops the poll), `APIError.isSittingClosed`, `ResponseSpool.FlushResult.sittingClosed` (the 409 is dropped as permanent as before, now flagged), the new `sitting_closed` attempt-event kind in the retried set, `AssessmentViewController.onSittingClosed` from the flush / drawing-upload / submit paths with the `responses_dropped` error suppressed, and `AppDelegate.sittingClosedDuringAttempt(via:)` reusing security slice 1's return-home path with the D-4 sheet ("Your teacher ended the test session." / "Your answers are saved."), idempotent against the time-limit, hand-in and quit ends. `MARKETING_VERSION` 1.3.3. Core 645 tests (was 635), Debug + Release `xcodebuild` green. 11 rows in `client/MANUAL-CHECKS.md` "Close session ends the sitting (row CS, 2026-09-15)" — NOT RUN.
- 2026-09-15: **slice 3 (docs) DONE.** `docs/pilot-quick-start.md` "Three clocks" rewritten (Close and expiry return students to Your tests with answers saved; the Close dialog names the count; Hand in finalises; Resume in a later session; a v1.3.2 fallback paragraph), the Teacher step 6 / Student step 7 / "looks wrong" bullets updated, page header now says v1.3.3; time-limit note §Progress and roadmap row CS point here. Reviewed in the main session: the zero-count / count-unknown Close dialog copy was corrected (it still said "students already in can finish and hand in", no longer true). Both halves re-checked in the main session before commit. Next: deploy + `migrate-aurora.sh` (0036), then psd-sign v1.3.3 + `gh release create` (James) + the IT AutoPkg ask; rows 195–200 + the 11 client rows on the day.
- 2026-09-15 evening: **sitting on the origin (rev 34) with the Debug build under simulated lockdown** — James at the client, Claude in Chrome: Close → `sitting_closed {via: peek}` 0.4 s later → sheet → Your tests; 2-minute expiry → same via the next poll; Resume in a new session restored everything; timeline label renders. Rows 195 / 196 / 198 / 199 ✅, six client rows ✅; 197 / real-session / hand-in / Cmd-Q / D-7 rows open — the student device (v1.3.1) gets the v1.3.3 pkg by hand for the real-session pass. Finding M-1 (roadmap): `$6 \times 7$` renders raw under rule C-2.
- 2026-09-16: **real session on the released v1.3.3** (student device, via Jamf): Close → `sitting_closed` 0.4 s → `lockdown_end` 3 s → sheet; row 197 ✅. The focused essay's flush was refused → **D-3 amended: 10 s write grace** built the same day (server only; `sittingIsOver(…, graceSeconds)`, submit passes 0, poll unchanged; `overSitting` / closed scenarios in the tests stamp `updated_at` a minute back). v1.3.4 (post-pilot): essay autosave while typing + spool keeps a `sitting_closed` write for the next Resume.
