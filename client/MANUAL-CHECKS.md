# Manual lockdown checks

The list a person runs by hand, because nothing here can be verified in this
repo's test suite.

Everything in `SecureTestCore` is covered by `swift test`. What is NOT, and
cannot be, is the AppKit and WebKit surface: drag destinations, Touch Bar,
auxiliary web views, file pickers, and the menu bar all need a running window
server and a human doing the gesture. Headless Chrome and Playwright both hang
in this environment (ADR 0013), so there is no automated substitute available —
which is exactly why PoC-B verified its own hardening this way
(`poc-b-test-loop/RESULTS.md`, "Verification results") and why these items sat
untested for as long as they did.

Run against a debug build:

```bash
cp SecureTestCore/Tests/SecureTestCoreTests/Fixtures/delivery-bundle.json \
  ~/Library/Containers/net.psd401.securetest.client/Data/
./SecureTest.app/Contents/MacOS/SecureTest --bundle \
  ~/Library/Containers/net.psd401.securetest.client/Data/delivery-bundle.json
```

The copy is not optional for the ARGV path (found 2026-08-27): the app is
sandboxed (added with Google sign-in), and `files.user-selected.read-only`
covers open-panel picks, not argv paths — a repo-relative `--bundle` fails with
`could not read bundle`. The app's own container is the one place an argv path
is readable. **File → Open Test Bundle… (Cmd-O) is the way in from anywhere
else** — launch with no arguments and pick the fixture straight out of the
repo; rows under "File → Open Test Bundle" below.

Watch stderr — every refusal below logs a `[security]` line, so a check that
passes silently has not actually been exercised.

## Ported from PoC-B, already verified there

| Check | Expected |
|---|---|
| Right-click on plain page area | No menu |
| Right-click in a text field | No menu, no Autofill |
| Right-click on selected text | No menu, no Services |
| Drag the page's own text out to Finder or another app | Nothing drags |
| Cmd-Q | Quits |

## Slice 72 — closed but never verified by hand

| Check | Expected |
|---|---|
| Drag a file from Finder onto the page | Refused; no drop indicator appears |
| Drag selected text from another app onto an answer field | Refused |
| Touch Bar (or the Touch Bar simulator) with a text field focused | No suggestions, emoji or app controls |
| A page that calls `window.open` | `BLOCKED attempt to open a second web view` |
| A page containing `<input type="file">`, clicked | `BLOCKED file picker request`; no panel |
| A page that calls `alert()` / `confirm()` / `prompt()` | Dismissed, `BLOCKED js …` logged, no modal |

## Clipboard policy (slice 69)

Run twice: once with an assessment whose `allow_clipboard` is false, once true.

| Check | Locked | Permitted |
|---|---|---|
| Cmd-C on selected stem text | Nothing copied | Copies |
| Cmd-V into an answer field | Nothing pasted | Pastes |
| Edit menu | Cut/Copy/Paste greyed | Enabled |
| Edit menu with a text field focused | Still greyed | Enabled |

The last row is the one that matters. AppKit re-enables those items from the
responder chain the moment a text field takes focus unless `autoenablesItems` is
off, which is precisely when a student would try.

## Sign-in (slice 80) — cannot be verified here; nine rows verified by hand 2026-08-27

