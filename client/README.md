# client — macOS secure-test student client

The student-facing app: renders an assessment delivered by the design tool
inside a locked-down `WKWebView`, inside a real `AEAssessmentSession` when the
binary carries the Automatic Assessment Configuration entitlement (App ID
`net.psd401.securetest.client`, real sessions hand-run since 2026-08-27) and
a simulated session otherwise.

Supersedes `poc-b-test-loop/client`, which stays as the PoC record. The
hardening here is ported from PoC-B's measured results, not reinvented.

## Layout

```
client/
  SecureTestCore/          SwiftPM package — all logic, headless-testable
    Sources/SecureTestCore/
    Tests/SecureTestCoreTests/
  SecureTest/              AppKit app sources (file-system synchronized group)
  SecureTest.xcodeproj/    the app target
```

**Why both.** Logic lives in the package so `swift test` can exercise it with no
Xcode, no window server, and no browser automation — headless Chrome and
Playwright both hang in this dev environment (ADR 0013, and the
`headless-chrome-unavailable` note), so anything verifiable only by driving a UI
is effectively unverifiable here.

The app is an `.xcodeproj` rather than a SwiftPM executable because SwiftPM
packages opened in Xcode do not expose the Signing & Capabilities tab, which is
where the restricted AAC entitlement and Developer ID signing live
(`poc-a-aac-capture/README.md`). `SecureTest/SecureTest.entitlements` carries
the AAC key; the sandbox keys are synthesized from `ENABLE_*` build settings
and merged at signing (verify with `codesign -d --entitlements -`).
`SecureTest/RealLockdownSession.swift` is the only file that touches
`AutomaticAssessmentConfiguration`.

## Build and test

```bash
cd client/SecureTestCore && swift test          # the logic
cd client && xcodebuild -project SecureTest.xcodeproj \
  -scheme SecureTest -destination 'platform=macOS' build
```

## Current state

Feature-complete against the student plane, including sign-in.

A student signs in with Google (verified live 2026-08-27), sees their
pre-assigned sittings under "Your tests" (slice 84), joins one — or enters a
code for an ad-hoc sitting — is resolved to their roster row, gets a bundle
carrying their own accommodations, answers any of the eight item types, and
has every answer written to disk before it is sent. The full loop was run by
hand 2026-08-27: list → join → answer → hand in → "Done", and in a real
`AEAssessmentSession` the same night (slice 93): an entitled binary locks
the Mac; `SECURE_TEST_SIMULATE_LOCKDOWN` or an unentitled build runs the same
lifecycle simulated. What is missing is a signed, packaged release
(`docs/client-release-plan.md`).

What works:

- **Sign-in** — Google OIDC + PKCE (slice 80); since 2026-08-31 the
  session lives only in memory: every launch starts signed out and demands
  a real Google sign-in (`prompt=login`), and a crash mid-test costs a full
  re-auth before Resume — accepted, nothing outlives the process on a
  shared lab Mac.
- **"Your tests"** — the signed-in student's pre-assigned sittings
  (slice 84): Join with no code, Resume for an in-progress attempt, "Done"
  after submit, and the teacher closing a sitting drops it on Refresh.
- **Join by code** — code entry, redeem, start-or-resume attempt (kept for
  ad-hoc sittings).
- **All eight item types** render and are answerable: multiple choice (single
  and multi), short text, essay with a live word count and rubric, match, order,
  hotspot, and drawing on a canvas.
- **Answers** are spooled to SQLite first and flushed to the server after, so a
  dropped network or a crash does not lose work.
- **Drawings** upload through a registered slot — presigned to S3 where the
  backend supports it, otherwise back through an authenticated app route.
- **Accommodations** arrive per-student, resolved server-side from the
  assessment's allowed list, the student's TIDE entitlements, and any
  per-assessment override.
- **Clipboard** is locked unless the assessment permits it, enforced both in the
  page and on the app's Edit menu.

## Running it

```bash
# Against a local design-tool, signing in with Google (needs the native
# client id; the design tool's OIDC_AUDIENCE must list it too).
SECURE_TEST_GOOGLE_CLIENT_ID=<native client id> SECURE_TEST_SERVER=http://localhost:3000 \
  ./SecureTest.app/Contents/MacOS/SecureTest

# Against a local design-tool, with a session token minted by hand.
SECURE_TEST_SERVER=http://localhost:3000 \
  ./SecureTest.app/Contents/MacOS/SecureTest --token "<session jwt>"

# Or offline, to look at the renderer without a server at all. The app is
# sandboxed, so an argv path is readable only from the app's own container —
# from anywhere else use File → Open Test Bundle… (Cmd-O) on the entry screen.
./SecureTest.app/Contents/MacOS/SecureTest --bundle path/to/delivery-bundle.json
```

