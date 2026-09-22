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
number should come from the fleet, not from symmetry.

**Measured 2026-09-22** (`query-aurora.sh`, read-only, every
`sitting_closed` / `time_expired` / `emergency_exit` since 2026-09-14 and
the `lockdown_end` that followed it on the same attempt):

| | |
|---|---|
| End events | 48 (40 sitting closes, 8 emergency exits; 0 time-expired) |
| Confirmed with a `lockdown_end` | 43 — p50 **3.4 s**, p90 **3.8 s**, max **5.4 s** (measured from the end event's server stamp, so from `end()` itself each is a few hundred ms less) |
| **Never confirmed** | **5, all `sitting_closed`, all pilot Macs on v1.3.3, 2026-09-17 / 18** — one of them is L-2 (the only one whose exit(70) line has drained); the other four have no later event on the attempt (the student never came back to it — three are still in progress) and no client line naming them yet, so they are either exits whose lines wait for the student's next sign-in, or ends that never reached `end()` |
| Pattern | four of the five were a lone student still inside when the sitting closed; the fifth was one of 21 attempts closed in the same minute, of which 20 confirmed in 3.2–5.4 s — so not load, something per Mac |

Reading: the healthy fleet confirms in 3–4 s and the 5 s grace already
sits on the tail (one confirmed end took 5.4 s by the event clock). Between
2 % and 10 % of pilot session ends did not confirm in time. **Recommend
20 s** — a student on a slow Mac waits on a locked screen a few seconds
longer; the app no longer disappears. Keep the exit(70) escalation as the last
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

## Decisions (James, 2026-09-22 — all four accepted as recommended)

| # | Decision | Decided |
|---|---|---|
| D-1 | Teardown grace | **20 s** ("the right target"), after the measurement above |
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

**Slices 1 + 2 BUILT 2026-09-22, not committed, not deployed, not released.**

Slice 1 (Core, `client/SecureTestCore`):

- `AssessmentLockdown.swift` — D-1: `Timings.init`'s `grace` default raised
  5s → 20s (the only call sites, `Timings(watchdog:)` and
  `fromEnvironment`, take the default, so both Debug and Release move
  together with no other change). `endBeforeTeardown` now arms a second
  timer at `grace / 2` on the same backstop scheduler that logs "still
  waiting for DID END after Ns (grace Ms)" via `onLog` (→ the app's
  `[security]` stderr channel) and is cancelled in `finishTeardown`
  alongside the backstop itself, so a confirmed-early teardown leaves
  nothing armed.
- `CrashReporter.swift` — D-2: new `timedUnrecoverableLine(stamp:attemptID:occurredAt:osVersion:)`
  builds the JSON line fresh (`occurred_at` ISO 8601 UTC, `context.os_version`
  from `ProcessInfo.operatingSystemVersionString`) instead of reusing the
  install-time buffer, and `writeTimedUnrecoverableLine(stamp:attemptID:)`
  writes it with the same synchronous `write(2)` to `crashDescriptor` the
  signal path uses. The old `writeUnrecoverableLine()` / pre-formatted
  buffer path is untouched (the signal handlers still need it — they
  cannot read a clock).
- `AppDelegate.swift`'s `lockdown.onUnrecoverable` now calls
  `CrashReporter.writeTimedUnrecoverableLine(stamp: Self.buildStamp,
  attemptID: ClientErrorLog.shared?.attemptID)` instead of
  `writeUnrecoverableLine()`.
- Tests: `AssessmentLockdownTests.swift` (`testWatchdogDefaultsShortForTheTestingPosture`,
  `testWatchdogIsDisabledWhenOverridesAreNotAllowed` updated for the new
  default; `testHalfGraceStderrLineFiresBeforeTheBackstop`,
  `testHalfGraceTimerIsCancelledWhenTeardownConfirmsEarly` added) and
  `CrashReporterTests.swift` (`testTimedUnrecoverableLineCarriesOccurredAtAndOSVersion`,
  `testTimedUnrecoverableLineOmitsAttemptIDWhenNoneIsOpen`,
  `testWriteTimedUnrecoverableLineLandsInTheLogFile`,
  `testWriteTimedUnrecoverableLineIsANoOpWithNoDescriptor`).

Slice 2 (App + page script):

- `WebViewAuthPresenter.swift` — D-3: both `didFail…` delegates now check a
  new `isCancelledNavigation(_:)` (`NSURLErrorDomain` / `NSURLErrorCancelled`)
  and return without finishing the sheet when it matches, leaving the
  superseding navigation to carry on. The Cancel button's path
  (`cancelPressed` → `finish(.failure(.cancelled))`) is untouched, so a
  student backing out of the sheet is unaffected. No JSC/unit coverage
  possible here (no window server); this is a `client/MANUAL-CHECKS.md` row.
- `SessionEntryViewController.swift` — D-3's second half: `refreshSignInState()`
  used to unconditionally overwrite `statusLabel` with "Sign in with your
  school Google account first." whenever signed out, which clobbered the
  "Sign-in was cancelled." / "Could not sign in. Tell your teacher." lines
  set immediately before the `await refreshSignInState()` call that follows
  every sign-in failure — the 2026-09-21 reading ("the bare sign-in card
  came back"). Fixed: that branch now only fills the line when it is
  already empty.
- `AssessmentPage.swift` — D-4 (AS-1): the `textAutosave` module's
  `el.onchange` handler posted unconditionally even when an idle/ceiling
  autosave had already posted the identical text moments before blur. Now
  compares `current()` against `lastPosted` first (the same check the
  autosave path already used) and skips the underlying `change` post
  (`priorChange`) when nothing changed, while still updating `lastPosted`
  either way.
- Tests: `RendererTextAutosaveTests.swift` (`testBlurAfterAnAutosaveOfTheSameTextDoesNotPostAgain`,
  `testBlurWithNewTextAfterAnAutosaveStillPosts`) — the JSC harness the
  existing autosave tests already use (`RendererHarness`, the virtual-clock
  prelude).

`swift test`: 677 → 690 (13 new). `xcodebuild` green, Debug and Release
(Release rebuilt because the exit path both D-1 and D-2 touch runs there).
No `client/MANUAL-CHECKS.md` rows written yet, no `MARKETING_VERSION` bump,
no release — that is slice 3/4, later, together with the practice-sitting
client copy (`docs/practice-sitting-design.md` slice 3, built the same
session).

Not built from this note: slice 3 (MANUAL-CHECKS rows, `MARKETING_VERSION`
1.3.5) and slice 4 (release).
