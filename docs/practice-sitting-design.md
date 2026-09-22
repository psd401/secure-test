# Practice sittings — "assign to self" (roadmap U-4)

Design note, 2026-09-22. Roadmap `docs/roadmap-2026-09.md` §"Unscoped" row
**U-4** (James, 2026-09-17: teacher self-assign for practice; decided the
same day: in the client app itself, practice attempts excluded from results).
James's framing 2026-09-22: **a staff member assigns a session to themselves
and sits it on their own Mac, in as close to the real environment as
possible** — the client is the only preview that cannot drift from what
students see, so the editor's web Preview stays a sketch and this becomes
the authentic one. Decisions marked **D-n** are James's and are listed at
the end; **§Progress says what is built** (nothing yet).

## What exists that this stands on

- **Two roles, from the email domain.** `roleForEmail` gives `staff` for
  `psd401.net` and `student` for the student domain (ADR 0017,
  `lib/auth/roles.ts`). Every student-side route is gated by
  `requireStudent()` — `GET /api/me/sittings`, `POST /api/test-sessions/
  redeem`, `POST /api/attempts`, `GET /api/assessments/[id]/delivery`, and
  the eight per-attempt routes (responses, uploads, submit, peek, events,
  client-errors). A staff session on any of them is 403 today.
- **Student identity is the roster.** `resolveStudentForOwner` finds the
  active roster row by email, checks the sitting's scope
  (`isAdmittedToSitting`: an explicit `student_ps_ids` list, else the
  owner's sections narrowed by `section_ps_id`), then finds or binds the
  per-teacher overlay row in `students` (`owner_sub` + `roster_ps_id`).
  `attempts.student_id` is NOT NULL and references `students.id`; attempts
  are unique per `(assessment_id, student_id)`. A staff account has no
  roster row, so every step above says `not_on_roster`.
- **Per-attempt ownership is one seam.** `loadOwnAttempt` (`lib/api/
  studentAttempt.ts`) resolves the caller to an overlay row and compares it
  with `attempts.student_id`; every per-attempt student route goes through
  it. `listMySittings` builds "Your tests" from the roster row the same
  way.
- **The client does not care about the role.** It logs `role` from the
  session JWT and nothing else; "Your tests" renders whatever
  `/api/me/sittings` returns (`MySittings.swift`: scope `sections |
  section | students` with a label each), a join is `POST /api/attempts`,
  and `JoinOutcome` refuses only a `submitted` attempt (H-1).
- **Release always locks.** Security slice 2 (2026-09-15): the notarized
  build ignores the simulate knob and refuses to run without the AAC
  entitlement. Any Mac with the app, the profile and macOS 26.4+ can run a
  real session — no MDM is required for AAC itself.
- **Sittings carry an owner.** `test_sessions.owner_sub` / `owner_email`
  (a co-teacher's sitting is under their own sub — access note D-5),
  `created_by_sub`, `status` (`open | closed`, CHECK), `expires_at`,
  `section_ps_id`, `student_ps_ids`, `archived_at`. Creation needs `run`
  on the assessment.
- **Readers of attempts.** Results matrix + CSV (`lib/scoring/results.ts`
  `buildResults`), review queue, per-student page, print report + summary,
  work packet, analytics, hand-in-all, the Monitor (`attendanceForSitting`),
  the scoring corpus, the retention sweep, and the Students page (the
  overlay list) — each would show a practice attempt or its overlay row
  unless told not to.
- **Teacher Macs.** Jamf scope today is the student test fleet; James asked
  IT for the staff-Mac scope on 2026-09-22 (pkg policy + the
  managed-preferences profile). Until it lands, a teacher's Mac runs the
  Release app only with the two values on the command line.

## Design

### The sitting (D-1, D-2)

A **practice sitting** is an ordinary `test_sessions` row with
`kind = 'practice'` and `practice_for_sub = <the staff sub>`, created by
`POST /api/test-sessions` with `{ assessment_id, kind: "practice" }` from
the Test sessions tab ("Practice on my Mac"). `run` level on the assessment,
so the owner and a co-teacher can each practise; `owner_sub` / `owner_email`
follow the creator exactly as a class sitting's do. No section, no
`student_ps_ids`; it gets a code like any sitting (the client's join by
code keeps working), `expires_at` = now + the "How long" choice (default
rest of day). **A practice sitting admits exactly one principal — the sub
it names — and never a student.** `isAdmittedToSitting` returns false for
any roster student on a practice sitting; the practice path never consults
the roster.

Under impersonation the effective sub is the teacher's, but the admin's Mac
signs in as the admin — `practice_for_sub` is written from the session's
effective `sub`, so an act-as practice sitting is only joinable by the
teacher. Acceptable; noted, not special-cased.

### The join path for a staff principal (D-3)

Rather than a parallel API, the existing student routes learn one more way
to resolve "who is this": a **practice principal**.

- `requireStudent()` on the twelve routes becomes `requireStudentOrPractice()`:
  a `student` role passes as today; a `staff` role passes too, carrying a
  marker the resolvers read. Nothing else about the routes changes.
- `resolveStudentForOwner(db, ownerSub, session, sitting)` gains the branch:
  when the session is staff, the sitting (when given) must be `practice`
  with `practice_for_sub === session.sub`, else `not_in_sitting`; the
  overlay row is `findOrCreatePracticeOverlay(ownerSub, session)` — a
  `students` row with `practice_for_sub = session.sub`, `name = "Practice —
  <teacher display name>"`, no roster binding, no SSID. New column
  `students.practice_for_sub` with `unique(owner_sub, practice_for_sub)`,
  so one practice row per (assessment owner, practising teacher). When no
  sitting is given (`loadOwnAttempt`), the staff branch resolves the
  practice overlay under the attempt's assessment owner and the existing
  `student_id` comparison does the rest.
- `POST /api/attempts` sets `attempts.practice = true` (new boolean, default
  false) when the sitting is practice. The flag lives on the attempt because
  `test_session_id` is nullable and rebinds; readers must not have to reach
  the sitting to know.
- `listMySittings` for a staff session returns the open practice sittings
  with `practice_for_sub = session.sub`, scope `"practice"`, plus the
  attempt shape the client already reads. A staff session with none gets an
  empty list and the reason `no_practice_sitting`.
- `redeem` by code: same resolver, so a practice code typed into the client
  works for its teacher and is `session_unavailable` for anyone else.
- The delivery bundle, responses, uploads, submit, peek, events: unchanged
  once `loadOwnAttempt` resolves the practice overlay. The time limit,
  Extend time, Close, expiry, the peek poll, hand-in and the 409 rules all
  apply — that is the point of practising.

### Invisible everywhere a class result lives (D-4)

Every reader listed above excludes `attempts.practice = true`, and the
Students page and the accommodations import exclude
`students.practice_for_sub IS NOT NULL`. The guarantee is a test, not a
convention: `test/practice-invisibility.test.ts` seeds one assessment with
a class attempt and a scored, handed-in practice attempt, then asserts that
`buildResults`, the CSV, the review queue, the print report, the summary,
the work packet, the analytics footer, hand-in-all, the corpus selection,
`attendanceForSitting` on a CLASS sitting, and the Students list each
return only the class attempt. The per-student page (`/dashboard/[id]/
results/[attemptId]`) is the one reader that DOES show a practice attempt
— reached only from the practice row on the Test sessions tab, so the
teacher can read back their own answers and the integrity timeline.

Auto-scoring runs on a practice hand-in as on any other (the teacher sees
what a student's score would be); the scores are invisible because the
attempt is.

### The Test sessions tab and the Monitor (D-5)

- The tab gains **"Practice on my Mac"** beside Start session: one click
  creates the practice sitting for the rest of the day and shows its row.
  Practice rows sit in the same list, labelled **Practice** where a class
  row shows its section, and carry: Show code, Monitor, Close session, a
  status line ("Not started yet" / "In progress · 3 of 10 answered" /
  "Handed in 9:41 AM · 7 / 10"), **See my answers** (the per-student page)
  and **Practice again** (D-6). No Attendance, Hand in everyone or Extend
  time — one attempt, the teacher's own.
- The Monitor works on a practice sitting with one row, so the teacher can
  also see what the Monitor shows for a student: `attendanceForSitting`
  returns the practice principal as its only expected row (label "You
  (practice)"); View screen, Hand in, Extend time and Delete attempt work.
  A teacher cannot be on the locked Mac and the Monitor at once; a
  colleague or a phone can be.
- The Assessments home's "Open now" strip and `/admin`'s district-wide list
  show practice sittings with the Practice label (an admin should see
  every open lock).

### Practice again and cleanup (D-6, D-7)

- **Practice again** = delete the practice attempt (the existing
  `DELETE /api/attempts/[attemptId]` cascade + storage delete + audit row;
  it is the teacher's own attempt, so the `session_open` refusal is
  relaxed for practice) and the row returns to "Not started yet"; the next
  join creates a fresh attempt. Nothing special on the client: "Your
  tests" lists the sitting with `attempt: null` again.
- **Cleanup**: the nightly retention sweep (`lib/retention/sweep.ts`, D-11)
  deletes practice attempts whose sitting closed or expired more than
  **7 days** earlier, through the same delete path (uploads included), and
  archives the sitting. Practice never accumulates in the account, and
  never reaches the corpus or a family-facing page.

### Lockdown and the client (D-8)

**Lockdown is always on.** A practice sitting is delivered to the same
Release build students run: real `AEAssessmentSession`, fullscreen, the
same exits (Cmd-E, Cmd-Q, the titlebar button), the same sheets. No
"lockdown off" option — the Release posture has no way to skip `begin()`
and should not learn one, and a practice that does not lock would not be
the preview James wants. The one dev affordance stays: a Debug build with
`SECURE_TEST_SIMULATE_LOCKDOWN` practises unlocked, for us.

Client changes (XS, rides the next release):

- `MySittings.Sitting.scope` gains `"practice"` → row label "Practice —
  only you", the teacher line shows the assessment owner as today.
- The empty state for a staff sign-in: "No practice tests right now. Start
  one from your assessment's Test sessions tab." (today a staff sign-in
  reads the student copy for `not_on_roster`).
- `JoinErrorCopy`: `no_practice_sitting` and the practice `not_in_sitting`
  map to "This practice test is for the teacher who started it."
- Nothing else: paging, keypad, drawings, autosave, the countdown, the
  Close sheet and hand-in are exactly the student's.

An older client (v1.3.4) shows a practice sitting with the scope label
missing (unknown scope → the `sections` copy) and otherwise works, so the
server half can deploy ahead of the release.

### Security notes

- A staff principal can reach only practice sittings that name their sub;
  a student can never be admitted to one. Both are asserted in
  `test/access-enforcement.test.ts` style: the practice resolver is tested
  with (staff, class sitting) → `not_in_sitting`, (student, practice
  sitting) → `not_in_sitting`, (staff A, practice sitting for B) →
  `not_in_sitting`.
- The delivery bundle for a practice attempt carries no answer keys, as
  for any attempt (ADR 0016). The teacher knows them; the wire does not.
- Practice attempts are excluded from `client_error` → "Needs attention"
  on CLASS monitors by construction (the attempt is on its own sitting).

## Decisions (James, 2026-09-22)

All eight APPROVED as recommended (James, 2026-09-22 afternoon).

| # | Decision | Recommendation |
|---|---|---|
| D-1 | Where practice lives: a `kind` on `test_sessions` (not a separate table or a preview mode) | `kind = 'practice'` + `practice_for_sub`; `attempts.practice`; `students.practice_for_sub` |
| D-2 | Who can practise | `run` level — owner and co-teachers; a substitute later, by the same level |
| D-3 | Join path: the student routes admit a practice principal (not a parallel API) | Yes — one resolver branch + one gate helper, so every later student-side feature works for practice for free |
| D-4 | Invisibility | Excluded from every class reader, enforced by a single test; the per-student page reachable only from the practice row |
| D-5 | Test sessions tab / Monitor | Same list with a Practice label + See my answers + Practice again; the Monitor shows one row |
| D-6 | Practice again | Delete the attempt (relaxing `session_open` for practice) and rejoin |
| D-7 | Cleanup | Nightly sweep, 7 days after the sitting closed or expired; the sitting archived |
| D-8 | Lockdown | Always real in Release; no on/off option (U-4's "likely shape" dropped) |

## Slices

| # | Slice | Side | Size | Model |
|---|---|---|---|---|
| 0 | This note | docs | — | Fable |
| 1 | Server: **migration 0041** (`test_sessions.kind` + CHECK, `practice_for_sub`; `attempts.practice`; `students.practice_for_sub` + unique), `requireStudentOrPractice`, the resolver branch + `findOrCreatePracticeOverlay`, `POST /api/test-sessions` kind, `listMySittings` staff branch, the reader exclusions, the invisibility test, the access tests, the sweep | design tool | M | Opus 5 / medium |
| 2 | Teacher UI: "Practice on my Mac", practice rows (label, status line, See my answers, Practice again), Monitor's single row, Open-now / admin labels | design tool | S | Sonnet 5 / medium |
| 3 | Client: scope label, staff empty state, refusal copy; `swift test` for `MySittings` decoding | client | XS | Sonnet 5 / medium — rides v1.3.5 |
| 4 | Rows in `docs/design-tool-manual-checks.md` + `client/MANUAL-CHECKS.md`; quick-start "Practise on your own Mac" | docs | S | Sonnet 5 / low |

Slice 1 then 2 in this checkout (2 reads 1's types); 3 in parallel with 2
(disjoint trees). Deploy after 2; the client copy waits for the release.

## Dependencies and sequencing

- **Teacher Macs get the app + profile through Jamf** — requested from IT
  2026-09-22. The server half is deployable before that; nobody can use it
  until a teacher's Mac has the client. Off-fleet: the two values on the
  command line (`client/RELEASING.md`).
- Nothing here changes the access model (its note lists U-4 as "its own
  note"); the `run` level and `authorizeAssessment` are reused as-is.
- The quick-start gains one paragraph; the pilot teachers hear about it
  when their Macs carry the client.

## Follow-ups (not in this note)

- **Practise with accommodations**: pick a contrast / font / zoom set for
  the practice row (the overlay row can carry them; a small picker on the
  practice row). Worth doing once the accommodations rows have been run
  with real students.
- **Practise as a named student** (see exactly what one accommodated
  student sees) — an admin-ish capability; wait for the pilot to ask.
- **Practice on the Debug build for us** stays the dev launcher; nothing
  to build.

## Progress

2026-09-22: this note. Nothing built.

**Slice 1 (server) BUILT 2026-09-22, not committed, not deployed.**
**Migration 0041** (`practice_sittings`, applied to dev + test):
`test_sessions.kind` (`class` default, CHECK) + `practice_for_sub`, with a
CHECK that practice ⇔ `practice_for_sub` set and a practice sitting has no
section or student list; `attempts.practice` (default false);
`students.practice_for_sub` + `unique(owner_sub, practice_for_sub)`.
`requireStudentOrPractice` on all twelve student routes; the staff branch in
`resolveStudentForOwner` + `findOrCreatePracticeOverlay`;
`isAdmittedToSitting` refuses any student on a practice sitting;
`loadOwnAttempt` also refuses a staff caller on a non-practice attempt;
`POST /api/attempts` sets `practice`; `POST /api/test-sessions` takes `kind`
(a scope with practice → 400 `scope_conflict`); `listMySittings` staff branch
(scope `practice`, else `no_practice_sitting`). Readers excluded on
`attempts.practice`: `buildResults` (matrix, CSV, print report + summary,
work packet; new `include_practice` option, set ONLY by the per-student
page), review queue, `loadItemAnalytics`, hand-in-all (matches the sitting's
kind), `selectCorpusResponses`, `attendanceForSitting` (class: practice
excluded; practice: one row "You (practice)", `expected` = 1); on
`students.practice_for_sub IS NULL`: `loadOverlay` (Students page) and
`GET /api/students`. D-6's `session_open` relaxation for a practice attempt
is in the DELETE route. The sweep: `sweepPracticeSittings` in
`lib/retention/sweep.ts`, run after the D-11 sweep in the roster-sync
handler (own best-effort try + `practice_sweep` log line); the delete's DB
half was extracted to `lib/api/deleteAttempt.ts` (`deleteAttemptRecord`,
shared with the route). Tests: `test/practice-invisibility.test.ts` (12),
`test/practice-sitting.test.ts` (8), four resolver cases + a structural
gate check in `test/access-enforcement.test.ts`. Six existing tests changed
because D-3 changed their behaviour (staff was 403 on the student plane):
`auth-role-enforcement` (staff now passes the student-route gate; a guardian
is still 403), `my-sittings-api`, `delivery-api` (403 → 404),
`attempt-events-api` (403 → 404), `client-errors-api` (staff accepted; a
guardian 403 case added), `roster-sync-handler` (a third log line);
`resolve-student` got a type-only `?.`. Design-tool **2159** tests (2133
before), typecheck clean.
Decided here, left open by the note: the practice overlay row always lives
under the ASSESSMENT owner (the per-attempt routes resolve there); its name
is "Practice — <address local part>" (the session carries no display name);
the server's default duration stays 120 min — slice 2's button sends "rest
of the day"; the assessment-delete `has_attempts` guard and the dashboard's
attempt counts still count practice attempts (they gate deletion, and the
sweep clears practice within 7 days). **Known gap CLOSED (2026-09-22):** the
sweep now deletes the stored upload bytes too, not just the rows. The
Lambda still cannot import `lib/storage` (it would pull
`@aws-sdk/s3-request-presigner` into the roster-sync bundle for a client-PUT
flow this Lambda never uses), so the delete step is a small, dedicated
`infra/lambda/deleteStoredUpload.ts` — a bare `DeleteObjectCommand` from
`@aws-sdk/client-s3`, scoped to `storage_provider: "s3"` refs under
`responses/*` (anything else rejects rather than silently no-opping, so it
is never miscounted as deleted). The stack now passes the design-tool asset
bucket into `RosterSync` and grants the importer `s3:DeleteObject` on
`responses/*` of that bucket only (no Put, no Get, no List); the Lambda
wires `deleteStored` in only when `ASSET_BUCKET` is set, so a local/test run
keeps the DB-only sweep. **Finding (not fixed):** a
co-teacher's CLASS sitting creates the student's overlay under the
co-teacher's sub (`POST /api/attempts` resolves against
`sitting.owner_sub`) while every per-attempt route resolves against the
assessment owner — likely the students' saves 404 there; rows 223 / 228 /
230 would show it.

**Slice 2 (teacher UI) BUILT 2026-09-22, not committed.** Files changed:
`app/dashboard/[id]/SittingsPanel.tsx`, `app/dashboard/[id]/attendanceView.ts`
(two new pure helpers, `practiceStatusLine` and `practiceHasAttempt`, plus
their tests folded into `test/attendance-view.test.ts` — no new test file, the
existing one already holds every other pure helper this panel and the Monitor
share), `app/dashboard/[id]/monitor/[sittingId]/MonitorView.tsx` +
`.../page.tsx` (the one server-adjacent addition: `kind` passed through
`pageSitting`'s already-full row, no new query), `app/dashboard/page.tsx`,
`app/admin/page.tsx`.

"Practice on my Mac" sits beside Start session, gated only on
`isPublished && !archived` (not `sections.length`), and sends
`{ assessment_id, kind: "practice", duration_minutes: restOfDayMinutes(...) }`
— the same "rest of day" computation the class preset button uses. **Open
choice (no-existing-practice-sitting gate):** rather than a disabled button or
a warning dialog, the button is simply hidden while an open, unarchived
practice sitting already exists for the assessment (`sittings.some(kind ===
"practice" && isOpen)`) — its row's own actions (See my answers / Practice
again) take over, so there is never a moment offering to start a second one.
A practice row shows "Practice" in place of `scopeLabel`, the note's exact
three-state status line (`practiceStatusLine`, driven by the attendance
snapshot for that one row), and drops the Attendance expander, Hand in
everyone and Extend time (D-5) while keeping Show code / Monitor / Close
session / Archive-Unarchive, which still make sense on a practice row. Since
there is no Attendance expander to trigger the fetch, a small effect fetches
attendance for every open practice sitting the panel is showing, once per
sitting id (a `useRef` set, not re-fetched on every render) — fired when a
practice sitting first appears in `sittings`/`archivedSittings`, which covers
a fresh create, a Practice-again reset, and the panel's own Refresh button
(which reloads `sittings`, clearing nothing from the ref but re-running the
effect against the same still-open id only if it were ever removed and
re-added — in practice the ref just prevents a duplicate fetch on every
poll-unrelated re-render). **Open choice (no-confirm Practice-again):** a
single click, no `AlertDialog` — `DELETE /api/attempts/[attemptId]` directly,
a per-row busy flag (`practiceAgainBusyId`) disables just that row's button
while in flight, and failures use `attemptDeleteErrorCopy` (the same copy
table `DeleteAttemptControl` uses) in the panel's existing `actionError`
channel.

Monitor: `kind` rides down from `pageSitting`'s row (already a full
`TestSessionRow`, no new column needed) through `MonitorPage` to
`MonitorView`, typed as an optional plain `string` (Drizzle's `text()` column
has no literal type to narrow, and optional so the pre-existing
`hand-in-all-control.test.tsx` instantiations of `MonitorView` — which predate
practice sittings — still type-check as an ordinary class sitting). **Open
choice (Monitor suppression approach):** conservative — the per-row actions
(View screen, Hand in, Extend time, Delete attempt) already degrade correctly
for one row and needed no change; only the header-level "Hand in everyone"
and "Extend time" controls (the same components SittingsPanel's row carries,
per D-5) are suppressed for `kind === "practice"`, plus the scope line
("Open to all your sections" → "Open to you") so the empty state doesn't read
as a class assumption. `MonitorSummary`'s five tiles and the table already
work unchanged with one row.

Open-now (`app/dashboard/page.tsx`) and `/admin` (`app/admin/page.tsx`) both
gained `kind: test_sessions.kind` in their `.select()`. **Open choice (badge
placement):** a `<Badge variant="neutral">Practice</Badge>` beside the
assessment name on both surfaces (the same idiom the list rows already use
for the Archived badge); `/admin`'s Section column additionally reads
"Practice" instead of a bare "—" for a practice row, since it has no section
either way.

Tests: 8 new cases in `test/attendance-view.test.ts` (`practiceStatusLine` ×4,
`practiceHasAttempt` ×4) — pure functions, no DOM harness needed. The
fetch/effect wiring (the button click, the attendance auto-fetch, the Monitor
header suppression, the badges rendering) is hand-run-only; rows added to
`docs/design-tool-manual-checks.md` and `client/MANUAL-CHECKS.md`.
`bun run typecheck` clean; full suite 2175 pass (2159 baseline + 16 — 8 from
this slice, 8 already present in the working tree from other uncommitted
practice-sitting-adjacent commits since the design doc's baseline was taken).

**Finding (not fixed, flagged only):** the "Practice on my Mac" gate is a
client-side race — two tabs (or a very fast double-click before the first
`loadSittings()` resolves) could both see `hasOpenPractice === false` and each
POST a practice sitting. The server has no unique constraint preventing two
open practice sittings for the same `(assessment, practice_for_sub)` pair
(only `students.practice_for_sub` is unique per `(owner_sub,
practice_for_sub)` — the overlay, not the sitting), so this is a real,
if low-stakes and self-correcting (the older stays and the newer sits
orphaned until the sweep), gap. Not fixed here — out of scope for a client-side
button and a server constraint change was explicitly excluded from this
slice's server-adjacent allowance.

Slice 2 review fix (main session, 2026-09-22): `GET /api/test-sessions` and
the home's Open now listed every sitting on a visible assessment, so an owner
would have seen a co-teacher's practice sitting as "You (practice)" with a
Practice again that deletes the colleague's attempt. Both now add
`sittingVisibleToCaller(sub)` (`lib/api/testSessions.ts`: class sittings, or
practice sittings whose `practice_for_sub` is the caller); `/admin` still
lists every open sitting, labelled. Test: `test/practice-sitting.test.ts`
"sitting lists" (fails without the filter). Design-tool 2176 tests.

Slice 4 (2026-09-22 evening): `docs/pilot-quick-start.md` gains "Teacher —
practise on your own Mac" (before "Three clocks"): the teacher-Mac
prerequisite, the three steps, invisibility + the 7-day cleanup, and the
v1.3.4 label caveat (D-8's "older client"). The hand-run rows were written in
slice 2 (253–262); the client rows ride slice 3 / v1.3.5.

**Slice 3 (client copy) BUILT 2026-09-22, not committed, not deployed, not
released** — built together with `docs/client-v1-3-5-design.md` slices 1 + 2
in the same session, since both ride the same v1.3.5 release.

- `MySittings.swift`: `Sitting.scope` doc-comment notes `"practice"` as a
  valid value (unknown-scope handling was already the general `default:`
  case, so an older client keeps working as designed); `SittingRowModel`
  gained `isPractice` (`scope == "practice"`) and, in the `where_` derivation,
  a practice sitting is labelled "Practice — only you" ahead of the
  section-label check (a practice sitting never carries one, per D-1, but
  checking scope first costs nothing for a client that already reads a
  label). The teacher line is untouched — `detail` still appends
  `teacherEmail` the same way for every scope.
- `JoinErrorCopy.swift`: `no_practice_sitting` → "No practice tests right
  now. Start one from your assessment's Test sessions tab." (the staff
  empty-list reason, parallel to the student `not_on_roster` reason —
  distinct wire code, no ambiguity). `not_in_sitting` is genuinely ambiguous
  on the wire — `resolveStudent.ts`'s `resolvePracticePrincipal` returns the
  same `not_in_sitting` string for a staff member on someone else's practice
  sitting as `resolveStudentForOwner` does for a student outside a class
  sitting — so `message(for:isPractice:)` / `message(forCode:isPractice:)`
  gained an `isPractice` parameter (default `false`, so every existing call
  site is unaffected); `not_in_sitting` reads as "This practice test is for
  the teacher who started it." only when the caller says the row it tried
  was practice.
- `SessionEntryViewController.swift`: `joinListedSitting`'s error handler
  passes `isPractice: row.isPractice` into `Self.message(for:isPractice:)`
  (now the plumbing point — the row the student/staff caller tried to join
  is the only place this client can tell the two `not_in_sitting` cases
  apart). The join-by-code path (`join()`) is untouched — a practice sitting
  is never joined by code, only listed, so it keeps the default `false`.
- Tests (`MySittingsTests.swift`): `testPracticeScopeIsFlaggedAndLabelledOnlyYou`,
  `testPracticeScopeStillShowsTheTeacher`, `testNonPracticeScopesAreNotFlagged`,
  `testDecodesTheNoPracticeSittingReason`,
  `testNotInSittingReadsDifferentlyForAPracticeRow`.

`swift test` 690 (677 baseline, +13 across both this slice and
`client-v1-3-5-design.md` slices 1–2 built the same session — see that
note's Progress for the per-slice split). `xcodebuild` green, Debug and
Release. No `client/MANUAL-CHECKS.md` rows, no `MARKETING_VERSION` bump, no
release yet — those are v1.3.5 slice 3/4 in the OTHER note.