The offline path (`--bundle`, or File → Open Test Bundle…) is how the renderer
is exercised in this environment and is worth keeping: without it the item
renderers become unobservable the moment a server is required. It opens no
attempt, reports no events and never locks down; the menu item is disabled for
as long as a server-delivered attempt is on screen (`OfflineBundle.canOpen`).

**Full screen at launch (fix slice S-8).** The main window enters macOS full
screen as soon as it is on screen, and again as a backstop when a lockdown
session becomes active if it somehow is not already full screen. This is
independent of the AAC lockdown itself — it just removes the windowed chrome
before and between attempts — and exiting full screen is never blocked by the
app. Set `SECURE_TEST_NO_FULLSCREEN=1` to keep the window windowed, which is
usually what you want for `--bundle` / dev runs so repeated relaunches do not
each fight the fullscreen animation:

```bash
SECURE_TEST_NO_FULLSCREEN=1 \
  ./SecureTest.app/Contents/MacOS/SecureTest --bundle path/to/delivery-bundle.json
```

## Lockdown posture

Ported from PoC-B, where each item below was verified by hand
(`poc-b-test-loop/RESULTS.md`):

- **Context menu suppressed** — `LockedDownWebView` swallows `rightMouseDown`,
  returns `nil` from `validRequestor(forSendType:returnType:)`, and empties
  `willOpenMenu`. All three are needed: `willOpenMenu` alone misses the Services
  and Autofill injection paths, which is how a default `WKWebView` ends up
  offering "Search with Google", "Share…" and "Services ›" mid-assessment.
- **Navigation locked** — only the initial `about:blank` from `loadHTMLString`
  is allowed; everything else is cancelled and logged.
- **No origin** — `loadHTMLString(_:baseURL: nil)` yields a no-origin document,
  which WebKit denies `localStorage` and `document.cookie`. Nothing the page
  does can persist across items or relaunches.
- **CSP `default-src 'none'`** — no network from the page at all. `connect-src`
  is deliberately absent so it inherits the deny. Responses leave only through
  the named `WKScriptMessage` handler.
- **Main menu present** — without it, Cmd-V and Cmd-F silently no-op (there is
  no menu item for the responder chain to dispatch to). Paste matters for a
  student pasting assistive-tech output.
- **Nothing can be dropped onto the page** — dragged types are unregistered, so
  a file or a block of text from another app cannot land on the answer surface.
  That route bypasses the CSP and the navigation delegate entirely, since no
  request and no navigation are involved.
- **No second web view, no file picker, no JS dialogs** — a second view would
  carry none of this hardening, a file picker is a filesystem browser, and a
  modal during an assessment is at best a distraction.
- **No Touch Bar** — it surfaces text suggestions and app controls without ever
  consulting the menu bar, so the clipboard policy would not apply to it.
- **JSON payload escaped for `<script>`** — `JSONEmbedding` escapes `<`, `>`,
  `&`, U+2028 and U+2029. PoC-B interpolated raw JSON into an inline script, so
  a stem containing `</script>` could have closed the element and injected
  markup that CSP's `script-src 'unsafe-inline'` would then execute.
- **Clipboard locked by default** — the assessment must opt in. Enforced twice:
  `document.oncopy/oncut/onpaste` refuse the event in the page, and the app's
  Cut/Copy/Paste menu items are built disabled. Absence of the flag on the wire
  means locked, so an older client or server fails closed.
- **No answer key ever reaches the client** — the student bundle is a different
  wire type from the teacher's export, with no field that can hold one. Match
  and order options additionally carry per-attempt ids derived server-side, so
  the pairing and the sequence cannot be read out of the bundle file.

## Not yet done

One gap is external, one is now ours.

