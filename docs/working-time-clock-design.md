# Working-time clock — design note (2026-11-25)

Status: decisions D1–D6 and Q1–Q4 made (James, 2026-11-25). Slice 1 in
progress.

Roadmap: row U-8 (a) in `docs/roadmap-2026-09.md`; first on the public
roadmap's Ahead list since PR #248. Builds on
`docs/time-limit-and-unfinished-attempts-design.md` (the wall-clock deadline,
`lib/api/attemptDeadline.ts`).

## Problem

A time limit today is wall-clock: `started_at + time_limit_seconds` per
attempt (`deadlineFor`). A 60-minute test started Monday is expired on Tuesday
however little the student worked. Teachers work around it by hand with
Extend time.

## Evidence (production, read-only aggregate query, 2026-11-25)

| Count | Value |
|---|---|
| Assessments | 140 |
| Timed assessments | 19 (14%) |
| Timed attempts (not practice) | 281 |
| Timed attempts with more than one secure session (`lockdown_begin` > 1) | 51 (18%) |
| Timed attempts with Extend time (`deadline_override_at` set) | 53 (19%) |
| Timed attempts that hit `time_expired` | 4 (1 rejoined after) |
| Timed attempts with the limit removed | 0 |
| Pass backs, all tests | 625 |

Reading: extensions track multi-session attempts almost one for one, so
teachers already extend so students can come back. `time_expired` is low
partly because a v1.5.0+ client refuses a past-deadline rejoin before the
session begins, which posts no event. "More than one session" also counts a
same-period relaunch; the multi-day share is not measured.

## Decisions (James, 2026-11-25)