**2026-08-27:** first live run on James's PSD Mac against a local design tool,
with the real native client id (GCP `psd-applications`, "secure-test macOS
client", bundle id `net.psd401.securetest.client`) and a `psd401.net` staff
account, then the remaining rows in a second pass the same afternoon. Rows
marked ✅ below were observed; the rest are still unverified. Two things the
table did not anticipate: Google's consent screen for this project is
**Internal**, so a personal Gmail is refused by Google before our domain
check runs; and after a relaunch the status reads "Signed in" with no email
(see "Still open").
One defect found on the way: the sandboxed app had no
`com.apple.security.network.client` entitlement, so the token exchange to
`oauth2.googleapis.com` failed with `NSURLErrorDomain -1003` ("hostname could
not be found") — the sheet itself worked because `ASWebAuthenticationSession`
is out-of-process. Fixed by `ENABLE_OUTGOING_NETWORK_CONNECTIONS = YES` in
both configurations.

`GoogleSignInFlow` (URL building, PKCE, state/nonce, token exchange, the
design-tool exchange) is covered by `swift test`. The sheet itself —
`ASWebAuthenticationSession` in `GoogleAuthPresenter` — needs a window
server and a Google account, so every row below is unverified until someone
runs it. Needs `SECURE_TEST_GOOGLE_CLIENT_ID` (the native client's id) and a
design tool whose `OIDC_AUDIENCE` lists that id (slice 77).

```bash
SECURE_TEST_GOOGLE_CLIENT_ID=<native-client-id> SECURE_TEST_SERVER=http://localhost:3000 \
  ./SecureTest.app/Contents/MacOS/SecureTest
```

| Check | Expected |
|---|---|
| Launch with no client id | ✅ 2026-08-27 — No sign-in button (and no sign-out); stderr `no SECURE_TEST_GOOGLE_CLIENT_ID — sign-in button hidden`. Code field and Join were enabled because the Keychain still held the JWT from the previous Google sign-in — the same "seeded" case as `--token`; status read "Signed in" with no email |
| Launch with a client id, nothing in the Keychain | ✅ 2026-08-27 — "Sign in with Google" shown; code field and Join disabled; status says to sign in first |
| Click sign in | ✅ 2026-08-27 — A system sheet opens on Google's sign-in page, not Safari; stderr logs `sign-in: opening accounts.google.com …` |
| Close the sheet | ✅ 2026-08-27 — "Sign-in was cancelled."; button re-enabled; stderr `sign-in failed: cancelled` |
| Sign in with a `@edtools.psd401.net` student account | ✅ 2026-08-29 — real Google account `<demo-student-A>@edtools.psd401.net` (a PowerSchool demo student, seeded into the local dev roster's section 5001 — see "2026-08-29 student-account run" below): the sheet closed, status "Signed in as <demo-student-A>@edtools.psd401.net", code field enabled; stderr `sign-in: session minted for role student` → `signed in as role student` → `my-sittings: 1 row(s)`; server `POST /api/auth/exchange 200`. Quit + relaunch came up signed in with the email, no sheet, straight to `my-sittings: 1 row(s)` (Keychain JWT) |
| Sign in with a `@psd401.net` staff account | ✅ 2026-08-27 — "Signed in as <email>", code field enabled; server log `POST /api/auth/exchange 200`, client log `session minted for role staff`. (The 403 at join not yet tried.) |
| Sign in with a personal Gmail account | ⚠️ 2026-08-27 — **Google refused it first**: the sheet showed "Access blocked: Peninsula School District Applications can only be used within its organization" (consent screen is Internal), closing it logged `sign-in failed: cancelled`. Our own "That Google account cannot be used here…" path never ran and stays unverified; the outcome is stricter, not weaker |
| Student account, Workspace has NOT trusted the app | ✅ 2026-08-29 — **did not occur**: the Internal consent screen admits the `edtools.psd401.net` secondary domain; no admin-approval page, no `access_denied`, on either of two student accounts. ADR 0017 "Depends on" #2 is answered YES. The refusal path itself therefore stays unobserved (as with the Gmail row: Google's own block is the stricter outcome) |
| Quit, relaunch | ✅ 2026-08-27 — Still signed in, no sheet; Join with the staff session then failed with the expected 403 ("tell your teacher" message; stderr `join failed: refused(status: 403 …)`). **But** the status read "Signed in" without the email — fixed in code the same day (email now read from the stored JWT's claims); re-run verified below |
| Quit, relaunch after the fix above | ✅ 2026-08-27 — "Signed in as <email>" with only the Keychain JWT to read it from; the email now comes from the stored session JWT's claims, not the exchange response. (First attempt showed no email because a stale pre-fix binary from another checkout was launched — three DerivedData builds existed; check the build path before concluding a regression) |
| Sign out | ✅ 2026-08-27 — Button back to "Sign in with Google"; code field disabled; stderr `signed out`; a relaunch after signing out came up signed-out (Keychain cleared) |
| Sign in as student A, sign out, sign in as student B | ✅ 2026-08-29 — A = `<demo-student-A>@…` (had already joined + handed in), Sign out → stderr `signed out`, button back to "Sign in with Google"; sign in as B = `<demo-student-B>@…` → the sheet again (ephemeral session: no silent reuse of A), `session minted for role student` (second `POST /api/auth/exchange 200`), `my-sittings: 1 row(s)`; B then joined the same sitting and got its own attempt `d90e2ac3…` (A's `ae4bca27…` stayed submitted) |

## Sign-in re-run (UX pass 2 slice 9 — WKWebView presenter) — ALL ROWS CLOSED 2026-08-31

**Decision (James, 2026-08-31): sign-in failures return silently to the
sign-in prompt.** Every failure path lands back on "Sign in with your school
Google account first." because `refreshSignInState()` overwrites the status
label after `startSignIn`'s error copy is set — reviewed and kept as-is: for
a cancel it is the better message, and for real failures "try again / tell
your teacher" is what happens anyway; diagnostics stay in stderr. Cost
accepted: the dedicated `account_not_allowed` copy never shows — a
wrong-account loop would be silent on screen. If that surfaces in the pilot,
the fix is reordering the two statements in
`SessionEntryViewController.startSignIn`.

The ✅ rows above describe the retired system sheet
(`ASWebAuthenticationSession`). Slice 9 replaced it with our own sheet — a
plain `WKWebView` on `WKWebsiteDataStore.nonPersistent()`, fresh per attempt
(`WebViewAuthPresenter`) — because a lingering Google session in the
AuthenticationServices daemon's store survived `prompt=login` and every
ephemeral setting. The rows below re-verify the surface on the new presenter.
Launch as for slice 80 (or `client/scripts/launch-client.ts`).

**Row 1 is the gate for the whole slice**: Google refuses OAuth in web views
it recognises as embedded ("disallowed_useragent" / "this browser or app may
not be secure"), keyed on the user agent; the presenter ships a Safari-shaped
`applicationNameForUserAgent` to avoid that. If row 1 fails, stop — the slice
reverts in one commit and the fallback (system browser + loopback redirect)
becomes its own proposal.

**2026-08-31 (James):** one launch of the freshly built app (the real code is
in `SecureTest.debug.dylib` — the outer binary is Xcode's launcher stub, so
verify a build by grepping the dylib, not `Contents/MacOS/SecureTest`),
local dev server, real Google accounts `<demo-student-C>@…` and `<demo-student-B>@…`. Full
stderr in `~/securetest-student.log`.

| Check | Expected |
|---|---|
| Click Sign in | ✅ 2026-08-31 — **Gate row PASSED**: our sheet opened on Google's real sign-in page; no "disallowed_useragent" / "this browser or app may not be secure" on any of four authorize round-trips. The Safari-shaped UA holds (for now — Google-side detection can still tighten) |
| Cancel button; Esc | ✅ 2026-08-31 — twice: sheet closed, button re-enabled, stderr `sign-in failed: cancelled` ×2. (The "Sign-in was cancelled." copy does NOT appear on screen — the refresh prompt replaces it; per the decision above that's the intended message) |
| Student sign-in | ✅ 2026-08-31 — `<demo-student-C>@…`: email AND password demanded (James), sheet closed, stderr `session minted for role student`; every authorize line shows `prompt=login` by value |
| Sign out → Sign in again, same app run | ✅ 2026-08-31 — covered by the A→B run below: after `signed out`, the next Sign in went through a full fresh authorize with credentials demanded — no chooser pre-filled, no one-click account |
| Sign out, quit, relaunch, sign in | ✅ 2026-08-31 (in-memory build) — relaunch came up signed out (no purge line: the sign-out had already cleared the legacy row); sign-in as `<demo-student-A>@…` demanded full credentials. **The sign-in traversed Google → ClassLink SSO + MFA entirely inside the sheet and completed** — evidence for the no-hostname-allowlist policy (a Google-only list would have broken PSD sign-in), and it means students hit ClassLink + MFA at every launch now, accepted under 1.1 |
| Quit + relaunch while signed in | ~~Still signed in from the Keychain, no sheet~~ ✅ 2026-08-31 on the Keychain build (relaunch fetched sittings straight away, no authorize line) — then **SUPERSEDED the same day**: James decided a fresh sign-in must be forced every launch, so the session store went in-memory (`InMemoryTokenStore`; `KeychainTokenStore` deleted, legacy row purged at startup). New expectation: relaunch comes up **signed out**, sign-in demanded — see the row below |
| Quit + relaunch while signed in (in-memory store) | ✅ 2026-08-31 — signed in as `<demo-student-A>@…` at quit; relaunch came up **signed out** (stderr: no sittings fetch, no authorize line, no seeded token). James confirmed "Sign in with Google" on screen. The `legacy keychain session token purged` line stays unobserved (every quit so far followed a sign-out, which had already cleared the row) — it needs a Mac that quit an OLD build while signed in |
| A signs in, signs out; B signs in | ✅ 2026-08-31 — A = `<demo-student-C>@…` signed out (`signed out`), B = `<demo-student-B>@…` minted on its own fresh authorize (`session minted for role student` again); credentials demanded both times (James); no trace of A in B's flow |
| Cmd-Q with the sheet open | ❌ 2026-08-31 — beeped on every sign-in page (Google, ClassLink, MFA); James had to complete sign-in to reach a screen where Cmd-Q worked. Cause: with the sheet's WKWebView as first responder, WebKit consumes Cmd-key equivalents ahead of the main menu (same family as the Cmd-E beep finding), so the nil-target Quit item never fires. **FIXED same day**: `AuthSheetWindow.performKeyEquivalent` catches Cmd-Q before the web view → cancels the sheet → `NSApp.terminate(nil)` (the lockdown guard in `applicationShouldTerminate` still runs). Re-test ✅ 2026-08-31 — quit cleanly from the open sheet (James); relaunch came up signed out |
| Cmd-V into Google's password field | ✅ 2026-08-31 — pasted (James), during the `<demo-student-A>@…` sign-in |
| Staff account with 2FA/passkey | ✅ 2026-08-31 — James signed in with MFA completing inside the sheet. **No passkeys are tied to PSD Google accounts**, so the WKWebView no-platform-authenticator risk is moot for this district. (Student sign-ins also traverse ClassLink + MFA — second-factor rendering is exercised on every flow) |
| (optional) `kill -9` the SecureTest "Web Content" process mid-sheet | ✅ 2026-08-31 — killed the sheet's WebContent process (identified by PID diff against a pre-sheet snapshot): sheet closed, app survived, button re-enabled, stderr `sign-in failed: webContentProcessTerminated`. On screen the app returns to the sign-in prompt (the "Could not sign in" copy is replaced by the refresh prompt — the decision above) |

## "Your tests" list (slice 84) — needs a window server and the dev roster

The list logic (`MySittings` decoding, `SittingRowModel` states and wording,
the authenticated GET) is covered by `swift test`; the wire shape was also
checked live against the dev server's seeded roster with a minted student JWT
(2026-08-27). What needs eyes is the layout and the join-from-row flow:

```bash
SECURE_TEST_TOKEN=$(cat dev-student-token.txt) SECURE_TEST_SERVER=http://localhost:3000 \
  ./SecureTest.app/Contents/MacOS/SecureTest
```

| Check | Expected |
|---|---|
| Launch signed in as a rostered student | ✅ 2026-08-27 (Ada Fixture, minted JWT, seeded dev roster) — "Your tests" lists their open sittings, newest first; stderr `my-sittings: 1 row(s)` |
| Row content | ✅ 2026-08-27 — Assessment name; section label (or scope wording) — teacher email · "closes <time>". **Since 10.5 (2026-08-29) the detail leads with the sitting code**: ✅ 2026-08-29 (screen capture) — `DBXQVU · Assigned to you — <the lead teacher's email, truncated>…`, "Done ✓" at right. **Layout note:** the 250-px detail now truncates the teacher and drops "closes <time>" on this row; the code survives (the point), the expiry does not — a second line or a wider row is a UX-pass-1 item |
| Row with no attempt | ✅ 2026-08-27 — **Join** landed in the assessment with no code typed (5-item seed, code 82X6S4 never entered) |
| Row with an in-progress attempt | ✅ 2026-08-27 — **Resume** resumed the same attempt id (stderr `joined listed sitting … (resumed)`). The first run stalled on the loading message — at first blamed on the assessment having 0 items, actually the one-shot navigation bug below; re-run after the fix with a 5-item assessment |
| After Join/Resume, the items render | ✅ 2026-08-27 — all 5 seed items rendered, were answerable and handed in. The `.server` path loads the web view TWICE (the "Loading your test…" notice, then the real page); the original one-navigation-only lock cancelled the second load, so every server-delivered test came up blank or stuck on the notice (found 2026-08-27, first time eyes were on a server-delivered bundle). Fixed by counting host-issued loads (`pendingHostLoads`); page-initiated navigation is refused exactly as before |
| Row with a submitted attempt | ✅ 2026-08-27 — after answering all 5 items and handing in, the relaunched list showed "Done ✓", no button; the wire carried `submitted` |
| Handed in through a sitting that has since closed; teacher opens a new one (10.2) | The new sitting's row reads "Done ✓", no button (server resolves by assessment now). ✅ 2026-08-29 — <demo-student-A> (submitted in `NBVC8P`, closed) signed in with sitting `DBXQVU` open on the same assessment: the row read "Done ✓", no button; the dev server had hot-reloaded `mySittings.ts` |
| Join a test already handed in, against a server WITHOUT 10.2 (or by code) (10.1) | Status reads "You already handed this test in.", the app stays on "Your tests", the list re-reads; stderr `join declined: attempt … is already submitted — staying on the entry screen` and NO `lockdown begin() called`; no new attempt, no events on the server. Same by typing the sitting's code: ✅ 2026-08-29 — typed `DBXQVU` (the row had no button): status "You already handed this test in.", still on "Your tests"; stderr `join declined: attempt ae4bca27… at sitting 6356e844… is already submitted — staying on the entry screen` then `my-sittings: 1 row(s)`, no `lockdown begin() called`; server `redeem 200` → `POST /api/attempts 200` → list; attempts still 2, the submitted one untouched |
| Refresh button | ✅ 2026-08-27 — teacher closed the open sitting from the Sittings tab; Refresh dropped it (stderr `my-sittings: 2 row(s)` → `1 row(s)`) |
| Signed in with an account problem (e.g. not on roster) | Empty list with the reason in a student's words ("You are not on the list…") |
| Staff account | List area says "No test list for this account."; the code field still works |
| Code field | Still joins an ad-hoc sitting by code exactly as before |

## Lockdown lifecycle (AAC-1, simulated session) — needs an open sitting

The session is SIMULATED — nothing actually locks — until the entitlement and
the `AEAssessmentSession` adapter land (AAC-2). What these rows verify is the
lifecycle the real session will inherit: begin on bundle load, every exit
path, and the failure modes, produced on demand with
`SECURE_TEST_SIMULATE_LOCKDOWN=cooperative|refuses|hangs|interrupts`. The
watchdog defaults to 600s (testing posture); `SECURE_TEST_WATCHDOG_SECONDS`
overrides. All state transitions log to stderr as `[security] lockdown: …`.

All nine rows were hand-run 2026-08-27 evening (James at the keyboard, the
session's Claude driving launches and verifying stderr + `attempt_events`
rows after each; dev server local, Ben Sample via a minted student JWT,
sitting 82X6S4 on the 5-item seed assessment).

| Check | Expected |
|---|---|
| Join a server-delivered test | ✅ 2026-08-27 — Titlebar shows "secure session active" + "End secure session"; stderr `lockdown begin() called` then `lockdown DID BEGIN` (observed on every server run) |
| Open the offline `--bundle` path | ✅ 2026-08-27 — No lockdown, no titlebar controls; 8-item fixture rendered, six item types answered, `drawing ignored: no server session` / `submit ignored: no server session`; zero rows in `attempt_events`. First attempt failed on the sandbox/argv issue documented above |
| Hand in | ✅ 2026-08-27 — all 5 items answered, `attempt … handed in`, `lockdown ending: hand-in confirmed`, `DID END`; controls disappeared; attempt `submitted` in the DB |
| Cmd-Q mid-attempt | ✅ 2026-08-27 — `quit requested with lockdown active — ending the session first`, session confirmed, app exited; decision 2.1. The quit event was delivered (slice-92 rows below) |
| "End secure session" button | ✅ 2026-08-27 — session ended, attempt kept going unlocked, `emergency end control pressed` logged |
| `SECURE_TEST_WATCHDOG_SECONDS=15`, join, wait | ✅ 2026-08-27 — countdown in the titlebar; `WATCHDOG: 15s elapsed — ending lockdown` exactly 15 s after begin (DB timestamps 20:09:50 → 20:10:05); session auto-ended, app stayed up unlocked |
| `SECURE_TEST_SIMULATE_LOCKDOWN=hangs`, join, Cmd-Q | ✅ 2026-08-27 — `end() called`, 5 s of silence, `did not confirm within 5s — unrecoverable`, app EXITED rather than hanging. The row that mattered most |
| `SECURE_TEST_SIMULATE_LOCKDOWN=refuses`, join | ✅ 2026-08-27 — `lockdown FAILED TO BEGIN — simulated refusal`; the test rendered and was answerable; no titlebar controls |
| `SECURE_TEST_SIMULATE_LOCKDOWN=interrupts`, join | ✅ 2026-08-27 — began then dropped (`lockdown INTERRUPTED`); titlebar controls disappeared |

## Event reporting to the teacher monitor (slice 92) — needs the dev server + an open sitting

The client now posts quit / emergency-exit / focus / lockdown-lifecycle
events to `POST /api/attempts/:attemptId/events` (contract:
`docs/phase-7-slices.md`, "Client contract for slice 91"). Fire-and-forget:
a failed post logs `[security] event <kind> not delivered` and is dropped —
it must never delay an exit. Verify against the teacher's monitor page
(`/dashboard/<id>/monitor/<sittingId>`) or the Sittings tab, polling every
5 s. The mapping and request shape are covered by `swift test`; these rows
are the end-to-end sighting.

Hand-run 2026-08-27 evening alongside the lockdown rows (same runs, monitor
page watched in the browser). One accepted limitation surfaced (decision
7.1 with James, 2026-08-27): **a quit while the app is UNLOCKED loses its
event** — `.terminateNow` ends the process before the fire-and-forget post
leaves (observed 3 of 3 times). A quit while locked is delivered by the
teardown grace window. Accepted as within the documented best-effort
contract; a bounded pre-exit head start is a deferred improvement.

| Check | Expected |
|---|---|
| Join a server-delivered test | ✅ 2026-08-27 — "Last event: Lockdown started" on the card; no red pill |
| Click another app, then click back | ✅ 2026-08-27 — red "Left the test window" pill; cleared on regain (three loss/regain pairs in the DB, all matched). Also observed live: while the app sat unfocused, the pill correctly stayed; one click back cleared it and the alert fell back to the older sticky pill |
| "End secure session" button | ✅ 2026-08-27 — red "Emergency exit" pill; STAYED through a later focus loss/regain pair (sticky, `{via: "button"}` in the DB) |
| `SECURE_TEST_WATCHDOG_SECONDS=15`, join, wait | ✅ 2026-08-27 — "Emergency exit" pill with `{via: "watchdog"}`, then "Last event: Lockdown ended" |
| Cmd-Q mid-attempt | ✅ 2026-08-27 — `quit {via: terminate}` landed (grace window); red "Quit the app" pill. First sighting needed a browser refresh; later runs arrived on the 5 s poll unaided — watch item, not reproduced |
| Hand in, then Cmd-Q | ✅ 2026-08-27 — teardown's `lockdown_end` accepted on the already-`submitted` attempt (10 ms race, decision 2.1 proven); post-hand-in focus changes and quit produced zero events |
| Kill the dev server, click away and back | Not run — the dev server hosted the monitor being watched. The drop path is covered by `swift test` (reporter logs and swallows a refusal); the live sighting stays open |

## Real AAC session (AAC-2a) — THE MAC LOCKS. Read before running.

The entitled build begins a real `AEAssessmentSession` on join (stderr says
`lockdown session: REAL AEAssessmentSession (entitled binary)` — if it says
SIMULATED, you are not testing AAC; check `codesign -d --entitlements -` on
the binary you actually launched, and remember the stale-binary gotcha).
Nothing outside the app can rescue a stuck session, so before the first run:
know that the watchdog is 600 s by default (`SECURE_TEST_WATCHDOG_SECONDS=60`
is a sane first-run override) and that the exits below were each verified in
a REAL session by PoC-A (RESULTS #12) — but this binary's wiring of them has
not been until these rows pass. `SECURE_TEST_SIMULATE_LOCKDOWN=cooperative`
forces the simulation on the entitled build if you need a no-lock rehearsal.

Hand-run 2026-08-27 night (James at the keyboard, the session driving
launches and verifying stderr + `attempt_events` after each; four real
sessions on his Mac, macOS 26.6.2, development-signed against PoC-A's App ID).

| Check | Expected |
|---|---|
| Join a server-delivered test (short watchdog first run) | ✅ 2026-08-27 — stderr `lockdown session: REAL AEAssessmentSession (entitled binary)`, framework `DID BEGIN`; the Mac visibly locked |
| "End secure session" button | ✅ 2026-08-27 — the Mac came back (~2.7 s from `end()` to the framework's `DID END` — the real session takes a beat the simulation doesn't); events landed. **Design fact observed:** the attempt stays on screen UNLOCKED afterward and can be handed in — decision 2.3 (the button ends the SESSION, not the attempt). There is NO re-lock mid-attempt; the only way back into lockdown is quit-and-rejoin. Recorded in phase-7 "Hand-run findings" |
| Cmd-Q mid-session | ✅ 2026-08-27 — session ended first (real `DID END`), app quit, Mac back; `quit {via: terminate}` pill delivered. The teardown's `lockdown_end` post lost the exit race this once (quit won the grace window) — same best-effort contract, noted |
| Watchdog at zero | ✅ 2026-08-27 — 60 s override; `WATCHDOG: 60s elapsed`, real `DID END` ~3 s later, the Mac came back with no input; `emergency_exit {via: watchdog}` + `lockdown_end` landed |
| Hand in (while locked) | ✅ 2026-08-27 — `handed in` → `lockdown ending: hand-in confirmed` → real `DID END`; Mac back on the teardown |
| Cmd-Tab / Mission Control / Dock / Spotlight | ✅ 2026-08-27 — all non-functional inside the session (PoC-A finding #15's pattern, now in the shipping client) |
| Cmd-Shift-3 / 4 / 5 (screenshot keys) | ✅ 2026-08-27 — all three beeped (suppressed). (Header note: `allowsScreenshots` governs the CLIPBOARD variants Cmd-Ctrl-Shift-3/4 — untested, and we ship it off anyway) |
| Hardware function keys (Mission Control / Spotlight row) | Covered by the row above (the features they invoke were dead); a per-key pass is still open. **Spotlight nuance** (2026-08-27): Cmd-Space silently OPENED Spotlight in the background — invisible and unusable while locked, revealed only after the app quit. Finding #15's pattern (AAC gates visibility, not invocation); not an escape |
| Dictation key | ❌ 2026-08-27 — **dictation was ACTIVE inside the real session, and AAC on macOS CANNOT close it**: `allowsDictation` is `API_UNAVAILABLE(macos)` in the framework headers (iOS-only; verified in the 26.x SDK after a pin attempt failed to compile). Platform gap, not a configuration miss. Re-verified same night in a dictation-only run on the final binary: text landed in a short-text field mid-session. Mitigation: Jamf configuration profile disabling dictation on the test fleet, with per-student exceptions where speech-to-text is an entitled accommodation — added to the IT conversation list. Re-test after each macOS release (the PoC-A regression harness) in case Apple adds the flag |
| Monitor pills during a real session | ✅ 2026-08-27 — same slice-92 pills as the simulated runs; no focus events while locked (their absence is itself the check) |
| `SECURE_TEST_SIMULATE_LOCKDOWN=cooperative` on the entitled build | Not run this night — the override path is exercised by every simulated run; a one-line sighting on the entitled build stays open |

## Accommodations → session config (AAC-2b) — needs a student granted them

The mapping itself is `swift test` territory (`LockdownConfigurationPlanTests`
— which catalog ids open which knobs, everything else restrictive). What only
a hand-run can show is the OS honouring the opened knob inside a REAL
session. Two facts shape these rows: the knobs ALLOW, they don't enable — the
matching macOS Setting must already be on (spell check / predictive text
under Keyboard, Live Captions under Accessibility) — and the effective set is
resolved server-side, so the student must actually be granted the tool
(assessment's allowed list + the student overlay) before the bundle carries
it. Every begin logs `[security] lockdown config plan: spellCheck=…
predictiveKeyboard=… liveCaptions=…` for real AND simulated backings — read
it before trusting any row below.

Dev seed for this run (2026-08-28, dev DB): the seed assessment 9dacd281
("Your tests seed", has the short_text item) now allows all three tools, and
**Ben Sample is granted all three** (`student_accommodations`, subject ELA,
value On, source manual — verified through `resolveEffectiveAccommodations`:
Ben all three, Ada none). Sitting **ACC2BG** (open, 7 days) serves both runs
on identical content: Ben joins it → resumes his in_progress attempt →
plan all true; **Ada joins the same sitting as the ungranted control** →
plan all false (her fabricated submitted attempt was deleted 2026-08-28 so
she can rejoin — dev-seed reset, the 82X6S4 monitor evidence stands in the
docs). Mint her JWT the same way as Ben's (`scripts/smoke-sign.mjs`).

Hand-run 2026-08-28 (James at the keyboard, this session driving launches and
reading stderr; two real sessions as Ben on his Mac, macOS Settings for spell
check / predictive text / Live Captions all on). Headline: **the AAC-2b
wiring verified end-to-end (bundle → plan → real session config), but three
of four observable-effect rows are blocked OUTSIDE the slice — two by the
app's own web view, one by the OS baseline.** An essay item was seeded onto
the assessment mid-run (the short_text field hardcodes `spellcheck=false` by
design — first run had no surface that could ever show a squiggle).

| Check | Expected |
|---|---|
| Plan log line on any join (simulated is fine) | ✅ 2026-08-28 — the full A/B on one sitting (ACC2BG), one binary, three real sessions: both Ben runs logged `lockdown config plan: spellCheck=true predictiveKeyboard=true liveCaptions=true`, Ada's control run logged all three `false` on a fresh attempt (f0196afe) — each followed by `REAL AEAssessmentSession` + `DID BEGIN`, each matching its server-resolved bundle exactly |
| Real session, `spell_check` granted | ✅ 2026-08-28 (probe) — the 3.1 spike found WebKit's TextCheckerMac.mm reads `boolForKey:WebContinuousSpellCheckingEnabled` (absent = NO; only Safari sets it), which is why the first runs showed nothing locked OR unlocked. Launching the unmodified binary with `-WebContinuousSpellCheckingEnabled YES` (argument domain) produced **squiggles in the essay INSIDE a real session** — mechanism and the AAC `allowsSpellCheck=true` knob proven in one run. Fix landed as `registerDefaults` in 3.1 (`b1a37ce`) and **✅ CONFIRMED same night on the built binary, no launch args** — squiggles in the essay AND (3.3) the short_text field inside a real session as Ben |
| Real session, NO `spell_check` | ✅ 2026-08-28 — Ada (ungranted) on the same sitting, same built binary: plan logged all false, real session began, **no squiggles in essay or short_text** despite the checker being on — the per-student `spellcheck` attribute is the gate, exactly as designed |
| Real session, `word_completion` granted | ❌ 2026-08-28 evening — FAILED with both knobs open: a high-probability phrase typed inside a real session, plan `predictiveKeyboard=true`, binary carries `allowsInlinePredictions = true` — no inline prediction appeared. Something else still gates predictions in the WKWebView (candidates: the `writingsuggestions` attribute, per-field heuristics, the OS prediction model). Investigation queued (8.4) |
| Real session, `closed_captioning` granted | ⏸ 2026-08-28 (updated same night) — OS baseline now ESTABLISHED: Live Captions works outside the app, but it does not caption dictation input, so the in-session row needs an **audio stimulus** (an item with audio, or another in-app sound source) to have anything to transcribe — the seed assessment has none. Rolled into the next client test round together with the word_completion prediction retry |

Observations, not conclusions (2026-08-28): dictation was inconsistent
across the night's three sessions — run 1b: UI opened, mic never engaged;
unlocked afterwards: mic worked, text landed (James suspects an unrelated OS
setting); Ada's run: menu appeared but dictation never activated within the
app. The 2026-08-27 platform-gap row (dictation ACTIVE in-session, text
landed) stands as the worst case, which is the one that matters — the Jamf
mitigation is unchanged. Run 1's Cmd-Q left no `quit` line in stderr — the
documented quit-after-unlock best-effort loss (7.1), the session having
already been ended by the button.

## On-demand peek (P2/P4) — needs the dev server; the real-session row THE MAC LOCKS

P2 wires the client: a 5 s poll (`PeekResponder`, swift-test-covered) for a
pending teacher request; on pickup the banner shows BEFORE anything is
rendered, the app renders ITSELF (`cacheDisplay` — PoC-A finding #14's
mechanism, no screen capture, no TCC), downscales to ≤1280 px JPEG and
uploads fire-and-forget. Until P3's monitor button exists, the teacher side
can be driven with curl (staff cookie): `POST /api/attempts/:id/peek` then
`GET /api/attempts/:id/peek/image`.

Hand-run 2026-08-28 evening (James at the keyboard and in the browser, this
session driving launches, the dev server, and DB/stderr verification; real
sessions on his Mac, single machine for both roles — the locked-peek
choreography below exists because the browser is invisible behind the
lockdown). All seven rows ✅.

| Check | Expected |
|---|---|
| Peek during a REAL locked session | ✅ 2026-08-28 — single-Mac choreography: Peek clicked in the browser FIRST, then join within the 30 s pending window. stderr proves the cycle ran entirely inside the session: `DID BEGIN` → `peek requested by teacher` → `peek image delivered` → `DID END`; the modal held the locked screen with full content INCLUDING the banner — finding #14 on the shipping client, the load-bearing row |
| Banner order + sticky notice | ✅ 2026-08-28 — banner at pickup, before the upload; sticky "viewed at H:MM" observed persisting. **Feedback (8.1): James wants the student able to DISMISS the sticky notice** — BUILT 2026-08-28 (`fcdcea1`, × `0c99de0`); rows in "2026-08-28 workflow round" |
| Peek while unlocked (after "End secure session") | ✅ 2026-08-28 — two full cycles (requested → delivered ~4 s → viewed) with the Mac unlocked; decision 6.2 confirmed in practice |
| After hand-in | ✅ 2026-08-28 — better than written: the Peek button is gated to in-progress rows, so it simply disappears from the submitted card; the 409 path stays covered by the server tests |
| Dead server mid-attempt | ✅ 2026-08-28 — listener killed ~16 s (3+ ticks): exactly ONE `peek poll failing (logged once until it recovers)` line; restart: exactly one `peek poll recovered`; the app never blinked |
| Delete-on-read observed | ✅ 2026-08-28 — DB row after the collect: `viewed_at` stamped 1.1 s after delivery, `image_base64` NULL, `requested_by` + all three timestamps intact as audit |
| Rate limit | ✅ 2026-08-28 — second click showed "Just requested — give it a few seconds." |

## File → Open Test Bundle… (offline) — needs a window server

The open panel lands on the same offline `.file` path as `--bundle`: no
attempt, no event reporter, no lockdown, `drawing ignored` / `submit ignored`
in stderr. The rules the panel runs on — which file type it offers, when the
menu item is enabled, what a pick decodes into — are `OfflineBundle` in Core
and covered by `swift test` (`OfflineBundleTests`, 11 tests); the rows here
are the AppKit half. The item is pinned by `isEnabled` with autoenabling off,
so a greyed item is the rule holding, not AppKit's guess.

Launch with no arguments; the fixture is
`SecureTestCore/Tests/SecureTestCoreTests/Fixtures/delivery-bundle.json` and
needs NO copy into the container.

Hand-run 2026-08-28 evening, same round as the peek rows (one binary, the
post-merge build). All rows ✅ except the two noted.

| Check | Expected |
|---|---|
| File menu on the entry screen | ✅ 2026-08-28 — present, enabled, Cmd-O |
| Cmd-O / the item on the entry screen | ✅ 2026-08-28 — sheet dropped; the filter refused selection of non-`.json` files |
| Pick the fixture from the repo (no container copy) | ✅ 2026-08-28 — 8-item fixture rendered straight from the repo path; stderr `open test bundle:` + `bundle source:` + `bundle loaded: 8 items`; zero lockdown lines, no titlebar controls |
| Answer items, draw, hand in on the opened bundle | ✅ 2026-08-28 — `drawing ignored: no server session` (×2), `submit ignored: no server session`. **Cosmetic finding (8.5): the page's status labels stick at "saving…" / "handing in…"** — the ignore is deliberate but the label never resolves, and it persists across a later sheet |
| Cancel the sheet | ✅ 2026-08-28 — `open test bundle: cancelled`, screen unchanged |
| Cmd-O again over an opened bundle | ✅ 2026-08-28 — sample-delivery picked, replaced the fixture (`bundle loaded: 8 items, test_id=2a4bd69d…`) |
| Pick a `.json` that is not a bundle (e.g. any `package.json`) | ✅ 2026-08-28 — notice shown; stderr `BUNDLE REJECTED: DecodingError.keyNotFound … "test_id"` |
| Join a server-delivered sitting (simulated lockdown is fine) | ✅ 2026-08-28 — greyed; Cmd-O beeps; no `open test bundle` line (run against a REAL session) |
| Press "End secure session", then Cmd-O | ✅ 2026-08-28 — still greyed (beep) with the attempt unlocked on screen |
| Hand in, then Cmd-O | ✅ 2026-08-28 — still greyed (beep) on the done screen |
| Join with a code, then Cmd-O before the join lands, then pick | Not provoked (expected — the sheet blocks the window); the documented no-show, not a failure |
| `--bundle` from the container (the recipe at the top) | Not re-run this round; last verified 2026-08-27. The open-panel path is now the primary way in |

## 2026-08-28 workflow round — rows pending a hand-run

Built on branches by the workflow (`docs/phase-7-slices.md` "Workflow
round"), merged the same night. Server/Core logic is under `swift test` /
`bun test`; these rows are the AppKit/WebKit surface and the real framework.

### 8.3 — an exit requested while the session is STARTING

| Check | Expected | Status |
|---|---|---|
| Rehearsal on any Mac: `SECURE_TEST_SIMULATE_LOCKDOWN=slow`, join, Cmd-Q (or Cmd-E) within the 2 s before `DID BEGIN` | stderr: `[security] lockdown: lockdown end() requested while STARTING — deferred until DID BEGIN (finding 8.3)` → `DID BEGIN` → `... DID BEGIN with an end deferred — issuing the physical end() now (finding 8.3)` → `DID END`; the app quits cleanly, NO `did not confirm within 5s — unrecoverable`, NO exit code 70 | ✅ 2026-08-28 (re-run, James at the keyboard, this session launching the fresh Debug build and reading stderr) — exact sequence: `quit requested with lockdown active — ending the session first` → `end() called` → `end() requested while STARTING — deferred until DID BEGIN (finding 8.3)` → `DID BEGIN` → `DID BEGIN with an end deferred — issuing the physical end() now (finding 8.3)` → `DID END`; exit code 0, no grace-expiry line. A second `quit requested…` line appeared before `DID BEGIN` (a repeated Cmd-Q): `endBeforeTeardown`'s `teardownCompletion` guard made it a no-op — exactly one `end() called` |
| Same, inside a REAL `AEAssessmentSession` (THE MAC LOCKS): Cmd-Q within ~1 s of the session starting | Same stderr sequence; the Mac is released by the deferred `end()`, not by the backstop. If `DID END` never comes and the backstop exits with 70, finding 9.3 applies (re-entrant `end()` inside the delegate callback) | ✅ 2026-08-28 — `lockdown session: REAL AEAssessmentSession (entitled binary)`, the Mac locked, Cmd-Q inside the STARTING window: the identical deferred sequence, real `DID END`, exit code 0, Mac released by the deferred `end()` — no backstop, no 70. **The re-entrant `end()` from inside `didBegin` is NOT dropped by the framework → 9.3 closed, no main-queue hop needed.** Same repeated-Cmd-Q no-op observed. (A first take quit at the entry screen before Join — no `begin()` in stderr — and was simply re-run) |
| `slow` rehearsal, no quit | `DID BEGIN` arrives ~2 s after join; the session is normal from there; hand-in ends it | ✅ 2026-08-28 — on a throwaway sitting (`RW3QT7`, a clone of the seed assessment, so the Keychain identity's standing ACC2BG attempt stayed in_progress — the Keychain JWT was Ada Fixture's all night, not Ben's; Ben's AAC-2b fixture attempt was never touched): `begin() called` → `DID BEGIN` with no deferral line → three `response:` lines → `handed in` → `lockdown ending: hand-in confirmed` → `end() called` → `DID END`; exit 0; attempt `submitted` with 3 responses. Side note: a first code containing an O was refused by both sides (client copy, then server `400 malformed_code`) — the alphabet excludes O/I/L/0/1 by design |

### 8.1 — dismissable peek notice

| Check | Expected | Status |
|---|---|---|
| Dismiss the peek notice | After a peek's "Your teacher viewed your screen at H:MM" strip appears, click the × at its right edge: the strip disappears, the test page is undisturbed and keyboard focus stays in the page (keep typing in a short-text item without re-clicking). Nothing new in stderr, no new DB row | ✅ 2026-08-28 (James at the keyboard + browser, simulated lockdown, Ada on ACC2BG) — James: strip dismissed, page undisturbed, typing continued without a re-click. Verified here: stderr shows only `peek requested by teacher (3ccff38a…)` → `peek image delivered`, nothing for the ×; `attempt_events` between the two peeks are the focus_loss/focus_regained pair from switching to the browser, nothing else; `peek_requests` +1 for the peek, +0 for the dismiss; `viewed_at` stamped 0.3 s after delivery, image NULL |
| A later peek re-discloses after dismissal | With the strip dismissed, Peek again from the monitor: "Your teacher is viewing your screen" shows again at pickup, flips to a fresh "viewed at H:MM", and the teacher's modal shows the strip in the frame (the finding-#14 render paints the new `PeekBannerView`). × works again | ✅ 2026-08-28 — James: the "viewing" strip re-appeared, flipped to a fresh "viewed at", the modal image carried the strip, × worked again. Verified here: second `peek requested by teacher (59753c37…)` → `peek image delivered` 5 s later, `viewed_at` stamped, image NULL; clean Cmd-Q afterwards (`DID END`, exit 0) |

### 8.5 — the offline page tells the offline truth

| Check | Expected | Status |
|---|---|---|
| Standing notice | Open a bundle via `--bundle` or File → Open Test Bundle…: an amber "Offline mode: answers are not saved to a server." box sits under the title, above the first item. A server-delivered attempt shows no such box | ✅ 2026-08-29 — Cmd-O on the repo fixture (`bundle loaded: 8 items`), amber box present; the server-delivered attempts the same night showed none |
| Offline labels resolve | Same bundle: draw on the drawing item, Save drawing → "Offline mode: not saved to a server." (not "Saving…"); Finish and hand in → "Finished. Offline mode: nothing was sent to a server.", button stays disabled; stderr still shows `drawing ignored: no server session` / `submit ignored: no server session`; Cmd-O → Cancel leaves those labels as-is, no stale "Saving…" / "Handing in…" | ✅ 2026-08-29 — all three labels as written; stderr `drawing ignored: no server session`, `submit ignored: no server session`, `open test bundle: cancelled`; zero lockdown lines |
| Server labels unchanged | On a server-delivered attempt: Save drawing → "Saving…" then "Saved."; Finish → "Handing in…" then "Handed in. You can close the app."; a failed hand-in still shows "Could not hand in. Tell your teacher." with the button re-enabled | ⚠️ 2026-08-29 — labels read "Saving…" → "Saved." and "Handing in…" → "Handed in…" as written (one-item drawing assessment, sitting `AJ8XVZ`, <demo-student-C>, real session), **but "Saved." was false**: with `STORAGE_PROVIDER=s3` the presigned upload landed in S3 (12,845 B) while the slot stayed `pending`, the response PUT got `409 upload_incomplete`, the spool dropped it as permanent (the new 10.1 line fired: `responses DROPPED: 1`), and the attempt was handed in with 0 responses. Finding 10.10. The failed-hand-in variant was seen for real earlier tonight on Aurora (DNS outage) |
| Server labels on S3 storage AFTER the 10.10 fix | Save drawing → "Saving…" → "Saved." with the response actually stored: server `PUT …/responses/<item> 200` (no 409), the slot `complete`, `responses` row present; stderr has NO `responses DROPPED` line; Finish → "Handed in…" with 1 response on the attempt: ✅ 2026-08-29 — sitting `5CXRZP`, <demo-student-C>, real session. Inside the session the settle HEAD hit finding 10.7 (`ENOTFOUND …s3.us-west-2.amazonaws.com` from the dev server) → `PUT 500` ×5, spool KEPT the answer (`submit refused: 1 answers still unsent`, zero `responses DROPPED`), "Could not hand in" (correct). After End secure session, Finish again → `PUT … 200`, slot `complete`, `responses` row `{type: drawing_upload, upload_id: …}`, `submit 200`, "Handed in." |

### 8.2 — rejoin through a new sitting (client + monitor together)

| Check | Expected | Status |
|---|---|---|
| Rebind on rejoin | Student joins sitting A, answers ≥1 item; teacher closes/expires A and opens sitting B for the same assessment; student rejoins through B (code or Your tests): B's monitor lists the student In progress with the answered count intact; A's monitor no longer lists them; Peek from B's row works and the image arrives | ✅ 2026-08-29 — <demo-student-B> in progress in A (`NBVC8P`, 1 answer) → teacher closed A, opened B (`NP2HTQ`) → client Refresh → **Resume** → stderr `joined listed sitting bd68dad7… attempt d90e2ac3… (resumed)`; DB: the attempt's `test_session_id` moved to B; B's monitor In progress 2/6 (one more answer saved through B); A's monitor: Not joined; Peek from B's card delivered in 1.5 s and was viewed (`peek_requests` row, image null after read) |
| Submitted stays put | Student submits in A; teacher opens B; student rejoins through B: the client shows the attempt as submitted, B's monitor lists them as NOT joined, A's monitor still shows Submitted | ⚠️ 2026-08-29 — **server ✅, client ❌.** <demo-student-A> (submitted in A) signed in, B's row read **Join** (not Done — the list keys attempts by sitting, `lib/api/mySittings.ts:74`); pressing it: `POST /api/attempts 200` returned the submitted attempt unmoved (`resumed: true`), B's monitor kept them Not joined, A's kept Submitted, DB unchanged. But the client rendered the test, **began a real AAC session**, and accepted three answers — every `PUT …/responses/… → 409`, nothing logged, no message to the student. See Phase 7 finding 10.1 |
| Scope still gates | Teacher opens B scoped to an explicit list that omits the student; student tries to join B: refused (session unavailable / not in sitting) and A's monitor still shows their in-progress attempt | ✅ 2026-08-29 — sitting C (`DBXQVU`) with Picked students omitting <demo-student-B>; signed in as <demo-student-B>: `my-sittings: 0 row(s)`; typed the code: stderr `join failed: refused(status: 404, code: session_unavailable)`, status "That code is not open right now. Check it with your teacher."; no new attempt; their in-progress attempt still on B (closed by then). Copy note: the 404 is deliberate non-disclosure, but "not open right now" reads as a teacher-side problem — finding 10.6 |

## 2026-08-29 student-account run — first real student Google sign-ins

Setup: local dev server + local dev DB (`secure_test_design_tool_dev`), the
fresh HEAD binary (`1bef224`), launched with the native client id read from
`OIDC_AUDIENCE` by a bun launcher (`--env-file`), stderr to a log. Three
PowerSchool **demo** students (`<demo-student-A>`, `<demo-student-B>`, `<demo-student-C>`; all student
Google accounts are `<ps_id>@edtools.psd401.net`) are NOT in the data
engineer's extract (grepped snapshot `roster/20260829T130013Z`), so they
were seeded by hand into the local roster only: `roster_students` (grade
9, school 200, status 0) + `roster_enrollments` into section 5001 (Algebra
1, the lead teacher's account as Lead Teacher), snapshot id
`dev-seed-2026-08-29`. Teacher side: sitting
`NBVC8P` on "Your tests seed (5 items, PoC-B copy)" scoped to 5001.

| Check | Result |
|---|---|
| Student A (`<demo-student-A>`) sign-in, relaunch, Join from the row, answer, hand in | ✅ real `AEAssessmentSession` began (`lockdown DID BEGIN`), 2 responses `PUT … 200`, `POST …/submit 200`, `lockdown DID END`, app exit 0; monitor: "1 of 5 joined · 1 submitted", Student <demo-student-A> **Submitted** 2/6, last event "Lockdown ended"; `students` overlay row auto-created with `roster_ps_id <demo-student-A>` |
| Student B (`<demo-student-B>`) after A signed out: sign in, Join, answer one, **End secure session** without handing in | ✅ own attempt `d90e2ac3…` `in_progress` with 1 response; events `lockdown_begin`, `emergency_exit`, `focus_loss`, `lockdown_end`; left in progress on purpose as the 8.2 rejoin fixture |
| The two other demo students on the monitor | ✅ listed "Not joined" alongside Ada/Ben (5 rostered) |

Later the same night the 8.2 rows ran on the same fixtures (see the 8.2
table): rebind and scope gating pass; "Submitted stays put" passes on the
server and FAILS on the client. Findings 10.1–10.6 in `docs/phase-7-slices.md`.

### Aurora run (later the same night) — the real student, the real import

Setup: SG opened to James's IP (`cdk deploy … allowedIngressCidr`, run by
James), Aurora migrated 0020 → 0022, the dev server on :3000 restarted with
`DATABASE_URL` = the cluster (the Google redirect URIs are bound to that
origin), the seed assessment imported + published there as James
(`d2c39017…`). Two ONE-DAY hand edits, both rewritten by the 06:00 PT import:
James as Lead Teacher on section `284609` (ALGEBRA 1 S1), and that one
enrollment's `dateenrolled` backdated from 2026-09-02 to 2026-08-01 — see the
finding below. Real student (the test student — number kept out of the repo; SSID present, today's snapshot).

| Check | Result |
|---|---|
| Sign in as the real student against the real import | ✅ `session minted for role student`, `my-sittings: 0 row(s)` with NO reason (resolved by email on `roster_students`); the demo account on the same server said `reason not_on_roster` — the right negative |
| Sitting on the real section → row → Join | ✅ sitting `FFWUPC` on 284609; row appeared after Refresh; join created the attempt and auto-bound the `students` overlay row with `roster_ps_id the test student` + the real SSID |
| Answer inside a real AAC session, hand in | ⚠️ **every save / event / peek poll during the session got HTTP 500** — the dev server, on the same Mac, could not resolve the cluster hostname (`getaddrinfo ENOTFOUND …rds.amazonaws.com`) from `begin()` until `DID END`; the spool kept all 6 answers, `submit refused: 6 answers still unsent` ×3, page "Could not hand in. Tell your teacher." (correct). After End secure session: `peek poll recovered`, **Finish again → all 6 `PUT … 200`, `submit 200`**, attempt `submitted` with 6 responses; monitor "1 of 1 joined · 1 submitted", 6/6. Finding 10.7 |
| Events during the outage | ❌ `lockdown_begin` was never delivered (`event lockdown_begin not delivered: refused(status: 500)`), and unlike responses it is not retried — Aurora holds `emergency_exit`, `focus_*`, `lockdown_end` only. Finding 10.8 |
| The teacher's section list / monitor roster | ✅ shows exactly the students whose enrollment is current — tonight that is ONE (the backdated row); everyone else in 284609 starts 2026-09-02. Finding 10.9 |

## Still open

- **File → Open Test Bundle… — built 2026-08-28, every row above unrun.**
  Core rules are in `swift test` (`OfflineBundleTests`); the panel, the
  greyed item during a server attempt, and the repo-path pick all wait on
  a hand-run. The "Deferred: File → Open for the offline bundle" bullet in
  `docs/phase-7-slices.md` is owned by the design-tool session (this
  branch touches `client/` only) — close it there once this lands.
- **Status label after relaunch has no email — fixed in code 2026-08-27,
  one hand-run pending.** The session JWT the design tool mints carries the
  verified email as a claim, so `SessionEntryViewController` now reads it
  from the stored token (`SessionTokenClaims.decodeUnverified`, display
  only — the server still verifies every request) instead of remembering
  the exchange response. Same change: a token whose `exp` has passed reads
  as signed out at launch, so a next-morning relaunch shows the sign-in
  button instead of "Signed in" followed by a 401 on Join. An opaque
  `--token` dev credential has no readable claims and behaves as before.
  All of that is covered by `swift test`; the relaunch row above was
  re-run and verified by hand 2026-08-27. What has NOT been observed live
  is the expiry path (needs a token past its 8-hour TTL); its logic is in
  `swift test` (`APIClientSignedInStateTests`).
- ~~**Student-account sign-in** and the A→B ephemeral-session row~~ **DONE
  2026-08-29** — see the sign-in table and "2026-08-29 student-account run"
  below. The secondary domain IS inside Internal (ADR 0017 "Depends on" #2).

- **Function keys that bypass the responder chain.** The Touch Bar path is
  closed, but hardware function keys mapped to system actions (Mission Control,
  Spotlight, Dictation) are governed by the OS, not by this app. They are an AAC
  question, not a WebKit one, and belong in the layered-lockdown checklist in
  `docs/plan.md`. The entitlement landed 2026-08-26, so what these now wait on is
  the `AEAssessmentSession` being written here plus PoC-A's characterization run
  (`docs/unblock-checklist.md` step 5).

- **Leaving a session.** Not yet checkable — this app has no `AEAssessmentSession`.
  It becomes the highest-priority row here the moment one is added, because PoC-A
  demonstrated on 2026-08-26 that a session with no exit path costs a forced
  shutdown. Rows to add then: hand-in returns the Mac to the student; quitting
  ends the session; a crash or force-kill does not leave the Mac locked; the
  end control is visible and truthfully labelled at all times.

  Most of those are testable WITHOUT the entitlement if the session is written
  behind a simulation seam, as PoC-A's is. That matters here more than there:
  this list exists because the AppKit surface cannot be tested headlessly, and a
  simulated session moves the quit-path rows off it and into `swift test`. It is
  also how PoC-A caught RESULTS finding #11 — a quit handler that hung the app
  with the session still live — before any Mac was locked by it.

## 2026-08-31 UX pass 2 slice 6 — a way home + join copy (10.3 / 10.6 / P2-6)

AppKit surface — cannot be asserted headless (ADR 0013). Run with the dev
server and a demo student.

| Check | Expected | Result |
|---|---|---|
| Hand a test in | The WebKit page still says "Handed in. You can close the app."; a **Back to your tests** button appears in the titlebar; clicking it lands on "Your tests" with the list refreshed and the attempt surface torn down (no peek polling in the log) | ⚠️ 2026-08-31 run 1 (James) — worked, but the titlebar button alone is too subtle; same-day refinement adds an in-page Back to your tests button beside the handed-in notice → re-check below |
| End secure session (button), stay in the app | Same **Back to your tests** button appears once `DID END` lands; it returns to "Your tests"; answers stay spooled | ⚠️ 2026-08-31 run 1 (James, via Cmd-E) — session ended and the titlebar button appeared, but too subtle; refinement adds a centered "Secure session ended" sheet (Back to your tests / Stay here) → re-check below |
| Join a sitting whose attempt is already submitted | Status line reads "You already handed this test in. Ask your teacher if you need it reopened." and the app stays on the entry screen | ✅ 2026-08-31 (James) — exact copy confirmed |
| Join with a code for a sitting you are not in | "That code is not open for you right now. Check it with your teacher." | ✅ 2026-08-31 (James, code AAAAAA) — exact copy confirmed |
| Back to your tests, then join and hand in again on another sitting | The button re-appears for the new attempt; no stale peek/event traffic from the old one | ✅ 2026-08-31 (James) — flow completed on FAWXJ7 after the 2PZP7E hand-in |

## 2026-08-31 UX pass 2 slice 8 — Cmd-E (Session menu)

Diagnosis first: the shipping client never had a Cmd-E item (PoC-A did);
the hand-run beep was an unbound key, not a regression.

| Check | Expected | Result |
|---|---|---|
| Cmd-E with a session active, focus inside an answer field | Session ends exactly like the End secure session button (`emergency end control pressed` in the log, `emergency_exit` event, Back to your tests appears); no beep | ✅ 2026-08-31 (James) — ended like the button, no beep (affordance note above) |
| Cmd-E with no session active (entry screen, or after DID END) | Nothing happens (item disabled); a beep here is fine | ✅ 2026-08-31 (James) — nothing happens |

### Re-check after the same-day refinements (dialog + in-page button)

| Check | Expected | Result |
|---|---|---|
| End secure session (Cmd-E or button) | A centered "Secure session ended" sheet: Back to your tests / Stay here; Stay here keeps the unlocked attempt; Back lands on Your tests | ✅ 2026-08-31 (James) — sheet shown; Stay here and Back both behave |
| Hand a test in | A "Back to your tests" button appears beside "Handed in. You can close the app." and lands on Your tests | ✅ 2026-08-31 (James) — in-page button beside the notice lands on Your tests |
| Cmd-Q mid-session | No sheet flashes on the way out; the app quits cleanly | ✅ 2026-08-31 (James) — clean quit, no sheet flash |

## 2026-09-01 E5 slice 2 — stimulus / item sets on the student page

Built the same night as the design tool's slice 1 (`docs/stimulus-design.md`). The
page renders a set's stimulus once, above the first of its questions, through the
same text-and-image path a stem uses; the questions of a set are indented under it.
`own_page` renders like `inline` on this one-scrolling-page client (James: one page is
the MVP shape; per-question paging is on the roadmap). `swift test` proves the tree
the renderer builds (RendererStimulusTests, DeliveryBundleTests on the regenerated
fixture); these rows are what WebKit shows.

Setup: on the design tool (local dev or the origin once deployed + migrated), a
draft with three questions, "Add stimulus above" on question 2, an image and a line
of text in the stimulus, "Join stimulus above" on question 3, publish, start a test
session; the client with `SECURE_TEST_SIMULATE_LOCKDOWN=1` unless a real session is
wanted.

| Check | Expected | Result |
|---|---|---|
| Join and open the test | A shaded block labelled "Questions 2–3" sits between question 1 and question 2 with the text and the image; questions 2 and 3 are indented under it; question 1 and any later question are not | ✅ 2026-09-02 (James at the screen, Claude driving setup). Local dev `localhost:3000`, `SECURE_TEST_SIMULATE_LOCKDOWN=1`, minted student token (no Google sign-in), rebuilt app 2026-09-02 08:45. Fixture seeded straight into the dev DB — 8 items, an inline set over Q2–Q3 carrying a real PNG (Unit 0's Table 1) plus a line of text, and an `own_page` set over Q5–Q6. Block present between Q1 and Q2 with the image and the text; exactly Q2 and Q3 indented, Q1 and Q4 not. **The block's label text was not separately checked** — the walkthrough asked about presence, image and indentation, so "Questions 2–3" as wording is unverified. |
| Answer questions 2 and 3, hand in | Answers save and hand in exactly as before (the block is display-only, nothing posts for it) | ✅ 2026-09-02. Confirmed server-side, not just on screen: attempt `21d83546-…` is `submitted` with **8 responses** — one per item, including both set members; nothing posted for the set itself. Client stderr shows one `response:` line per item, then `attempt … handed in`, `lockdown ending: hand-in confirmed`, `DID END`. |
| The same bundle through File → Open Test Bundle… (~~`.securetest`~~ **`.json`** — see note) | Same block, same layout, offline notice as usual | ✅ 2026-09-02. Delivery bundle exported straight from `/api/assessments/<id>/delivery` to `~/Desktop/client-checks-bundle.json` (81 KB), opened with Cmd-O from the entry screen. Same block, same layout as online — image included. Stderr: `open test bundle: …`, `bundle source: …`, `bundle loaded: 8 items, test_id=11f44796-…`. Worth knowing: the image renders from **base64 inlined in the bundle** (one asset, 78,808 b64 chars), not a fetch — the page's CSP forbids it making a request at all, so this is the path that would break first if assets ever stopped being inlined. |
| A stimulus set to "On its own page" in the editor | Renders exactly like inline on the client (no page break, no separate screen) — expected for the MVP; note it here if it reads wrong to a student | ✅ 2026-09-02 — "pass for MVP" (James). The `own_page` set over Q5–Q6 renders inline like every other block; James did not flag it as reading wrong to a student. Per-question paging stays on the roadmap. |
| ~~A stimulus containing `$x^2$`~~ **(expectation superseded)** | ~~Shows the raw `$x^2$`~~ — written the same evening, hours before the KaTeX slice landed the same night. **Rendered math is now the correct outcome**, not raw source; the live check is the KaTeX table below. | ✅ 2026-09-02 under the corrected expectation: the `own_page` stimulus's `$$E = mc^2$$` renders, centred and larger than body text. No `$` visible. |

> **Extension correction (2026-09-02).** The rows above say `.securetest`.
> The open panel actually filters on **`.json`** — `OfflineBundle.fileExtension`
> is `"json"` (`client/SecureTestCore/Sources/SecureTestCore/OfflineBundle.swift:21`),
> on the reasoning that a delivery bundle is `DeliveryBundleSchema` JSON on the
> wire. A file named `.securetest` is not offered by the panel. Either the doc
> or the extension should change; the code is what ships today.

## 2026-09-01 KaTeX in the shipping client (ADR 0009 port)

The Phase 5 page had reserved the CSP for KaTeX but never carried the library
over from PoC-B, so `$x^2$` reached students as source (found during E5 slice 2,
James queued this next). Now `client/scripts/vendor-katex.mjs` vendors the design
tool's own KaTeX build (0.16.47, the version the preview renders with) plus the K12
macros into the package; `KatexBundle` inlines CSS with woff2 data URIs, the
library and auto-render; the renderer calls `renderMathInElement` on the built
tree with the design tool's options (errors red, never thrown; strict off; trust
off). `swift test` proves the assets load and `renderToString` renders a macro under
JavaScriptCore; these rows are WebKit.

Setup: a draft with a stem `Solve $\frac{1}{2}x = \half$`, a choice `$x^2$`, a
matching item with `$\mathrm{H_2O}$` on one side, a stimulus with `$$E = mc^2$$`
on its own line, and a stem with a deliberately broken `$\frac{1}{$`; publish,
start a session.

| Check | Expected | Result |
|---|---|---|
| Open the test | Rendered math in the stem, the choice, the match side and the stimulus — no `$` visible; the display-mode line is centred and larger; fonts look like KaTeX's (serif math), not a fallback | ✅ 2026-09-02. All four surfaces: stem `Solve $\frac{1}{2}x = \half$` (the `\half` K12 macro resolves, so the vendored macros load), choice `$x^2$`, match sides `$\mathrm{H_2O}$` / `$\mathrm{CO_2}$`, and the display-mode `$$E = mc^2$$` in the stimulus — centred and larger. No `$` anywhere. |
| The broken expression | Renders in red as its source (`\frac{1}{`) and the rest of the page is unaffected | ✅ 2026-09-02 — the deliberately malformed `$\frac{1}{$` in Q8's stem rendered red as source, rest of the page unaffected (every later item still rendered and answered). |
| Answer every item type and hand in | Unchanged: radios/checkboxes still post, match still pairs, hand-in lands | ✅ (partial) 2026-09-02 — **not every item type**. The fixture carried `multiple_choice_single`, `short_text` and `match` only; radios posted, match paired (two `response:` lines as pairs were set), hand-in landed with 8/8 responses. `multiple_choice_multi`, `essay`, `order`, `hotspot` and `drawing_upload` were NOT exercised with math on this run. |
| Page load feel | No visible delay opening the test compared with before (the page carries ~600 KB more inline; PoC-B measured this as fine) — note if a real session on the test fleet's Macs feels slower | NOT ASSESSED 2026-09-02 — not asked during the walkthrough, and a dev Mac on localhost is the wrong place to judge it. Belongs to a real session on a test-fleet Mac. |
| File → Open Test Bundle… with the same bundle | Same rendering offline | ✅ 2026-09-02 — same bundle, same session as the E5 offline row above. Every math surface identical to online: the `\frac{1}{2}x = \half` stem, the `$x^2$` choice, the `$\mathrm{H_2O}$` / `$\mathrm{CO_2}$` match sides, the centred `$$E = mc^2$$`, and the broken `$\frac{1}{$` still red. KaTeX is inlined in the app (CSS with woff2 data URIs), so offline was never expected to differ — now shown, not assumed. |


## 2026-09-02 E6 — bold and italic in the shipping client

Fixture on the origin: `E6 / E7(b) hand-run 2026-09-02` (`ea0284c1-c8cb-4fb6-896c-21349ef282a6`),
Published 2026-09-02 with the stems, choices, match pairs and stimulus below and
the two E7(b) short-text items. Start a session from its Test sessions tab with
**Picked students** (James's account has no sections). Rebuilt app: DerivedData
`SecureTest-gwoymhsfucmcdzaznczoqsmmosaf/Build/Products/Debug/SecureTest.app`
(2026-09-02 11:55; E6 + E7(b) verified in `SecureTest.debug.dylib`).

**2026-09-02 attempt: NOT RUN.** Setup got as far as a one-day
`roster_section_teachers` row for James on one of the test student's current
sections, so that student appears under Picked students (the row expires at
the 06:00 PT import — absence-deactivates), and the client launched against
the origin with simulated lockdown. Then the district-wide reset of student
usernames and passwords that day meant no student sign-in was possible; the
rows wait for the replacement credentials. The student's number stays out of
the repo: it lives in the script in James's home directory,
`~/secure-test-hand-teacher-row.sh` (the README's ad-hoc recipe — temporary SG
rule, read-only checks, one insert, verification, revoke on exit; the Mac's
public address on the district network is the shared NAT, so the rule stays
as brief as the script makes it). To retry: run that script from a normal
terminal, reload the fixture's Test sessions tab, Picked students → the
student → Start session, then launch the client:
`SECURE_TEST_SERVER=https://<origin> SECURE_TEST_SIMULATE_LOCKDOWN=1 bun --env-file=design-tool/.env.local client/scripts/launch-client.ts <the .app>`.
Observed on the way: the Test sessions tab sat on loading skeletons for about
ten seconds before the form appeared (the SittingsPanel stall on file).

Rebuild first: the installed app predates E6. Fixture: a draft with the row-38
stem (`Which is **NOT** an _abiotic_ factor? Solve $x_1$`), a choice `a **fern**`,
a match item with `_Dog_` → `**Puppy**`, and a stimulus `**Read** the _passage_ first.`

| Check | Expect | Result |
|---|---|---|
| Open the test | The stem shows NOT in bold and abiotic in italic with no `**` or `_` visible; `$x_1$` is rendered math; the choice's "fern" is bold; the match left "Dog" is italic; the match dropdown reads "Puppy" with no markers; the stimulus block shows "Read" bold and "passage" italic | |
| Answer and hand in | Unchanged — the markup is display-only, responses post as before | |

## 2026-09-02 E7(b) — formula-aware short-text answers

Rebuild first. Fixture: a short-text item whose stem carries math (e.g.
"Formula of water, given $\mathrm{H}$ and $\mathrm{O}$?", key `H2O`) and a
plain one ("Capital of Washington?", key `Olympia`).

| Check | Expect | Result |
|---|---|---|
| Open the test | The math item shows the hint line under its field; the plain item shows none | |
| Type `H_2O` in the math item | A rendered H₂O appears under the field as you type; the field keeps the raw `H_2O` | |
| Type `x^2 50%` then clear the field | Preview shows x² 50% (no red); clearing empties the preview | |
| Type `Olympia` in the plain item | No preview appears | |
| Hand in, then score (design tool Results) | The `H_2O` response scores 1 against key `H2O`; `Olympia` scores 1 | |

## E12 slice 3 — the outline written in place (2026-09-02)

Rebuild first. Fixture on local dev: an Outline assessment with one essay
question; an Essay assessment whose stimulus set names that question as its
source (PATCH `source_item_id`) with lead-in "Your outline:"; the student
admitted to the Essay only (no Outline attempt).

| Check | Expect | Result |
|---|---|---|
| Join the Essay | The stimulus block shows "Your outline:" and, under it, "You have not written your outline yet…" with an empty writing area above the essay question | ✅ 2026-09-03 on the origin (the hand-run fixture's Q1 set, own_page, source = the Outline question): the passage page showed "Your outline:" and the writing area with the "You have not written your outline yet…" hint. |
| Type an outline, click away | "Saved." under the area; server: a response on the Essay attempt keyed by the Outline question's id, `{type: essay, text}` | ✅ 2026-09-03 — "Saved."; the log shows `response: item=<Outline question> type=essay` on the hand-run attempt; the queue read "Outline: written inline (4 words)". |
| Quit, relaunch, rejoin | The block reads "Your outline. You can still change it here." with the text prefilled; editing and clicking away saves again | NOT CHECKED 2026-09-03 in this form — the relaunch happened on the import copy after the Outline was handed in (next row). |
| Now answer the Outline assessment itself (a second sitting), then rejoin the Essay | The block shows the lead-in, a blank line and the Outline answer as plain text — no writing area | ✅ 2026-09-03 — the student handed in the Outline, then joined an import copy of the test: the passage showed the lead-in and the Outline text as plain text, no writing area (James at the screen). |

## E3 slice 3 — the table the student fills in (2026-09-02)

Rebuild first (the installed app predates the type; an older client refuses
the whole bundle with `unknown item type "table"` — by design, so a student
is never handed a shortened test). Fixture on local dev: a Published
assessment with one table question — stem "Enter the counts", columns
`Observed (o)` / `Expected (e)` / `$(o-e)^2$`, rows `Middle` / `**Total**`,
corner "Chamber position", expected answers `12` in Middle × Observed and
`1.5` in Total × Expected, scoring Auto — plus a second table whose row
labels are all blank (three trials × `Mass (g)`).

| Check | Expect | Result |
|---|---|---|
| Open the test | A bordered grid under the stem: the corner caption, the three headings (the third rendered as math, no `$`), two labelled rows (Total in bold, no `**`), one text field per body cell; the second table shows only its heading row and three rows of fields — no label column | ✅ 2026-09-03 (origin, rev 9; James at the screen, Claude on the teacher side). Fixture: `Hand-run 2026-09-03 rows 43–56`, paged, three tables (hand-made keyed, hand-made unlabelled, the Unit 0 import). Grids rendered with headings, the math heading as KaTeX, the corner, one field per cell; the unlabelled table with no label column. |
| Tab from the stem | Focus moves left-to-right, top-to-bottom through the cells; each field is announced as "<row>, <column>" (VoiceOver) | NOT CHECKED 2026-09-03 — VoiceOver announcement not tried. |
| Type `12` in Middle × Observed and click away | stderr: one `response:` line with `type: table` and `cells: {r1: {c1: "12"}}` — nothing for the other cells | ✅ 2026-09-03 — the log shows one `response: … type=table` per edited cell (3 for the keyed table, 6 for the unlabelled one, 3 for the Unit 0 table); cell-by-cell contents not read from the log (it names the type, not the cells). |
| Type `1.50` in Total × Expected, then clear Middle × Observed | Two more `response:` lines; the last carries only `{r2: {c2: "1.50"}}` | PARTIAL 2026-09-03 — posts observed per edit; the exact cells were not compared against the log. |
| Clear the last field too | No further `response:` line (an all-blank grid is no response) | NOT CHECKED 2026-09-03. |
| Hand in, then the design tool's Results | The table's cell reads `1 / 2` — `1.50` matched `1.5` (numbers compare as numbers), the cleared cell scored 0 | ✅ 2026-09-03 on the second attempt (import copy): 12 / 4 / 1.5 in the keyed table → Results `3 / 3` after the scoring pass. First attempt: the student's 12 / 1.50 went into the keyless Unit 0 table, so the keyed table read 0 / 3 — not a defect; the `1.50` = `1.5` case stays test-covered only. |
| Scoring queue (set the item to Hand-scored, hand in again from a second student) | The card shows the grid with the student's text in each cell and "✓ / ✗ expected …" under the two keyed cells; "Points (of 2)" | NOT RUN 2026-09-03 — and finding E3-F1: a keyless table left on the default (auto) never reaches the queue at all; see docs/design-tool-manual-checks.md row 52. |
| File → Open Test Bundle… with an exported delivery bundle carrying the table | Same grid offline; typing posts `response:` lines that the host logs and ignores | NOT RUN 2026-09-03. |

## Client paging — one question at a time (2026-09-02)

Rebuild first (the same rebuild as E12 / E3). Fixture on local dev: a
Published assessment with Settings → "How students move through the test" =
**One question at a time**, nine questions, an **own_page** stimulus over
questions 2–3 and an **inline** stimulus over questions 5–6; a second copy of
the same assessment left on **One scrolling page**.

| Check | Expect | Result |
|---|---|---|
| Open the paged test | Only question 1 shows, headed "QUESTION 1 OF 9"; a bar fixed to the bottom reads Previous (disabled) · "Question 1 of 9" · Next, with a strip of page buttons `1 P 2 3 4 5–6 7 8 9 Review` and `1` highlighted | ✅ 2026-09-03 (origin, rev 9; James at the screen). The fixture's Q1 sat in an own_page set, so the PASSAGE page came first, then one question per page; bar and strip as described. |
| Next | The passage page: "PASSAGE FOR QUESTIONS 2–3" with the stimulus (text and image) and nothing else; the page scrolls to the top and VoiceOver announces the label | ✅ 2026-09-03 — passage page with the stimulus (and, on this fixture, the E12 writing area). |
| Next again | Question 2 alone, with "Show the passage" collapsed above it; opening it shows the same passage; Previous returns to the passage page (the passage is back there, not duplicated) | ✅ 2026-09-03 — "Show the passage" collapsed above the question; the passage travels back on Previous. |
| Jump to `5–6` on the strip | One page headed "QUESTIONS 5–6 OF 9" with the inline stimulus on top and both questions beneath, scrolling within the page | ✅ 2026-09-03 — the inline set pages (two hand-made tables; the Unit 0 set of four) rendered stimulus on top, questions beneath. |
| Answer on several pages, then `Review` | "REVIEW AND HAND IN", "9 questions. Go back to any of them, or hand in.", ten buttons (the nine questions and the passage) that jump, and the Finish and hand in button; Next is disabled here | ✅ 2026-09-03 — review page with the jump list and the hand-in button. |
| Hand in from the review page | Same as today: "Handed in. You can close the app." and the way home | ✅ 2026-09-03 — "handed in" in the log, DID END. |
| Open the scrolling copy | Exactly as before this build: one page, no bar, the own_page stimulus rendered inline | NOT RE-CHECKED 2026-09-03 (the scrolling client was verified 2026-09-02 before paging existed; the scroll path's tree is byte-identical by construction and test). |
| An E12 assessment set to paged, the outline not yet written | The passage page carries the writing area; on question pages it sits inside "Show the passage"; typing there saves ("Saved.") from either place, and there is only ever one writing area | ✅ 2026-09-03 — the writing area sat on the passage page; typing there posted `type=essay` under the Outline question's id (log) and the queue later read "written inline (4 words)". The disclosure copy was not separately exercised. |
| File → Open Test Bundle… with a paged bundle | Same paging offline; a bundle without the field is one scrolling page | Second half ✅ 2026-09-03 afternoon — the harness fixture (no `layout`) opened as one scrolling page. A paged bundle offline: NOT RUN. |
| Answer questions 1 and 4, quit the app, relaunch and rejoin the paged test | The strip shows `1 ✓` and `4 ✓` in green from the start (the server's saved answers, not this session's), the review page reads "2 of 9 answered." with "Question 1 · answered" and "Question 2 · not answered"; answering another question turns its button green at once; a saved drawing turns green only after "Saved."; the `5–6` button turns amber with one of its two answered | ✅ marks / ❌ experience, 2026-09-03: after the relaunch the client rejoined the same attempt ("resumed"), the strip showed green checks on 1, 4 and the keyed table from the start and the review page read "3 of 12 answered" — but the fields were EMPTY (no prefill from saved answers, the documented v1 limit), and James read that as lost answers and re-answered. **Finding P-1, DECIDED 2026-09-03: prefill from the server, high-priority build** (`docs/client-paging-design.md`). |

## Client-fixes batch 1b — the essay box (2026-09-03)

`docs/client-fixes-batch-2026-09.md` §1b, #4. Rebuild first (the batch's
single rebuild). Fixture: any Published assessment with an essay question and,
for the last row, an E12 set whose outline is not yet written.

| Check | Expect | Result |
|---|---|---|
| Open a test with an essay question | The answer box is about ten lines tall and full width, styled like the short-text field (border, padding, the page font) — not WebKit's two-row default | ✅ 2026-09-03 (origin, rev 10, the client-fixes hand-run fixture; James at the screen): "the essay box looked great" — the tall bordered box, not the two-row default. Noted on the way: predictive text auto-completed in the box under SIMULATED lockdown (the simulator applies no keyboard config; finding 8.4 under a real session — `docs/roadmap-2026-09.md`, "Findings from the 2026-09-03 sitting"). |
| Drag the box's corner | It grows taller (vertical only); the width stays the column's | ✅ 2026-09-03 — the drag succeeded (James). |
| An E12 set with the outline unwritten | The writing area is unchanged from before this build (its own 140 px rule) | NOT RUN 2026-09-03 (no E12 set in the fixture). |

## Client-fixes batch 1b — Clear answer (2026-09-03)

`docs/client-fixes-batch-2026-09.md` §1b, #3. Rebuild first (the same
rebuild as the essay box). Fixture: any Published assessment with a
multiple-choice single and a multiple-choice multi question.

| Check | Expect | Result |
|---|---|---|
| Answer a multiple-choice question, then click Clear answer | stderr shows a withdrawal / DELETE and no response line | ✅ 2026-09-03 (origin, rev 10; James at the screen, Claude reading stderr): `response: item=… type=multiple_choice_single` then `withdraw: item=…` for Q1, nothing further for that item. |
| Quit and relaunch, rejoin the same attempt | No green mark on that question on the strip/review; the field shows no selection | ✅ 2026-09-03 — "resumed"; Q1 came back empty with no mark (James). |
| The teacher's review (Scoring queue / Results) for that attempt | Shows no answer for that item | ✅ 2026-09-03 — Results reads `no_response` for Q1 (and for Q2, cleared on the resumed attempt — the P-1 row); neither is in the Scoring queue. |
| Click Clear answer on a never-answered item | The DELETE returns 204 (idempotent) and nothing else happens | NOT EXERCISABLE — the button is disabled until a choice is made (by design), so the page cannot produce the case; the route's idempotent 204 stays covered by its test. |
| File → Open Test Bundle… (offline), answer then Clear | stderr shows `withdraw ignored` and no crash | ✅ 2026-09-03 — the harness fixture via Cmd-O: `response: … type=multiple_choice_single` then `withdraw ignored: no server session`; the app quit cleanly. |

## P-1 — saved answers come back on resume (2026-09-03)

`docs/resume-prefill-design.md` slice 3. Rebuild first (the batch's single
rebuild) and DEPLOY the design-tool side first — the prefill rides the
delivery bundle, so an un-deployed server sends no `saved_responses` and
every row below reads as "not built". Fixture: one Published assessment
carrying every item type (multiple choice single and multi, short text,
essay, match, order, hotspot, drawing, table), set to **One question at a
time** so the strip marks are visible beside the fields.

| Check | Expect | Result |
|---|---|---|
| Answer one of EVERY type, including a drawing saved to "Saved.", then quit the app (Cmd-Q) | stderr shows a response line per answer and an upload for the drawing; the session ends cleanly | ✅ 2026-09-03 (origin, rev 10, fixture `Client-fixes hand-run 2026-09-03`, paged, 11 questions; James at the client, Claude on the teacher side): a response line per answer (multi ×2, short_text, essay ×2, match ×3, order ×4, hotspot ×5, table ×4; the MC single answered then withdrawn on purpose) and `drawing saved` ×4 (the three drawings, the grid one twice around a Clear); Cmd-Q → `quit requested with lockdown active — ending the session first` → `DID END`. |
| Relaunch, sign in, rejoin the same test | "resumed" in the log, and every field holds the answer given before the quit: the chosen radio / checkboxes, the typed short text (with its formula preview), the essay text and its word count, each match dropdown on its saved right, the order rows in the saved arrangement, the marked hotspot region highlighted, every filled table cell | ✅ 2026-09-03 — `joined listed sitting … (resumed)`, `bundle fetched: 11 items`; the fields came back with their answers (James: Q2's boxes, the Q9 picture, Q3's text, Q1 empty as cleared). The per-type detail — formula preview, word count, order rows, hotspot highlight, table cells — was not itemised in the report. |
| The drawing question after the relaunch | The canvas shows the PICTURE that was saved, and the status beside Clear / Save drawing reads "Saved." | ✅ 2026-09-03 — "saw prior drawing" on the grid question (James). |
| The strip and review page after the relaunch | The green marks are exactly the questions whose fields show an answer — no mark over an empty field, no filled field without a mark; the review count agrees | NOT ITEMISED 2026-09-03 — no mismatch reported; the count was not read out. |
| Nothing is re-sent by the restore | stderr shows NO response / upload lines between the join and the student's first change (a restore is not an answer) | ✅ 2026-09-03 — between `DID BEGIN` and the first change (the Q2 withdrawal) stderr holds only focus lines. |
| Change one restored answer and hand in | The change posts as usual, and the teacher's Scoring queue / Results shows the CHANGED answer, not the original | ✅ 2026-09-03 — Q3 changed 42 → 43: one `response: … type=short_text`, `attempt … handed in`, `lockdown ending: hand-in confirmed`; after the scoring pass Results reads 0 / 1 for Q3 (key 42) — the changed answer was scored, not the original. |
| Clear answer on a restored multiple-choice question | The button is enabled from the start (no need to re-pick first); clicking it withdraws — the selection clears, the strip mark drops, and the teacher's review shows no answer for that item | ✅ 2026-09-03 — Q2 (multi): "clear answer works" (James); stderr `withdraw: item=…` as the first change after the resume; Results reads `no_response` for Q2. |
| Press Save drawing on a restored drawing without drawing again | It uploads rather than answering "Draw something first." (the restored canvas counts as marked) | ✅ 2026-09-03 — Q9 Save with no new stroke: `drawing saved for item …` (15:49 PT) and a new S3 object under the attempt. |
| A drawing too large to inline (over 2 MB) or stored as something other than PNG/JPEG | The canvas is blank but the status still reads "Saved."; the strip mark is still green | NOT RUN 2026-09-03 — not producible by hand; `delivery-api` covers the pending-slot / non-image cases. |
| File → Open Test Bundle… (offline), and any fresh attempt | Unchanged from before this build: no bundle field, no prefill, empty fields | ✅ 2026-09-03 — fresh attempt: pass 1 opened with empty fields and no marks; offline: the harness fixture via Cmd-O opened with every field empty and no marks (James). Seen on the way: the fixture's only asset is a 1 × 1 PNG, so its stem, stimulus and hotspot images render as single dots — images do render offline; and the hotspot's two regions sat as grey buttons beside the dot, the CSS defect recorded in `docs/roadmap-2026-09.md` (batch 0b). |

## Batch 0b slice 1 — hotspot regions over the image (2026-09-03)

`docs/roadmap-2026-09.md` "Findings from the 2026-09-03 sitting". Rebuild
first. Fixture: any Published assessment with a hotspot whose image is a real
PNG (the 2026-09-03 client-fixes fixture's hotspot image is corrupt — add a
hotspot with an Images-page asset, or the harness fixture offline, whose image
is 1 × 1 and useless for this).

| Check | Expect | Result |
|---|---|---|
| Open the hotspot question | The picture shows at its natural size (no wider than the column) with nothing drawn on it and nothing under it; moving the pointer over a region shows a faint dashed blue box at its authored place | |
| Click a region, then another | The clicked region fills blue with a solid border and stays so when the pointer leaves; clicking again clears it; each click posts (stderr `response: … type=hotspot`) | |
| Tab to a region | A thick focus ring on the region; Space toggles it | |
| Narrow the window until the picture shrinks | The regions shrink and move with the picture, staying over the same part of it | |
| Quit, relaunch, rejoin (P-1) | The saved regions come back already filled | |

## Batch 0b slice 2 — the math preview on every short-text answer (2026-09-03)

`docs/roadmap-2026-09.md` "Findings from the 2026-09-03 sitting" (James: a
math answer should always render, not only when `_` / `^` are typed).
Rebuild first. Fixture: any Published assessment with a short-text question.

| Check | Expect | Result |
|---|---|---|
| Type `mitochondria` | The word appears under the field, upright, as it will be read | |
| Type `New York` | Both words, with their space | |
| Type `H_2O`, then `x^2` | Subscript and superscript rendered, as before this build | |
| Clear the field (or leave only spaces) | The preview disappears | |
| Type `a {b` | The preview shows the raw text in red (KaTeX's error colour) rather than vanishing; the posted answer is still the raw text | |

## Batch 0b slice 3 — a match is answered when every pair is set (2026-09-03)

`docs/roadmap-2026-09.md` "Findings from the 2026-09-03 sitting" (James: the
strip showed a check on the first match rather than when all were made).
Rebuild first. Fixture: a Published assessment set to **One question at a
time** with a three-pair match question. Order and table keep the old rule
(marked on the first post) by decision.

| Check | Expect | Result |
|---|---|---|
| Set the first pair, then the second | stderr posts a match response each time; the strip button for the question stays un-marked and the review page counts it as not answered | |
| Set the third pair | The strip button turns green at once; the review count goes up by one | |
| Put one dropdown back to "Choose…" | A response still posts (the two remaining pairs); the mark drops and the count goes down | |
| Quit with two of three pairs set, relaunch, rejoin | The two dropdowns come back on their saved rights; the question is NOT marked and the review count excludes it; nothing posts until the third pair is set, which marks it | |

## Drawing background — grid and axes (2026-09-03)

`docs/drawing-background-design.md` slice 2. Rebuild first (the batch's
single rebuild) and DEPLOY the design-tool side first — the background rides
the delivery bundle inside `canvas`, so an un-deployed server sends no
`background` and every row below reads as blank. Fixture: one Published
assessment with three drawing questions — Blank, Grid, and Grid with axes —
plus one drawing already answered in an earlier sitting (for the resume row).

| Check | Expect | Result |
|---|---|---|
| Open the question whose Background is **Grid** | The canvas is white graph paper: 40 px squares, light grey lines with every fifth line darker; no axes | ✅ 2026-09-03 (origin, rev 10; the fixture's 800 × 500 Grid question) by the stored PNG read back from S3: white paper, 40 px cells, every fifth line darker, no axes. The on-screen look was not itemised by James. |
| Open the question whose Background is **Grid with axes** | The same paper plus an x and a y axis through the centre in the pen's dark colour, an arrowhead on the right end and on the top end, and small ticks at every cell along both axes; no numbers | ✅ 2026-09-03 by the stored PNG (800 × 600): the paper, both axes through the centre in the pen colour, arrowheads at the right and top ends, a tick per cell, no numbers. |
| Draw on either of them | The pen is dark and thick (2.5 px) over the paper — not a thin grid-coloured line — and the strokes sit on top of the grid | ✅ 2026-09-03 by the stored PNGs: dark thick strokes on top of the grid on both. |
| Press Clear on the grid or axes question | The strokes go, the paper stays exactly as it was | ✅ 2026-09-03 — the grid question was saved, cleared and saved again in pass 1 (`drawing saved` twice); the second PNG carries the paper intact with the new stroke. |
| Save the drawing, then open the stored PNG (teacher review, or the S3 object) | The image carries the paper as well as the strokes — the grid is IN the picture, not behind it | ✅ 2026-09-03 — the S3 objects under `responses/<attempt>/<item>/` read back with `aws s3 cp`: grid and axes are in the pictures. (Teacher review cannot show them — F-1.) |
| Quit, relaunch and rejoin, then look at that question | The restored picture sits on the paper with no doubled or misaligned grid (the saved PNG already carries its own) | ✅ 2026-09-03 — the prior drawing came back on the grid question (James); no doubling reported. |
| Open the question whose Background is **Blank** | Unchanged from before this build: a transparent canvas, no white paper, no lines | ✅ 2026-09-03 by the stored PNG: RGBA, transparent, the circle only. |
| A canvas whose height is not a whole number of cells (e.g. 1000 × 700) | The last row of squares is simply cut off at the bottom edge — accepted, not a bug | ✅ 2026-09-03 — the 800 × 500 grid (12.5 cells tall): the last row is cut at the bottom edge in the PNG. |
| If an OLDER client build is at hand: join with it and open the Grid question | A blank canvas, and the question still works — the older build ignores a field it has never heard of | NOT RUN 2026-09-03. |

## Signed build / branding (release plan slice 1, 2026-09-03)

`docs/client-release-plan.md` slice 1 + `docs/client-ui-pass-design.md` §C.
Nothing here is testable in `swift test` or by `xcodebuild`: an icon, a
panel, a sheet header and a drawn colour all need eyes. Rebuild first —
`cd client && xcodebuild -project SecureTest.xcodeproj -scheme SecureTest
-destination 'platform=macOS' build` — and note the sha the build stamped
(`plutil -p <app>/Contents/Info.plist | grep PSDBuildCommit`) before
starting, because two rows compare against it.

| Check | Expect | Result |
|---|---|---|
| Launch the built app and look at the Dock | The PSD emblem in white on a dark Pacific rounded tile — not the generic blank-page macOS app icon | ✅ 2026-09-07 — the notarized Developer ID build (`1.0.0 (c719eb586e45)`), James at the screen: the emblem tile in the Dock |
| Reveal `SecureTest.app` in Finder, and look at it in icon view and in a Get Info window | The same tile, sharp at every size; the Get Info name reads "Secure Test" | Not looked at 2026-09-07 |
| Secure Test → About Secure Test | A standard About panel: "Secure Test", and a version line reading `1.0.0 (<sha>)` where `<sha>` is the 12-character sha the build stamped. No second version line repeating "1" | ✅ 2026-09-07 — "Secure Test", `1.0.0 (c719eb586e45)` matching the stamp in the exported app's Info.plist |
| Close About; check the app menu itself | The first item is "About Secure Test", then a separator, then "Quit Secure Test" (Cmd-Q) — and Cmd-Q still ends a live session the way it did before | Not looked at 2026-09-07 (Cmd-Q not pressed this run; hand-in ended the session) |
| The main window's title bar | "Secure Test" (unchanged by this slice — the row is here to catch a regression from the display-name change) | Not looked at 2026-09-07 |
| Sign in: press Sign in with Google and look at the top of the sheet | A dark Pacific header strip carrying the white PSD emblem at the left, then "Sign in with your school account" in white, and Cancel at the right. The Google page below is unchanged, and sign-in completes as before | ✅ 2026-09-07 — Pacific header with the emblem; sign-in completed under the hardened runtime (real ClassLink + MFA) |
| With the sheet open, press Cmd-Q | Still tears the sheet down and quits — no beep (the `AuthSheetWindow` catch is untouched by the header change) | Not run 2026-09-07 |
| In a sitting, have the teacher request a peek and watch the student's notice strip | The strip is PSD Whulge (a mid blue-teal), not the previous indigo, and the text is still readable on it | Not run 2026-09-07 (no peek requested) |
| Look at the peek frame the teacher receives for that same request | The strip appears in the captured image in the same Whulge — `cacheDisplay` still paints it | Not run 2026-09-07 |

## Signed build — the notarized Developer ID app (release plan slice 2, 2026-09-07)

`docs/client-release-plan.md` slice 2. The app under test is the
`xcodebuild archive` → `-exportArchive` (method developer-id) → `notarytool
submit` (Accepted) → `stapler staple` output of `c719eb5`, signed with the
profile IT issued 2026-09-04 (`SecureTest Developer ID`, AAC capability,
expires 2044-08-30; Xcode's double-click did not install it — copied by UUID
into `~/Library/Developer/Xcode/UserData/Provisioning Profiles/`). Launched
through `client/scripts/launch-client.ts` against the origin with
`SECURE_TEST_SIMULATE_LOCKDOWN=` blanked (the variable sits in
`design-tool/.env.local`, and the launcher forwards it — the first launch of
the day ran SIMULATED for that reason; check the log's `lockdown session:`
line before trusting a run). Demo student, one-day teacher row inserted by
the ad-hoc script, `Chemistry sample` (16 items — an assessment the student
had never attempted, because an attempt is unique per assessment + student
and there is no delete path; roadmap finding 2026-09-07).

| Check | Expect | Result |
|---|---|---|
| Static checks on the exported app | `codesign -d --entitlements -` lists AAC + app-sandbox + network.client + files.user-selected.read-only; `Contents/embedded.provisionprofile` present; `codesign -vvv --deep --strict` valid; `spctl -a -vv` accepted, `source=Notarized Developer ID` after stapling; Info.plist carries `PSDBuildCommit` | ✅ 2026-09-07 — all six, before and after notarization (four entitlement keys plus the profile's application- and team-identifier) |
| Launch, sign in, join — any TCC or permission prompt | None (D-R4: self-render monitoring needs no Screen Recording) | ✅ 2026-09-07 — none at any point. **D-R4 CONFIRMED: no TCC grant, no PPPC profile needed for the shipping client** |
| Join a sitting on the entitled, hardened-runtime build | log: `lockdown session: REAL AEAssessmentSession (entitled binary)` → `begin() called` → `DID BEGIN`; the Mac visibly locks | ✅ 2026-09-07 — exact sequence; menu bar / Dock / switching gone |
| Answer and hand in inside the session | responses saved (`response: item=… type=…`), `handed in`, then `lockdown ending: hand-in confirmed` → `end() called` → `DID END`; the Mac comes back | ✅ 2026-09-07 — two essays + two short texts saved, handed in, clean `DID END`, desktop back |
| Join a sitting whose attempt is already submitted | refused client-side: `join declined: attempt … is already submitted — staying on the entry screen` (finding 10.1) | ✅ 2026-09-07 — seen on the `E6 / E7(b)` sitting during the (simulated) first launch, on the origin |
| KaTeX in the real session | sub/superscripts render in stems | ✅ 2026-09-07 — James: subscripts and superscripts displayed correctly in `Chemistry sample` |
| Predictive text in the essay inside the REAL session (finding 8.4) | no inline completion with `predictiveKeyboard=false` | **OPEN** 2026-09-07 — James did not watch for it; re-check on the next real sitting before closing 8.4 |
| Install `SecureTest-1.0.0.pkg` from the v1.0.0 release on a district Mac (Jamf or by hand), launch `/Applications/SecureTest.app` | Gatekeeper opens it with no warning; sign in, join, one real session (`REAL AEAssessmentSession` → `DID BEGIN` → hand in → `DID END`), no TCC prompt; About reads `1.0.0 (c719eb586e45)` | NOT RUN 2026-09-07 — waits on a district Mac (release plan slice 4's last row) |

Wanted after seeing the signed app (James, 2026-09-07), for batch 4's UI
pass: brand the grey AAC background, the home (entry) screen and the
hand-in buttons — recorded in `docs/client-ui-pass-design.md` §D.

## Observability slice 4 — `errors.log`, the drain, crash capture (2026-09-07)

`docs/observability-design.md` slice 4. The sink's line shape and the drain's
batching ARE covered by `swift test` (Core). What is not, and cannot be, is
everything below: each row needs a running app, a real server, and — for two
of them — a process that dies.

The file under test is
`~/Library/Containers/net.psd401.securetest.client/Data/Library/Application Support/SecureTest/errors.log`
(the sandbox container's Application Support, beside `responses.sqlite`). JSON
lines; read it with `tail -n 5 <that path>`. Every line carries `kind`,
`message`, `app_version`, `app_commit`, and `attempt_id` when an attempt was
open.

The crash row needs the app launched with `SECURE_TEST_DEBUG_CRASH=1`, which
is the only thing that puts **Session → Trigger Debug Crash (SIGABRT)** on the
menu. A shipped build has no such item.

| Check | Expect | Result |
|---|---|---|
| Launch the app and look at stderr | `[security] errors.log open at …/SecureTest/errors.log` — the sink opened. (If it says "errors.log unavailable", every row below is moot and that is the finding) | Not run |
| Signed OUT, enter a wrong session code and press Join | On screen: the usual join message. In `errors.log`: one new line, `"kind":"join_failed"`, `"context":{"via":"code"}`, this build's `app_version` / `app_commit`, and no `attempt_id` | Not run |
| Now sign in with Google (student account) | Within a second or two of the sign-in landing, stderr says `[security] errors: client-error drain sent N of N line(s)` and `errors.log` is EMPTY. Server side: a `client_error_events` row for that `join_failed` carrying this build's `app_commit` | Not run |
| Repeat the failed join with the SERVER STOPPED, then sign in against the stopped server | Nothing sent, and `errors.log` still holds the line — a failure keeps the file. Start the server and sign in again: it drains then | Not run |
| Launch with `SECURE_TEST_DEBUG_CRASH=1`, sign in, join a sitting, then Session → Trigger Debug Crash (SIGABRT) | The app dies at once (macOS may show its own crash report — that is the OS, not us). `errors.log` gained ONE line: `"kind":"crash"`, `"message":"fatal signal SIGABRT"`, this build's version and commit, and the `attempt_id` of the sitting just joined. It has NO `occurred_at` — a signal handler cannot read a clock | Not run |
| Relaunch and sign in after that crash | The drain sends the crash line; the server row carries `occurred_at` stamped at drain time (documented, not a bug) and `context.attempt_id` naming the attempt that died | Not run |
| Cause an error INSIDE an attempt — simplest is to join, stop the server, then answer an item (`SPOOL FAILED` / `responses DROPPED`) | The teacher's monitor row for that student flips to **Needs attention** while the sitting is still open (D-4, the `client_error` attempt event). The same error is also one line in `errors.log` | Not run |
| Same run, teacher side: open that attempt's event history | A `client_error` event with detail `{ kind, message }` — the kind is the short token (`spool_failed`, `responses_dropped`), not prose | Not run |
| `exit(70)`: launch with `SECURE_TEST_SIMULATE_LOCKDOWN=hangs`, join a sitting, press Cmd-E and wait out the teardown escalation | stderr: `lockdown UNRECOVERABLE — exiting`, process exits 70. `errors.log` gained one line, `"kind":"lockdown_unrecoverable"`, carrying the attempt id — written the same pre-formatted way the crash line is, because the main thread is presumed gone | Not run |
| Leave the attempt (Back to your tests), then cause any error on the entry screen | The new line has NO `attempt_id` — the binding is cleared when the attempt screen is torn down | Not run |
| Look at a line whose `message` came from a long error | Truncated at 2 000 characters; and nothing in any line is response text, a stem, a choice, a student name or a token (the design page's redaction rule) | Not run |

## Client sitting 2026-09-08 — results across the open row blocks

One real AAC sitting on the origin (James at the client, Claude on the
teacher side; fixture `Client rows hand-run 2026-09-08`, section-scoped
sitting, Debug build of `a755671`): `REAL AEAssessmentSession` → `DID BEGIN`
→ 23 responses across all ten items → handed in → `DID END`, no line in
`errors.log`. The first two launches hung on "Loading…" — the slice D
constraint defect fixed in `a755671` (see that commit; the lesson: an ObjC
exception inside a main-actor Task silently kills the main actor). What
each open block got from the sitting:

- **Batch 0b** — slice 1 (hotspot CSS): picture visible, regions clickable,
  multi-select posts (8 hotspot responses) ✅; **the selected fill is too
  subtle** (finding S-5). Slice 2 (math preview on every answer): the
  preview rendered; on malformed notation it shows raw `\mathrm{…` KaTeX
  error markup (finding S-4). Slice 3 (match mark on completion): three
  pairs posted; the mark itself was not watched.
- **Observability slice 4** — the sink opened at launch and stayed empty
  (nothing failed). **Pass two: crash + drain ✅** — with
  `SECURE_TEST_DEBUG_CRASH=1` (the launcher now forwards it, `528833f`)
  Session → Trigger Debug Crash wrote one line to `errors.log`
  (`{"kind":"crash","message":"fatal signal SIGABRT","app_version":"1.0.0","app_commit":"5b65f4cc28ca"}`, no `occurred_at` by design) and the
  app died; the next launch's sign-in logged `client-error drain sent 1 of 1
  line(s)` and the file is empty. The in-attempt `client_error` event row is
  still not run (no forced failure inside an attempt).
- **Slice A (theme)** — the page rendered on the tokens (James: Q7–Q10
  "all displays and functionality as expected"); **order rows sit too close
  to the stem and are too small** (finding S-3); the finish block, pips and
  focus ring were not called out either way.
- **Slice B (accommodations)** — NOT run (second pass with the overlay).
- **Slice D (entry screen)** — Pacific ground, white card, emblem, two
  rows, Join: ✅ ("good"); **the session-code field shows before sign-in**
  (finding S-2 — the old controller hid it); the hang fix above.
- **Slice E (drag-and-drop)** — **the gate FAILED under a real session:
  drag starts and the row follows the pointer, the drop never lands — the
  row snaps back** (finding S-1, the predicted `LockedDownWebView` outcome;
  the Move buttons still worked — 3 order responses posted). Fallback =
  pointer tracking driving the same `move()`.
- **Finding 8.4 CLOSED** — no predictive text appeared in the essay inside
  the real session with `predictiveKeyboard=false` (Q6), on this build.
- **Pass two + three (same afternoon, the copy fixture with Yellow on Black +
  Atkinson + 2.5×):** S-1 pointer drag ✅ under a real session, S-2 ✅, S-4 ✅,
  S-5/S-5b ✅, S-8 fullscreen at launch + after lock ✅, S-9 ✅; slice B's
  contrast / font / zoom rendered ("good"); crash + drain ✅ (above).
- **New asks (James):** a calculator-style keypad for math entry and
  handwriting input from the touchpad on short-text math (S-6); drawing
  tools — pen size / colour, eraser, undo — on the drawing item (S-7).

## Client UI pass — slice A (theme) (2026-09-07)

`docs/client-ui-pass-design.md` §A, decisions D-A1 (palette mapping) and D-A2
(light only). What `swift test` covers is the stylesheet TEXT — the token block
exists, no retired hex survives, the finish rules and the pip glyph and the
focus ring are present, both faces inline as `data:`. What it cannot cover is
anything with pixels in it, which is every row below.

Run them in one short sitting on a **Published, paged** assessment carrying a
stimulus set, a match, a short text with math, a drawing and a hotspot — the
same fixture shape the batch 0b rows want, so both sets can run together.
Screenshots are worth keeping: this is the first time the student page has had
a designed look, and a later pass will want the before.

| Check | Expect | Result |
|---|---|---|
| Open any test and look at the page as a whole | White paper, dark blue-green (Pacific) text — not the old near-black body ink. Nothing louder than the item | Not run |
| Body and heading type | Body text is **Inter**, the assessment title is **Josefin Sans** — compare against the design tool's own header in a browser beside it. If either falls back to the system face (San Francisco), the vendored woff2 did not load: check `PageFonts.shared.missing` | Not run |
| A stimulus set | Sea Foam panel, Driftwood hairline, a **Whulge** (teal-blue) left rule — not the old bright blue. Its eyebrow label ("Questions 3–5") is Josefin Sans, uppercase, in the soft ink | Not run |
| A passage on its own page, then a question page | "Show the passage" is Whulge, not bright blue | Not run |
| Paged strip, an answered question | Cedar green border and text, and the pip's own label carries a check mark ✓ | Not run |
| Paged strip, a partly-answered set (answer one of its two questions) | Ochre/amber border and text **and** a trailing `…` glyph — state is never colour alone (WCAG 1.4.1) | Not run |
| The current page's pip | Filled Whulge with Skylight text (5.97:1); an answered or partial pip that is also current still reads its label | Not run |
| Press Next / Previous, then look at the page heading | The heading takes focus AND shows a visible Whulge ring around it (2 px, offset). Before slice A the ring was suppressed and nothing appeared to move | Not run |
| Tab through one question page with the keyboard only | Every control shows a ring; the hotspot regions show their dashed Whulge outline on focus (unchanged from batch 0b) | Not run |
| The review page's "Finish and hand in" | A real filled button: Whulge fill, Skylight text, rounded, and it dims when disabled. The words are unchanged — "Finish and hand in", then "Handing in…", then "Handed in. You can close the app." in the soft ink below it | Not run |
| Hand in, then the way-home button | "Back to your tests" sits beside the (now disabled) hand-in button and still works | Not run |
| Offline: `--bundle` / Cmd-O on a saved bundle | The notice under the title is the Ochre pair on a pale amber wash (`--warn`), not the old yellow; it still reads "Offline mode: answers are not saved to a server." | Not run |
| A stem carrying `$x^2$`, and a short-text answer's math preview | KaTeX renders exactly as before — its own stylesheet is untouched and its faces still inline | Not run |
| A drawing item with `grid` / `axes` paper | The graph paper is unchanged (its colours are canvas paint, deliberately NOT tokens — they are baked into the uploaded PNG) | Not run |
| Teacher side: peek this student while all of the above is on screen | The returned frame shows the new palette and the peek strip is unchanged (still drawn in `draw(_:)`) | Not run |
| An item type this build does not know (older bundle) | "This item type (…) is not available yet." in the soft ink, italic — readable, not the old near-black grey | Not run |

**Payload note (measured 2026-09-07, one-item page, KaTeX inlined as always):**
the built page is **718 067 → 821 244 characters**, +103 177 (+14.4 %). All of
it is the two brand faces (`PageFonts.shared.css` is 103 138 characters —
~101 KB of base64 for a 48 KB and a 29 KB woff2). The page is built once per
attempt and never fetched again, so this is paid once at bundle load. Slice B's
optional dyslexia face would add a third; D-B2 (inline only the SELECTED
optional font) is what keeps that from compounding.

## Client UI pass — slice D (entry screen, AppKit branding, a11y) (2026-09-07)

`docs/client-ui-pass-design.md` §D, D-D1. Everything below is AppKit drawing
and layout, so none of it is reachable from `swift test` (no window server) —
each row needs the app on screen. Build first:
`cd client && xcodebuild -project SecureTest.xcodeproj -scheme SecureTest -destination 'platform=macOS' build`,
then launch the built app (`client/scripts/launch-client.ts`).

The entry screen is now a white card, capped at 520 pt and centred on a
Pacific ground, headed by the white PSD emblem and "Secure Test" — the same
shape as the sign-in sheet's header. The window's minimum content size is
720 × 620.

| Check | Expect | Result |
|---|---|---|
| Launch and look at the window before signing in | The ground around the card is Pacific `#25424c`, edge to edge — no system grey anywhere, including the strip under the titlebar | Not run |
| Join a sitting and watch the moment between screens | While "Loading your test…" is up, and in any gap before the page paints, the ground behind the web view is Pacific, not grey | Not run |
| Inside a session, press "End secure session", then look at the window | Still Pacific behind and around the page; the "Back to your tests" titlebar button is a filled Whulge button with light text | Not run |
| The card header | White PSD emblem at 24 pt, "Secure Test" beside it in light text on Pacific; nothing clipped | Not run |
| At 980 × 700 (the launch size), signed in with 2+ sittings | Each row is TWO lines — assessment name on top, `<code · where — teacher> · closes <time>` underneath — across the card's full width, with NOTHING truncated on the second line (this is the `docs/phase-7-slices.md` 250-px finding) | Not run |
| Drag the window down to its minimum | It stops at 720 × 620. The card is still whole: header, account row, three sitting rows, code row and the status line all visible; the two-line rows still do not truncate | Not run |
| Make the window very wide (full screen on a large display) | The card stays 520 pt and stays centred — it does not stretch | Not run |
| The primary buttons (Join / Resume, Sign in with Google, and the two titlebar buttons) | Whulge `#346780` fill, Skylight `#fffaec` text, rounded; pressing one darkens it; a disabled one (Join before sign-in) is visibly faded | Not run |
| Tab to a primary button (Full Keyboard Access on: System Settings → Keyboard) | A standard macOS focus ring is drawn around the button's rounded shape — not suppressed | Not run |
| A sitting whose attempt is submitted | The row reads "Done" as a word PLUS a Cedar `checkmark.circle.fill` symbol — state is never the tick or the colour alone | Not run |
| Notice pages: launch with no bundle (`--bundle` with a missing file, or File → Open on a non-bundle) | The notice is a Sea Foam card with a Driftwood border on white, Pacific heading, the detail line in `#5a6c73` — no grey `#6b6b70` anywhere | Not run |
| Notice page: "Loading your test…" | Same treatment as above | Not run |
| VoiceOver (Cmd-F5) over the entry screen, signed in | Every control is read with a useful name: "Peninsula School District" (emblem), "Sign in with your school Google account" / "Sign out of this Mac", "Refresh the list of your tests", each row as "<assessment>. <detail>" with its button as "Join <assessment>" / "Resume <assessment>" or "<assessment>: handed in", "Session code" for the field (with its help text), "Join the test with the session code you typed", and the status line | Not run |
| Keyboard-only join by code | Tab from the code field to Join and press Space/Return — the join runs; no mouse touched | Not run |
| Keyboard-only join from the list | Tab reaches each row's Join/Resume button in list order and activates it | Not run |
| The sign-in sheet (Sign in with Google) | Unchanged from before this slice: 520 × 760, Pacific header, emblem, "Sign in with your school account", Cancel; Google's page below | Not run |
| Peek frame while a teacher views the screen | The captured frame is unchanged: the Whulge notice strip still appears in it, the page content is intact | Not run |
| Exit paths, unchanged | The titlebar "End secure session" button ends the session; Cmd-E does too; Cmd-Q mid-session ends then quits; the watchdog still fires | Not run |

## Client UI pass — slice B (accommodations) (2026-09-07)

`docs/client-ui-pass-design.md` §B, decisions D-B1 (Atkinson Hyperlegible) and
D-B2 (inline only the selected optional font). `swift test` covers the layer
under the paint — which attribute lands on `<html>` for every catalog value,
that the stylesheet carries all eight contrast sets and all nine zoom rules,
that the recorded ratios match their hexes, and that an unaccommodated page
carries no attribute and none of Atkinson's bytes. Everything below has pixels
in it and cannot be covered here.

**Setup — one sitting, values cycled rather than one student per pair.**
Eight students with eight different contrast entitlements is not a realistic
ask, so: one demo student, one Published **paged** assessment carrying a
stimulus set, a match, a short text with math, a drawing (`grid` paper) and a
hotspot with a real PNG — the same fixture the batch 0b and slice A rows want,
so all three sets run together. Between rows, edit that student's
accommodations overlay in the design tool (Students → the student → the
per-student edit), then **rejoin** — the attributes are resolved when the page
is built, so a change needs a fresh page, not a reload of the same one.

Keep a screenshot per contrast pair; they are the record that the eight sets
ship, and a later pass will want the before.

| Check | Expect | Result |
|---|---|---|
| No contrast / font / zoom entitlement at all (start here) | The slice A page exactly: white paper, Pacific ink, Whulge accent. In Web Inspector the `<html>` tag has NO `data-` attribute | Not run |
| Set Color Contrast = **Black on Rose**, rejoin | Pale rose page, pure black text everywhere — including the stimulus eyebrow, the formula hint and the finish status, which are the soft ink in the default palette and are NOT softened here. Stimulus panel is a deeper rose, not Sea Foam | Not run |
| **Black on White** | White page, pure black text. Distinguishable from the default page: the accent is black, not Whulge — the current pip and the finish button are black-filled with white text | Not run |
| **Medium Gray on Light Gray** | Light grey page, medium grey text — the lowest-contrast set, deliberately. It must still be comfortably readable: the shipped values are `#595959` on `#e0e0e0`, 5.31:1, adjusted up from the dictionary's literal pair (2.63:1, below AA) | Not run |
| **Red on White** | White page, deep red text (`#d40000`, 5.53:1 — the dictionary's literal `#ff0000` is 4.00:1). Green / amber / red state colours are still each distinguishable from the red ink | Not run |
| **Reverse Contrast** | Black page, white text. Check the KaTeX math specifically — it inherits `currentColor`, so a formula must be white, not an invisible black-on-black | Not run |
| **White on Red** | Deep red page (`#c40000`), white text. The pale green / amber / pink state colours read on it | Not run |
| **Yellow on Black** | Black page, yellow text | Not run |
| **Yellow on Blue** | Deep blue page, yellow text | Not run |
| In ANY contrast set: tab to the "Finish and hand in" button | The focus ring is visible ON the filled button — a pale halo hugging it with a dark ring outside. (Slice A drew a plain `--ink` ring, which would be invisible on an `--ink` fill in every set here) | Not run |
| In ANY contrast set: the answered / partial pips in the pager strip | Answered = green border + ✓ in its label; partial = amber border + trailing `…`. Both readable against that set's ground | Not run |
| In ANY contrast set: the offline notice (Cmd-O on a saved bundle) | The amber wash follows the set — it is `--warn` mixed into `--paper`, so it is never a pale-yellow box on a black page | Not run |
| Set Optional Font = **On** (contrast off), rejoin | Every word on the page is **Atkinson Hyperlegible** — the give-aways are the flat-topped `l`, the tailed `I`, the slashless but heavily differentiated `0`/`O` and `b`/`d`. The assessment title too, not just the body: the heading token switches with the body token | Not run |
| Same, a stem containing bold text and the pager's current-page label | The bold is a REAL bold face, not a smeared synthetic one (the 700 weight is vendored alongside the 400) | Not run |
| Optional font ON, then look at a KaTeX formula | Math still renders in KaTeX's own fonts — that is correct and deliberate; the accommodation swaps the prose faces, not the mathematical typography | Not run |
| Optional font OFF again, rejoin | Back to Inter / Josefin Sans. In Web Inspector, search the document source for "Atkinson" — the `@font-face` block is GONE (D-B2: the ~46 KB is inlined only when selected; the CSS rule stays and matches nothing) | Not run |
| Set Zoom = **1X (Default)** | Indistinguishable from no zoom entitlement | Not run |
| Set Zoom = **2.5X** | Everything is 2.5× — body, heading, buttons, the pager. Nothing is left behind at its old size (a px value that should have been `rem`) | Not run |
| Zoom **3X**, on a question page, at the default 980 × 700 window | No horizontal scrollbar on the page body. The pager bar at the bottom **wraps** — Previous / "Question 3 of 8" / Next stack rather than pushing off the edge, and the jump strip wraps under it | Not run |
| Zoom 3X, scroll to the bottom of the review page | The "Finish and hand in" block is reachable and NOT hidden behind the fixed pager bar (the body's bottom gutter is `7rem`, so it grows with the zoom) | Not run |
| Zoom 3X, then shrink the window to its minimum | Still no horizontal scroll of the body; the pager bar is capped at 60 % of the window height and scrolls internally if it needs to | Not run |
| Zoom 3X, a drawing item: draw a stroke and check where the ink lands | The ink lands under the pointer. The canvas is CSS-scaled to the column but records in canvas coordinates — the mapping divides by the live `getBoundingClientRect()` width on every pointer move, so this is expected to be unchanged; the row exists to prove it | Not run |
| Zoom 3X, save the drawing, then view it teacher-side in the review queue | The saved PNG is the canvas's own resolution — unaffected by zoom | Not run |
| Zoom 3X, a stem with `$\frac{a}{b}$` | The formula scales with the text, not independently of it | Not run |
| **Contrast + zoom + optional font together** (e.g. Yellow on Blue, 2.5X, font On) | All three at once, no interference: yellow-on-blue Atkinson at 2.5×. This is the realistic accommodated student | Not run |
| Teacher side: peek this student mid-sitting with all three on | The returned frame shows the accommodated page — the contrast set, the face and the zoom — because the client renders itself (`cacheDisplay`, finding #14). A teacher seeing the default page here would mean the peek path re-renders instead of capturing | Not run |
| Set a streamlined-only zoom level (**10X (Streamlined Mode Only)**) | The page renders at **2×**, not at 10× — the streamlined levels are clamped into the 1.0–3.0 range this layout is verified to hold, because Streamlined Interface Mode is not implemented. **This is a decision awaiting James**: confirm the clamp or schedule the streamlined layout | Not run |
| Set a value this client does not know (hand-edit the overlay to a nonsense value if the UI allows it) | The page renders with NO attribute — the default palette, default font, zoom 1. It never renders a half-applied theme | Not run |

**Payload note (measured 2026-09-07, one-item page, KaTeX and the two brand
faces inlined as always):** an unaccommodated page goes **821 244 → 825 725
characters** (+4 481, +0.5 %) — the accommodation stylesheet is 3 028 of that
and ships on every page so the attributes have something to match. A contrast
or zoom page adds only the attribute itself (+31). Selecting the optional font
adds **46 677 characters** (+5.7 %) — the base64 of Atkinson's 400 and 700
latin subsets, and only for the students who asked for it (D-B2).

## Client UI pass — slice E (order drag-and-drop), rewritten by fix slice S-1

Written 2026-09-07, **rewritten 2026-09-08 for the pointer path**
(`docs/client-ui-pass-design.md` §E + the S-1 row of the 2026-09-08 findings).
The first version of these rows used HTML5 drag-and-drop; the 2026-09-08
sitting proved the drop never lands inside a real AAC session — the row lifts
and snaps back — so the interaction is now pointer tracking
(`pointerdown` / `pointermove` / `pointerup` with pointer capture) and the
HTML5 path is gone entirely. `LockedDownWebView` was NOT changed.

`swift test` covers the reorder itself: a pointer drop and the equivalent run
of Move presses leave the same `ordered_ids`, a drop posts exactly once,
`pointermove` posts nothing, Escape and `pointercancel` change nothing, and a
press that starts on a Move button does not start a drag. What it cannot cover
is what a real pointer does inside WebKit, what the indicator looks like, or
VoiceOver.

**Row 1 is the gate, and it runs under a REAL AAC session** — the failure this
slice exists to fix only appears there. A simulated session is not evidence.

Needs a Published assessment with an order item of four or more entries, a
sitting, and the log of the response posts (stderr `SPOOL`/`POST` lines, or the
teacher's event history) to count them.

| Check | Expect | Result |
|---|---|---|
| **Under a real AAC session** (entitled build, `SECURE_TEST_SIMULATE_LOCKDOWN` blank): press a row and drag it **down two places** | The row follows the pointer at reduced opacity and does NOT snap back; an accent line shows on the row under the pointer, on the side the pointer is nearer; on release the row lands where the line promised and the numbers 1..n renumber. **Exactly ONE response posted** for the drag (not one per pointer move) — count it in the log | Not run |
| Same session: drag a row **up two places** | Same, upward; one post | Not run |
| Drag the last row to the **first** position (release on the top half of row 1) | It lands first, everything else shifts down one; one post | Not run |
| Drag the first row to the **last** position (release on the bottom half of the last row) | It lands last; one post | Not run |
| Release the pointer **above the first row / below the last** (overshoot the list) | The move still lands at that end rather than being discarded; one post | Not run |
| Start a drag and press **Escape** before releasing | The drag ends, the indicator clears, the dragged row returns to its place, the list is exactly as it was, and NO response is posted | Not run |
| Release a row **on itself** (press and let go without moving) | Nothing moves, nothing posted, no stray selection or context menu | Not run |
| Press and hold on a **Move button** and drag from there | No drag starts (the row does not lift); releasing over the button still performs the button's move, once | Not run |
| **Move up / Move down still work**, and VoiceOver | The buttons reorder as before; VoiceOver reads "Drag to reorder, or use the Move buttons" as the list's description, still announces each button as "Move up" / "Move down", and after every move (button or drag) speaks "<label> moved to position k of n" | Not run |
| Drag with a **trackpad** (click-and-hold, then move) as well as a mouse | Identical behaviour — a touchpad is a pointer; the page does not scroll or select text while dragging | Not run |
| Under **zoom 3.0** (accommodation) | Rows, labels and buttons scale; the drop indicator scales with them (it is in rem) and is still clearly on one edge of a row, not a smudge | Not run |
| Under a **contrast pair** (any of the eight), start a drag | The indicator line is visible against that pair's paper — it takes the pair's accent, not the default blue | Not run |
| After a drag, check the **answered mark** | The item marks answered exactly as a Move press marks it — green in the pager strip, counted in "k of N answered". Hand in, and the teacher's queue shows the dragged order | Not run |

## Fix slice S-8 / S-9 / S-5b (2026-09-08, pass two)

Three small fixes from a second sitting on 2026-09-08
(`docs/client-ui-pass-design.md` §Progress "Fix slice S-8 / S-9 / S-5b
BUILT 2026-09-08"). No prior "Fix slice S-1…S-5" section existed in this
file or in the design doc's §Progress at the time these rows were written
— the heading name below anticipates that numbering rather than renaming
an existing section. Needs a Published assessment with a match item, a
hotspot item carrying a real PNG, and either a real AAC session or a
simulated one (S-8's launch-time fullscreen is independent of AAC and can
be checked in either).

| Check | Expect | Result |
|---|---|---|
| Launch the app (real or simulated session) | The main window fills the screen full-screen almost immediately after the entry screen (or the assessment, on `--bundle`) appears — no separate action needed | Not run |
| Join a sitting and let the AAC session reach `DID BEGIN` (real session) | The window is (or becomes) full screen at that point; if it was already full screen from launch nothing visibly changes | Not run |
| Launch with `SECURE_TEST_NO_FULLSCREEN=1` | The window stays windowed at its normal launch size; stderr logs `SECURE_TEST_NO_FULLSCREEN=1 — staying windowed` | Not run |
| Exit full screen mid-session (green button or the gesture) | It exits normally — the app does not fight it or force it back | Not run |
| Open an assessment with a 2+ pair match item | Each pair row is visibly taller and roomier than before (not flush against the stem or against each other), the row spacing reads as deliberate, and the dropdown is comfortably wide (not clipped to the option text) | Not run |
| Under zoom 3.0 (accommodation), same match item | The rows and dropdown scale with the rest of the page (rem sizing) | Not run |
| Open an assessment with a hotspot item, select a region | The selected region reads as a light accent tint over the picture (not a near-solid block) — the picture underneath the selected region is still legible; the 3px border and inset paper hairline are unchanged | Not run |
| Resume: answer by dragging, quit, relaunch, Resume | The dragged order is restored (P-1 prefill), the status line is empty again, and nothing is posted by the restore itself | Not run |

## Fix slice S-1…S-5 (2026-09-08)

The five findings from the 2026-09-08 sitting
(`docs/client-ui-pass-design.md`, "Findings from the 2026-09-08 sitting" and
its §Progress). S-1's rows are the slice E block above, rewritten for the
pointer path — run those first, and the real-session row before any of them.
S-2 is AppKit, so `swift test` says nothing about it at all; S-3 and S-5 are
CSS, which is not harness-testable by construction; S-4's copy and its
"keep the last render" behaviour are covered headlessly, its appearance is not.

| Check | Expect | Result |
|---|---|---|
| **S-2** Launch the client signed out (every launch is signed out) | The sign-in prompt is all that shows: NO "Or enter a code from your teacher" heading, NO code field, NO Join button, and no rule above where they were. The layout closes up rather than leaving a gap | Not run |
| **S-2** Sign in with the school Google account | The heading, the code field, the Join button and the rule appear, below the tests list, and the code field accepts a code and joins as before | Not run |
| **S-2** Sign out again from the entry screen | The block disappears again, and the status line says to sign in first | Not run |
| **S-2** Launch with `--token` / `SECURE_TEST_TOKEN` (dev path, no Google sign-in) | Counts as signed in: the tests list AND the code block both show, and joining by code works | Not run |
| **S-3** On the order item, read the rows at default zoom | Each row is at least ~44 pt tall with comfortable padding, the label is body-sized (not the old small type), and the position number and the Move buttons are easy to hit with a mouse | Not run |
| **S-3** Same item under zoom 2.5 / 3.0 and under one contrast pair | Everything scales together (all rem, all tokens) — no fixed-size row, no clipped label, no button overlapping the label | Not run |
| **S-4** In a short-text item, type an incomplete formula (e.g. `\frac{`) | Under the field: the plain grey note "Can't read that as math yet — keep typing." — NOT KaTeX's red error text and NOT the raw source in red | Not run |
| **S-4** Type a valid formula (`H_2O`), then break it (`H_2O \frac{`) | The rendered `H₂O` STAYS on screen with the note beside it; it does not blank out | Not run |
| **S-4** Finish the formula so it parses again | The note disappears and the new render replaces it; clearing the field empties the preview entirely | Not run |
| **S-4** With VoiceOver on, type an incomplete formula | The note is announced politely (it does not interrupt typing), and the field's own value is unaffected — the answer posted is still the raw typed text | Not run |
| **S-5** On a hotspot item, select a region | The chosen region is unmistakable: a solid accent wash with a heavy accent border and a light hairline inside it, readable over both light and dark artwork | Not run |
| **S-5** Hover a different region while one is selected | The hover wash is clearly LIGHTER than the selected one — the two states are never confusable | Not run |
| **S-5** Tab to the regions with the keyboard | Every region shows a visible focus ring, including the selected one; the ring is distinguishable from the selected fill | Not run |
| **S-5** Repeat under one contrast pair and at zoom 3.0 | The selected state takes that pair's accent and stays visible; the region still tracks the picture | Not run |
