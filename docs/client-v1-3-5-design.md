# Client v1.3.5 — four small fixes from the pilot's first week

Design note, 2026-09-22. Four readings that have only ever been recorded
as proposals — L-2's two halves (`docs/ux-pass-3-research.md`), SI-1 and
AS-1 (`docs/roadmap-2026-09.md` §Progress 2026-09-21,
`docs/client-autosave-and-deferred-spool-design.md` §Progress) — gathered
into one client release. Decisions marked **D-n** are James's and are
listed at the end; **§Progress says what is built** (nothing yet). Client
only: no migration, no deploy; the release path is `client/RELEASING.md`
(psd-sign 0.6.0 from the session, `gh release create` by James, IT's
AutoPkg recipe moves the fleet the next day).

## What exists that this stands on

- **Teardown.** `AssessmentLockdown.tearDown` calls `end()` and arms a
  backstop for `Timings.grace` — **5 s** by default (`Timings.init(...,
  grace: 5)`), the same in Debug and Release. If `DID END` has not
  arrived, `onUnrecoverable` fires on the backstop queue with the main
  thread presumed gone, `CrashReporter.writeUnrecoverableLine()` appends
  one pre-formatted line to `errors.log`, and the app calls `exit(70)`.
  The process exit ends the AAC session, so the Mac unlocks either way.
  The page-load gate on the way IN waits **20 s** for `DID BEGIN`.
- **What the fleet has shown.** One pilot Mac hit the backstop on
  2026-09-17 at ~13:02 (L-2): the sitting closed, `end()` was called, no
  confirmation in 5 s, exit. Our test device confirmed `lockdown_end` 3 s
  after `sitting_closed` in the 2026-09-16 real-session run. No other
  latency has been measured.
- **The unrecoverable line** is built at install time by
  `CrashReporter.line(kind:message:stamp:attemptID:)` with `kind`,
  `message`, `app_version`, `app_commit` and `attempt_id` — and no
  `occurred_at`, because a signal handler cannot read a clock. The server
  (`POST /api/client-errors`) stamps the drain time. The unrecoverable
  path, unlike the signal handlers, runs on an ordinary dispatch queue
  where `Date()` is safe; it shares the pre-formatted buffer only for
  uniformity.
- **Sign-in.** `WebViewAuthPresenter` finishes the sheet with the raw
  error from `didFailProvisionalNavigation` / `didFail` and with
  `SignInError.cancelled` from the Cancel button, Cmd-Q, a second Join
  while a sheet is up, or a missing host window. `SessionEntryViewController.
  startSignIn` maps `SignInError` to a status line ("Sign-in was
  cancelled.") and any other error to "Could not sign in. Tell your
  teacher.", logs `signin_failed`, then calls `refreshSignInState()`. The
  two `-999` rows (`NSURLErrorCancelled` on `accounts.google.com/a/
  <student-domain>/acs`) went through the generic branch. In WebKit a
  cancelled navigation is routinely a navigation that was superseded by
  another (a redirect issued while the POST was in flight), not a
  failure; treating it as fatal is the SI-1 bug. The pilot's twelve
  `cancelled` rows on day 1 are students backing out of the sheet.
- **Autosave (v1.3.4).** `onchange` posts unconditionally after an
  autosave already posted the same text, so leaving a field costs one
  duplicate POST per focus (AS-1); no data effect.

## Design

### 1. Teardown grace (D-1)

Raise `Timings.grace` from 5 s. The candidate is **20 s**, matching the
page-load gate's backstop, on the argument that a locked screen that
waits a few extra seconds is cheaper than an app that vanishes — but the
number should come from the fleet, not from symmetry: **measure
`lockdown_end − (sitting_closed | time_expired | emergency exit)` across
every real attempt since 2026-09-14 first** (the read-only pull in the
session scratchpad, `d1-teardown-latency.sql`; the note records the
distribution when it exists). Keep the exit(70) escalation as the last
resort; add one stderr line at half the grace ("still waiting for DID
END") so a slow teardown is visible in `errors.log`'s neighbours. The
env knob `SECURE_TEST_WATCHDOG_SECONDS` is unrelated and unchanged; the
grace is not exposed as a knob (Release reads no knobs).

### 2. The unrecoverable line carries its own time (D-2)

`onUnrecoverable` writes a line formatted at that moment — `occurred_at`
(ISO 8601, UTC), `os_version` (`ProcessInfo.operatingSystemVersionString`),
plus the existing fields — instead of the install-time buffer. The signal
handlers keep the pre-formatted buffer (they cannot read a clock). The
server already accepts `occurred_at` on every entry; `context` gains
`os_version`. The drain-time stamp remains the fallback when the line
has none.

### 3. Sign-in: cancelled navigations and the entry card (D-3)

- `WebViewAuthPresenter`: in both `didFail…` delegates, **ignore
  `NSURLErrorCancelled` (-999)** — return without finishing; the sheet
  stays up and the superseding navigation carries on. Every other error
  still finishes the sheet. This is the standard WKWebView pattern and
  removes SI-1 at its source; no retry logic.
- The entry card after a cancel or a failure: keep the status line, and
  **verify that `refreshSignInState()` does not clear it** (the 2026-09-21
  reading was "the bare sign-in card came back", which suggests it does —
  a hand-run row, fixed if so). Copy stays: "Sign-in was cancelled." /
  "Could not sign in. Tell your teacher." The Cancel button on the sheet
  stays: a student who opened the wrong account picker needs it.
- No client-side count of cancels; the server rows already show the
  rate per day (L-1), which is what the pilot needs.

### 4. AS-1 guard (D-4)

In the autosave module's `onchange` handler: post only when
`current() !== lastPosted`. One line and a JSC harness test (the
existing autosave tests cover the baseline).

## Decisions (James)

| # | Decision | Recommendation |
|---|---|---|
| D-1 | Teardown grace | measure first; expect 20 s unless the fleet's tail says otherwise |
| D-2 | Unrecoverable line fields | `occurred_at` + `os_version`, written at exit time |
| D-3 | Sign-in | ignore -999 in the presenter; keep the status line and verify it survives the refresh; no retry, no cancel counter |
| D-4 | AS-1 | the guard, as proposed |

## Slices

| # | Slice | Size | Model |
|---|---|---|---|
| 0 | This note + the D-1 latency pull | — | Fable |
| 1 | Core: `Timings.grace` default per D-1, the half-grace stderr line, the timed unrecoverable line (D-2) — `swift test` for both | S | Sonnet 5 / medium |
| 2 | App: the presenter's -999 handling, the entry-card status line survives the refresh (D-3); AS-1 guard in the page script (D-4) — JSC test | S | Sonnet 5 / medium |
| 3 | Rows in `client/MANUAL-CHECKS.md` (two real-session rows: a Close while locked on the slowest Mac available, an unrecoverable simulated with `SECURE_TEST_SIMULATE_LOCKDOWN=hang` if the simulator gains that value); `MARKETING_VERSION` 1.3.5 | XS | Sonnet 5 / low |
| 4 | Release: psd-sign → `gh release create` (James) → AutoPkg next day | — | James |

Disjoint files, so 1 ∥ 2 in one checkout; rows after both; no server
change anywhere.

## Sequencing

After the v1.3.4 client sitting (the rows waiting on the student device)
and the D-1 measurement; before the practice-sitting client copy (which
would otherwise be the only reason for a release). Pilot-week rule: a
client release is a fleet disruption — cut it when the rows are run, not
before.

## Progress

2026-09-22: this note. Nothing built.