- **D1 Per test.** A timed assessment chooses its clock: **working time**
  (time spent in the test, across sessions) or **wall clock** (today's rule).
- **D2 Rejoin needs the teacher.** On a working-time test, a student who left
  the test cannot pause the clock and come back on their own: rejoining
  waits for the teacher's approval, as College Board and state test apps do.
- **D3 Extend time is "+N minutes"** on a working-time test (an end time does
  not fit a clock that pauses). Wall-clock tests keep "until 10:45".
- **D4 Pass back resumes the clock** where it stopped, with an optional
  "+N minutes" in the same dialog.
- **D5 The Monitor shows minutes used and minutes left** per student.
- **D6 Attempts in progress at deploy** get credit for time already spent,
  estimated from their existing `lockdown_begin` / `lockdown_end` /
  `time_expired` / `sitting_closed` events.

## Model

- `assessments.time_limit_mode text NOT NULL DEFAULT 'working'`,
  CHECK in (`working`, `wall`). Read only when `time_limit_seconds > 0`.
- `attempts.working_seconds double precision NOT NULL DEFAULT 0`,
  `attempts.last_tick_at timestamptz NULL`,
  `attempts.extension_seconds integer NOT NULL DEFAULT 0` (D3, D4).
- **The tick.** The client already polls `GET /api/attempts/:id/peek/pending`
  every 5 s during a secure session (`PeekResponder.defaultInterval`), and the
  poll already carries the deadline (EX-1). On each poll of an in-progress
  working-time attempt: `gap = now − last_tick_at`; if `gap ≤ 2 min` (Q4), add
  it to `working_seconds`, else record a `clock_gap` event; set
  `last_tick_at = now`. A crash or quit loses at most one gap. Joining (the delivery route) sets `last_tick_at = now` without
  adding time. Untimed and wall-clock attempts never write, so the poll
  stays read-only for them. **No client change.**
- **The deadline** (working time) =
  `now + max(0, limit + extension_seconds − working_seconds)`, recomputed on
  each request. During a session it stays steady; between sessions it moves
  later, which is the point. Every caller of `deadlineFor` (delivery,
  response write, upload, submit, hand-in, pass back, Your tests, Monitor,
  attempt-one, results) goes through one function, as today. The 30 s grace
  is unchanged. `time_limit_removed` still beats everything.
- **Wall clock** keeps `deadlineFor` exactly as today.

## Rejoin approval (D2)

- **When it applies:** a working-time attempt with `working_seconds > 0`,
  asking for its delivery bundle when its last tick is older than 60 s (it is
  not mid-session; a reload within a live session is not a rejoin).
- **Refusal:** 409 `rejoin_needs_approval`; the server records
  `attempt_events` kind `rejoin_requested` (server-written).
- **Teacher:** the Monitor row shows "Asks to continue" with **Let back in**;
  approving sets `attempts.rejoin_approved_until = now + Q3` and writes
  `rejoin_approved` (server-written, `by`).
- **Student:** the next join inside the window succeeds and consumes the
  approval. Shipped clients show their generic "Your test didn't open… open
  it again" copy for an unknown 409, so a student retries after the teacher
  approves; a client release adds "Your teacher needs to let you back in" and
  retries on its own (client release queue).

## Interactions

- **Extend time (D3):** `POST /api/attempts/:id/extend` takes `add_minutes`
  on a working-time test (adds to `extension_seconds`, event
  `deadline_extended` with `detail.add_seconds`); `ends_at` stays for wall
  clock.
- **Pass back (D4):** keeps `working_seconds`; the dialog's deadline field
  becomes "+N minutes (optional)" on a working-time test.
- **Live re-arm:** unchanged — the poll's `time_limit_ends_at` already re-arms
  the client countdown.
- **Settings tab:** a "Clock" choice beside the time limit: "Time spent in the
  test (pauses between sessions)" / "Clock time from the start".

## Sub-decisions (James, 2026-11-25)

- **Q1 Existing timed tests move to working time** at deploy, with D6's
  credit; `extension_seconds` gets `max(0, override − (started_at + limit))`
  from any existing override, so no extended student loses time.
- **Q2 A same-period relaunch (a crash or quit) also needs approval** — the
  teacher is in the room.
- **Q3 An approval lasts 10 minutes**, one use.
- **Q4 Gaps up to 2 minutes count as working; longer gaps are logged.** A
  join resets the tick, so the cap only matters for gaps INSIDE one session,
  where the student is locked into the test and a gap is almost always the
  network or a deploy, not a pause. 2 minutes counts honest blips, removes the
  "turn Wi-Fi off for free time" incentive, and costs a sleeping Mac at most
  2 minutes. A gap over the cap is recorded (`clock_gap`, server-written,
  `detail.seconds`) so the Monitor can show it and a teacher can add minutes.

## Slices

1. **Server clock:** migration (four columns), the tick in the peek poll, the
   working-time deadline in `deadlineFor`, D6 backfill + Q1 override
   conversion in the migration's companion script, tests. No UI.
2. **Teacher UI:** Settings "Clock" choice; Extend time "+N minutes"; pass
   back "+N minutes"; Monitor used / left (D5); help topic 7 ("Three
   clocks").
3. **Rejoin approval (D2):** the refusal, the events, the Monitor button,
   tests.
4. **Client copy** for `rejoin_needs_approval` + auto-retry: rides the next
   client release.

## Progress

- 2026-11-25: note written from the production counts and James's decisions.
- 2026-11-25: **slice 1 BUILT** (not merged or deployed). Migration
  `0074_working_time_clock.sql`: `assessments.time_limit_mode` (default
  `working`, so every existing timed test moves, Q1), `attempts.working_seconds`
  / `last_tick_at` / `extension_seconds`, the `clock_gap` event kind, then the
  D6 backfill (session events; no events → clock time since start capped at
  the limit) and the Q1 override → `extension_seconds` conversion.
  `deadlineFor` takes `now` and applies the working-time rule (live = ticked
  within 2 min; used up and not live → a fixed past instant, so no rejoin
  through the grace). `lib/api/workingClock.ts` ticks from the peek poll
  (gaps logged) and the delivery request (not logged), only for in-progress
  working-time attempts, under a row lock. Extend time and pass back still
  send an end time: on a working-time test it becomes `extension_seconds`
  (`extensionForEndTime`) until slice 2's "+N minutes". Monitor / timeline
  words for `clock_gap`. Tests: `test/working-time-clock.test.ts` (17: the
  rule, the tick incl. a stale caller copy, extend, the backfill on fixture
  rows); wall-clock tests pinned to `time_limit_mode: "wall"`. Full suite
  4552 pass on a branch test database (`secure_test_design_tool_test_wtc`).
- **Deploy note:** slice 1 alone changes every timed test to working time
  with no teacher-facing setting, no Monitor used/left and no rejoin approval
  (so a student can quit and rejoin an open sitting with the clock paused).
  Ship it together with slices 2 and 3.