- **AAC.** The lifecycle is wired, the session is not real yet. AAC-1
  (2026-08-27) put `AssessmentLockdown` behind the app: a server-delivered
  attempt begins a session on bundle load, hand-in and Cmd-Q end it (quit
  re-issued from the teardown confirmation, never `.terminateLater`), a
  titlebar "End secure session" control is always visible, the watchdog
  defaults short (600s; `SECURE_TEST_WATCHDOG_SECONDS` overrides), and an
  unconfirmed end exits the process rather than hanging. What runs behind it
  is `SimulatedLockdownSession` — automatic whenever the entitlement is
  absent, with `SECURE_TEST_SIMULATE_LOCKDOWN=refuses|hangs|interrupts` to
  rehearse the failure modes — and forces the simulation even on an entitled
  build. **AAC-2a is BUILT (2026-08-27):** `RealLockdownSession` (the app
  target's only `AutomaticAssessmentConfiguration` file) adapts a real
  `AEAssessmentSession` to `AssessmentLockdown.Session`; the entitlement is in
  `SecureTest/SecureTest.entitlements` (AAC key only — sandbox keys stay
  synthesized from `ENABLE_*` build settings) with `CODE_SIGN_ENTITLEMENTS` set
  by hand in the pbxproj, never via Xcode's capability UI. Selection per
  begin(): env override → simulated; entitled binary → real (THE MAC LOCKS);
  else simulated. **App ID — the client signs as itself (2026-09-03):**
  `PRODUCT_BUNDLE_IDENTIFIER = net.psd401.securetest.client`, an App ID an
  admin created with the restricted AAC capability enabled. The dev-only
  borrow of PoC-A's App ID (`net.psd401.securetest.PocA`) is over; PoC-A keeps
  that identity on purpose as the OS-release regression harness. The
  entitlement is granted PER APP ID, and the failure mode is silent: an
  identifier pointing at an App ID without the capability still builds and
  signs, `binaryHasEntitlement` reads false, and the app runs the SIMULATED
  session while a hand-run looks like it passed. After ANY signing change,
  verify `codesign -d --entitlements -` on the built app shows the AAC key AND
  all three sandbox keys. **AAC-2b is BUILT (2026-08-28):**
  `LockdownConfigurationPlan` in SecureTestCore maps
  `DeliveryBundle.accommodations` onto the three session knobs macOS offers
  (`spell_check`→`allowsSpellCheck`, `word_completion`→
  `allowsPredictiveKeyboard`, `closed_captioning`→
  `allowsAccessibilityLiveCaptions`) — presence is the signal, everything
  else stays at the restrictive default on purpose (autocorrect, screenshots,
  Text Replacement shortcuts; `permissive_mode`/secondary apps is its own
  future slice; dictation is the documented platform gap). The mapping is
  unit-tested in Core; `RealLockdownSession(plan:)` applies it
  property-for-property, and every begin logs
  `lockdown config plan: …` for real and simulated backings alike.
  Remaining: the AAC-2b real-session MANUAL-CHECKS rows (need a student
  granted the tools). `docs/unblock-checklist.md` steps A-D have the wiring. The teacher-alert
  loop is CLOSED as of slices 91+92: the server's
  `POST /api/attempts/:attemptId/events` (contract in
  `docs/phase-7-slices.md`, "Client contract for slice 91") and this app's
  `AttemptEventReporter` — quit, emergency exit (button/watchdog), focus
  loss/regain, and the lockdown lifecycle all post fire-and-forget; a failed
  post is logged and dropped, never allowed to block an exit path. Hand-run
  rows: MANUAL-CHECKS "Event reporting (slice 92)". **On-demand peek is wired
  the same way (P2, 2026-08-28, `docs/on-demand-peek-design.md`):**
  `PeekResponder` polls `GET /api/attempts/:id/peek/pending` every 5 s while
  a server-delivered attempt is on screen; a pending request shows the
  student the banner FIRST ("Your teacher is viewing your screen", dismissable — × on the strip, re-shown by the next peek —
  "viewed at H:MM" after), then the app renders ITSELF —
  `AssessmentViewController.renderPeekFrame`, `cacheDisplay` per PoC-A
  finding #14, no screen capture, no TCC — and uploads a ≤1280 px JPEG
  fire-and-forget. Stopped at hand-in, deliberately NOT at lockdown end.
  Verified inside a real locked session 2026-08-28 (MANUAL-CHECKS
  "On-demand peek").
- **The exit path, whenever the session does get written.** PoC-A proved on
  2026-08-26 that an app can begin a session and leave no way out; recovering
  that Mac took a forced shutdown. AAC suppresses app switching, so nothing
  outside the app can rescue it, and the person trapped here would be a student
  mid-assessment. Non-negotiable in the same change as `begin()`: hand-in ends
  the session, quitting ends the session, a session that outlives its attempt
  ends itself, and there is always a visible control that says what it does. See
  `poc-a-aac-capture/RESULTS.md` finding #10 — and finding #12, where that same
  shape (watchdog, button, Cmd-E, Cmd-Q) was verified to release a real session
  on 2026-08-26. One caution from those runs: `allowsKeyboardShortcuts` at its
  default did not stop the app's own Cmd-Q, so this app must refuse quit itself
  while an attempt is open.

  Two specifics PoC-A paid for, both of which apply here verbatim:

  - **Do not return `.terminateLater` from `applicationShouldTerminate` to wait
    for teardown.** AppKit then waits in a nested run loop that does not drain
    `DispatchQueue.main`, so neither the session's confirmation nor any
    main-queue fallback timer ever runs, and the app hangs with the session live
    (RESULTS finding #11). Use `.terminateCancel`, end the session, and re-issue
    the quit from the confirmation. Hand-in is exactly this shape.
  - **Put the last-resort backstop off the main queue.** A watchdog that shares a
    thread with the thing it is watching is not a watchdog.

  Both are verifiable before any entitlement is involved, and now are:
  `SecureTestCore/AssessmentLockdown.swift` holds the state machine, watchdog,
  escalation and teardown handshake with the framework behind an
  `AssessmentLockdown.Session` protocol, covered by tests including the two
  failure modes above — and AAC-1 wired it to hand-in and quit in the app.
  What is still missing is only the adapter: a `Session` implementation
  wrapping a real `AEAssessmentSession`.
- **Sandbox + AAC interaction.** `ENABLE_APP_SANDBOX = YES` here. Apple's own
  sample shows a sandboxed AAC app additionally declaring
  `com.apple.security.temporary-exception.mach-lookup.global-name =
  com.apple.assessmentagent` — but PoC-A is also sandboxed, carries no such
  exception, and its session began anyway on macOS 26.6.2. Try without it; add
  it only if `begin()` fails (RESULTS finding #9).
- **Sandbox + network.** A sandboxed app has no outbound network unless it
  declares `com.apple.security.network.client`; without it every
  `URLSession` call fails as DNS `NSURLErrorDomain -1003` ("A server with the
  specified hostname could not be found"), which looks like a network fault
  and is not one. Found on the first live sign-in (2026-08-27): Google's
  sheet worked — `ASWebAuthenticationSession` is out-of-process — and the
  token exchange right after it did not. `ENABLE_OUTGOING_NETWORK_CONNECTIONS
  = YES` in both configurations adds the entitlement at signing; check with
  `codesign -d --entitlements - SecureTest.app`. Incoming stays off.
- **Sign-in.** Google OIDC + PKCE in our own `WKWebView` on a
  non-persistent data store, fresh per attempt (slice 80, presenter swapped
  in UX pass 2 slice 9 — the `ASWebAuthenticationSession` sheet kept a
  Google session in the AuthenticationServices daemon's store that survived
  `prompt=login`, so credentials were not actually demanded every time).
  `GoogleSignInFlow` in the package builds the
  authorization URL, checks state and nonce, exchanges the code at Google
  (public client, no secret) and trades the id_token at `/api/auth/exchange`
  for a session JWT held in memory only (2026-08-31 — was the Keychain;
  the in-memory store makes a fresh sign-in unavoidable every launch, and
  a legacy Keychain row from older builds is purged at startup). Since the
  swap, ALL sign-in
  web traffic runs in-process, so the network entitlement below is
  load-bearing for the whole flow, not just the token exchange. The sheet
  itself (`WebViewAuthPresenter`) is the only part that cannot be tested
  here; its rows are in `MANUAL-CHECKS.md`. Configure with
  `SECURE_TEST_GOOGLE_CLIENT_ID=<native client id>` (or `--google-client-id`);
  without it the button is hidden and the token comes from `--token <jwt>` /
  `SECURE_TEST_TOKEN`, as before. The native client id must be an
  iOS/macOS-type OAuth client in Google Cloud (reverse-client-id redirect),
  and the design tool must list it in `OIDC_AUDIENCE`. Still to be learned
  from the first real sign-in: whether Workspace trusts the client for
  `edtools.psd401.net` student accounts.

Smaller, and nobody is blocked on them:

- Hardware function keys mapped to system actions (Mission Control, Spotlight,
  Dictation) are governed by the OS rather than this app. That is an AAC
  question, not a WebKit one, and belongs in the layered-lockdown checklist. The
  entitlement is no longer what holds this up; PoC-A's characterization run is
  (`docs/unblock-checklist.md` step 5, not yet reached).
- The response spool is never cleared on submit, so a student who finishes
  offline leaves answers in the app container. The sandbox makes that
  per-macOS-user, which is only thin in a shared-login lab.

## Verifying the lockdown

`swift test` covers everything in `SecureTestCore`. The AppKit and WebKit
surface — drag destinations, Touch Bar, auxiliary web views, file pickers, the
menu bar — needs a window server and a human doing the gesture, and there is no
automated substitute available here (ADR 0013). `MANUAL-CHECKS.md` is that list.
