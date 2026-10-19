# Ended session: let students back in (roadmap row ES)

Status: DECIDED 2026-10-19 (James: D-1 (a), D-2 every ended class sitting, hotfix mode in `deploy.sh`) — nothing built. Side: design tool only (no
client change, no migration).

## Trigger (beta report, 2026-10-19)

A teacher ran a 30-minute class sitting on a Friday: 11 students handed
in, 5 were still writing when it ended (each got `sitting_closed`, as
designed). On Monday she wanted the 5 to finish and the absent students
to start. She opened Friday's Monitor and pressed **Adjust time** 11
times in 15 minutes; she never pressed Start session. Every student who
typed Friday's code was refused (`redeem` requires `expires_at > now`),
so rejoiners and absent students alike were locked out. Side effect: on
an untimed test, Adjust time to a clock time set a deadline on the 5
attempts — 4 of them to a time that passed minutes later.

The product model is right (help topic 7: a test that spans classes =
a new session; in-progress attempts rebind and resume, finding 8.2). The
gap is that nothing on an ended sitting says so, and the one control on
it that looks like "give them more time" — Adjust time — cannot.

## Decisions

**D-1 Fix shape.**
- (a) **Decided — "Continue in a new session".** On an ended or
  closed class sitting, a button that starts a new sitting with the SAME
  scope (one section / the student list / all sections) and opens its
  Monitor with the code showing. Reuses `POST /api/test-sessions`
  unchanged; no new rule. Covers rejoiners AND absent students (the new
  sitting admits the whole scope).
- (b) "Reopen" — push the old sitting's `expires_at` forward, same code.
  Matches the teacher's words ("reopen the room") but reverses the CS
  rule that a closed sitting stays closed, a closed sitting's code may
  already be reused by another sitting, and one sitting would span days
  (attendance, Monitor history). Not recommended.

**D-2 Where it shows.** Decided: the Monitor header of an ended /
closed sitting, and that sitting's row on the Test sessions tab. Always
on an ended class sitting (absent students need it even when no one is
mid-test), never on a practice sitting.

**D-3 Banner on an ended Monitor.** Recommended, when N > 0 attempts are
in progress: "This session has ended. N students haven't handed in —
they can finish in a new session. Adjust time alone doesn't let anyone
back in." with the D-1 button beside it. When N = 0, the header button
only.

**D-4 Adjust time on an ended sitting.** Keep it (a deadline set now
still applies once the student joins the new session). Add one line to
its dialog when the sitting is not open: "This session has ended —
students need a new session to get back in." Recommended.

**D-5 Session length in the new-session dialog.** Recommended: the same
presets + minutes field as Start session (default 55), no scope
choice — the scope is copied. Changing the scope = use Start session.

**D-6 Untimed test + Adjust time to a clock time (the side effect).**
EX-2 already opens the dialog on No time limit for an untimed test with
a warning. Recommended: no further change now; record it as a reading.

## Slices

1. Server: none expected — confirm `POST /api/test-sessions` accepts
   the copied scope from a sitting the caller can `run`, including a
   co-teacher's (sitting owner = assessment owner rules unchanged), and
   that `sweepExpired` releases the old code first. Tests for the copy
   helper (pure: sitting → create body).
2. UI: `ContinueInNewSessionControl` (dialog: length presets, Start) on
   the Monitor header + Test sessions row; D-3 banner; D-4 dialog line.
   Lands on the new Monitor with the code dialog open.
3. Docs: help topic 7 step + picture refresh, FAQ "I adjusted time but
   students still can't get in", quick start, `/roadmap.html` milestone,
   rows in `docs/design-tool-manual-checks.md`.

## Shipping before v2.0

`main` is 99 commits past LIVE (`3e1ecc58`) and is held for v2.0
(migrations 0060 + 0061, unrun rows, a renderer re-sign). To ship this
first:

- Build on a `hotfix/es-ended-session` branch from `3e1ecc58`; PR to get
  `ci` (ci runs on `pull_request`).
- `deploy.sh` refuses any HEAD but `origin/main`. Needs a hotfix mode:
  allow HEAD = a pushed `hotfix/*` branch whose commit has green `ci`,
  force `--no-renderer` (production keeps renderer v1792017314), stamp
  APP_COMMIT from that HEAD, refuse if the branch carries a migration
  the live DB lacks.
- After the deploy, cherry-pick the slice commits onto `main` (the
  dashboard files have moved since `3e1ecc58` — expect hand-resolved
  hunks); the v2.0 deploy then carries them.
- No migration → any time of day is allowed by DS-2.

## Rows (to write with slice 2)

Ended sitting with in-progress students → banner + button; new sitting
same section → rejoiners resume, absent students start, handed-in
students see "already handed in"; student-list sitting copies the list;
practice sitting shows no button; co-teacher's ended sitting; Adjust
time dialog line on an ended sitting.

## Progress

- 2026-10-19: note written from the beta report (read-only Aurora query
  in the session scratchpad; no student identifiers recorded).
- 2026-10-19: built on `hotfix/es-ended-session` from `3e1ecc58` —
  slice 1 helpers + route proof (`canContinueInNewSession`,
  `continueSessionBody`; no server change), slice 2 the control, Monitor
  banner + header button, Test sessions row button, Adjust time line on
  all four Adjust time buttons (`ENDED_SITTING_NOTE`), slice 3
  `deploy.sh --hotfix`, slice 4 help topic 7 + FAQ + roadmap milestone
  (branch) and quick start + rows 650–657 (main). Design-tool 3238 pass.
  Rows 650–653 ✅ on local dev. Readings: a co-teacher continuing the lead
  teacher's sitting for a period they don't teach gets "That section isn't
  on your class list any more"; an ended sitting's Test sessions row still
  has no Monitor link (unchanged); students whose own deadline already
  passed are refused in the new session until the teacher sets No time
  limit (the Monitor's existing "Time ran out" note says so).

