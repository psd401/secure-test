# PoC-A Results

**Status as of 2026-08-27 (afternoon)**: PoC-A is **done**. The original
question is answered (finding #13): ScreenCaptureKit runs inside an active
`AEAssessmentSession` but returns the app's own window as a flat grey
rectangle, `allowsScreenshots` either way. The follow-up is answered too
(finding #14): an **in-process render** (`NSView.cacheDisplay`) inside the
session returns full content — live monitoring has an image mechanism, just not
a screen-capture one. Checklist steps 5 and 6 are measured (finding #15).
Entitlement granted, session begins and ends (findings #8, #12).

## What the PoC originally set out to answer

Can a macOS app call ScreenCaptureKit while inside an active `AEAssessmentSession`? This question is load-bearing for the Phase 3 thumbnail-grid monitoring plan.

## What we actually learned (before reaching the original question)

### 1. AAC on macOS requires a restricted entitlement

`com.apple.developer.automatic-assessment-configuration` is *listed* in Apple's public entitlement docs but is **not freely addable** via Xcode's Signing & Capabilities tab. It is a restricted entitlement that Apple must explicitly authorize for a team's account before it appears in the capability picker.

- The earlier research-agent claim that "AAC is not a special entitlement requiring Apple approval" was wrong.
- Apple's docs page is JS-rendered and doesn't make this gate explicit; the empirical evidence is that the capability does not appear in PSD's team's "+ Capability" picker.

### 2. Without the entitlement, AEAssessmentSession.begin() fails at runtime

Reproducible signature:

```
[timestamp] AEAssessmentSession.begin() called.
[timestamp] Delegate: session FAILED TO BEGIN —
  The operation couldn't be completed. (AEAssessmentErrorDomain error 1.)
```

`codesign -d --entitlements -` on the built binary confirmed there were no entitlements in the signed app. Error 1 in this domain corresponds to the entitlement not being granted in the running profile.

### 3. ScreenCaptureKit works in baseline (no AAC active)

`SCScreenshotManager.captureImage` writes JPEGs to `~/Library/Application Support/PocA/poc-frames/` once the user grants Screen Recording in System Settings. Confirmed in this PoC. So at minimum, the macOS capture API works for an unsandboxed signed dev app — what we can't yet test is its behavior inside an AAC session. **Note added 2026-08-26**: "unsandboxed" is accurate for *this* measurement and only this one. It was taken at 18:40 on 2026-05-19, about an hour before the `.xcodeproj` restructure turned the sandbox on. Everything measured since is sandboxed — see finding #9, which makes this baseline non-comparable to the capture-under-AAC run without redoing it.

### 4. Swift's `Mirror` doesn't introspect AAC config objects

The PoC originally instrumented `AssessmentSessionController.beginSession()` to walk `Mirror(reflecting: config)` over `AEAssessmentConfiguration` and its `mainParticipantConfiguration`, expecting to enumerate the actual settable properties on macOS. The walk yielded no labeled children.

Reason: `AEAssessmentConfiguration` and `AEAssessmentParticipantConfiguration` are Obj-C bridged classes; Swift's `Mirror` does not enumerate Obj-C properties. We resolved this by reading the SDK headers directly — see finding #5.

### 5. Authoritative macOS API surface from the SDK headers

Read `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/System/Library/Frameworks/AutomaticAssessmentConfiguration.framework/Headers/` on 2026-05-19. Findings below are the source of truth (the property names and version availability are extracted directly from Apple's headers).

**Earlier scaffolding had two misconceptions** that the headers correct:
- We thought settable flags lived on `AEAssessmentParticipantConfiguration`. They do **not**. The settable flags live on `AEAssessmentConfiguration` itself.
- We thought flags like `allowsAutoCorrect` and `allowsScreenRecording` existed. They don't. The real names are `autocorrectMode` (bitmask) and there's no public flag governing `ScreenCaptureKit` behavior at all — see finding #2 below.

**`AEAssessmentConfiguration` properties settable on macOS** (Apple's own annotations):

| Property                          | Type                    | macOS floor |
|---                                |---                      |---          |
| `allowsSpellCheck`                | `BOOL`                  | 15.0        |
| `autocorrectMode`                 | `AEAutocorrectMode` ({.spelling, .punctuation}) | 15.0        |
| `allowsKeyboardShortcuts`         | `BOOL`                  | 15.0        |
| `allowsPredictiveKeyboard`        | `BOOL`                  | 15.0        |
| `allowsAccessibilityKeyboard`     | `BOOL`                  | 26.1        |
| `allowsAccessibilityLiveCaptions` | `BOOL`                  | 26.1        |
| `allowsAccessibilityReader`       | `BOOL`                  | 26.1        |
| `allowsScreenshots`               | `BOOL` (clipboard only) | 26.1        |
| `mainParticipantConfiguration`    | `AEAssessmentParticipantConfiguration *` (read-only) | 12.0        |
| `configurationsByApplication`     | `NSDictionary <AEAssessmentApplication *, AEAssessmentParticipantConfiguration *> *` (read-only) | 12.0        |

**`AEAssessmentConfiguration` properties marked `API_UNAVAILABLE(macos)`** — iOS only:
`allowsDictation`, `allowsActivityContinuation`, `allowsAccessibilitySpeech`, `allowsAccessibilityTypingFeedback`, `allowsPasswordAutoFill`, `allowsContinuousPathKeyboard`, `allowsEmojiKeyboard`. Mostly keyboard / typing-feedback features that don't have macOS equivalents.

**`AEAssessmentParticipantConfiguration`** (macOS 12.0+) has only three properties:
- `allowsNetworkAccess: BOOL` (12.0)
- `required: BOOL` (26.0)
- `configurationInfo: NSDictionary<NSString *, id> *` (15.0)

**Accommodations mechanism on macOS**: `AEAssessmentConfiguration.setConfiguration(_:for:)` — register an `AEAssessmentApplication(bundleIdentifier:teamIdentifier:)` and pair it with a per-app `AEAssessmentParticipantConfiguration`. Apple's own example in the headers uses Calculator. For PSD, this is the mechanism for permitting assistive-tech apps (Read&Write, Co:Writer, etc.) to be reachable during an assessment. The `AEAssessmentApplication` initializer also supports `requiresSignatureValidation`, which guards against a user renaming an arbitrary binary to match an allowed bundle ID — defaults to off; we should turn it on.

**`AEAssessmentSession`** methods: `begin()`, `end()`, `update(to:)` (macOS 12.0+ — configuration can change mid-session). Class properties `supportsMultipleParticipants` and `supportsConfigurationUpdates` report capability at runtime (added macOS 14.5).

**The error code we hit, definitively named.** From `AEErrors.h`:

```objc
typedef NS_ERROR_ENUM(AEAssessmentErrorDomain, AEAssessmentErrorCode) {
    AEAssessmentErrorUnknown = 1,
    AEAssessmentErrorUnsupportedPlatform = 2,         // 16.0+ / 13.0+
    AEAssessmentErrorMultipleParticipantsNotSupported = 3,
    AEAssessmentErrorConfigurationUpdatesNotSupported = 4,
    AEAssessmentErrorRequiredParticipantsNotAvailable = 5,  // 26.0+
};
```

Error 1 is `AEAssessmentErrorUnknown` — Apple's catch-all. Consistent with our missing-entitlement diagnosis.

### 6. ScreenCaptureKit-vs-AAC is still empirically unanswered

The headers reveal **no public property governing `SCStream` / `SCShareableContent` behavior during an active session**. `allowsScreenshots` only governs the Cmd-Shift-3/4 clipboard path on macOS 26.1+ (and clipboard is cleared at session end). The thumbnail-grid feasibility question remains: when AAC is active, does the OS deny `ScreenCaptureKit` calls regardless of caller, or do they pass through?

The absence of a public flag is itself a signal — Apple did not provide an opt-in for monitoring screen capture during assessments. The likely answer is "no, the OS denies it." Still unconfirmed as of 2026-08-26: the entitlement cleared, but the run that could have measured this ended in a forced shutdown before `Capture Frame` was clicked (finding #10).

### 7. Xcode `@main` on an AppKit AppDelegate does not auto-wire the delegate

A separate dev-experience finding: when we removed `Main.storyboard` to use a programmatic window, the app launched but `applicationDidFinishLaunching` never fired and no window appeared. `@main` on `NSApplicationDelegate` synthesizes a `main()` that calls `NSApplicationMain` but does not assign the class as the app's delegate — that wiring is normally done by the storyboard. Fix is to add an explicit `static func main()` that creates the delegate and assigns it before calling `app.run()`. Codified in `PocA/PocA/AppDelegate.swift`.

### 8. The entitlement is granted, and the session begins

Notification arrived **2026-08-26**. Apple indicated the authorization had been
in place for some time and the notification was missed on their side, so the
grant date itself is unknown — 2026-08-26 is when we learned, not necessarily
when it happened. Treat the 99-day "wait" in this document's earlier entries as
partly an artifact of that missed notification.

Confirmed two ways:

- **Automatic Assessment Configuration** now appears in Xcode's + Capability
  picker for team `<TEAM_ID>`. Adding it created `PocA/PocA/PocA.entitlements`
  and set `CODE_SIGN_ENTITLEMENTS` on both build configurations.
- The entitlement survives into the signed binary. `codesign -d --entitlements -`
  on `PocA.app` (Debug, 2026-08-26):

  ```
  com.apple.developer.automatic-assessment-configuration  true
  com.apple.developer.team-identifier                     <TEAM_ID>
  com.apple.application-identifier                        <TEAM_ID>.net.psd401.securetest.PocA
  com.apple.security.app-sandbox                          true
  com.apple.security.files.user-selected.read-only        true
  com.apple.security.get-task-allow                       true
  ```
  Signed by `Apple Development: JAMES CANTONWINE (943V46Q68H)`.

On the first run, the log reached `Delegate: session DID BEGIN.` — so with the
entitlement in place, `AEAssessmentSession.begin()` **succeeds**, and finding #2's
`AEAssessmentErrorDomain` error 1 is confirmed to have been the missing
entitlement and nothing else.

Environment for that run: macOS **26.6.2** (25G83), Xcode **26.6** (17F113),
deployment target 26.5. Everything measured from here carries those versions.

### 9. PoC-A is sandboxed today, and has been since the restructure — several docs still said otherwise

`ENABLE_APP_SANDBOX = YES` has been set on the PocA target since the project was
restructured as an `.xcodeproj` (commit `2875ed7`, 2026-05-19 19:48 -0700), and
the signed entitlements in finding #8 confirm it.

The timeline matters, because the two measurements straddle it:

| | When | Sandboxed? | Evidence |
|---|---|---|---|
| Finding #3 capture baseline | 2026-05-19 18:40 | **No** | `frame-1779241223.jpg` sits at `~/Library/Application Support/PocA/poc-frames/`. `framesDirectory()` asks for `.applicationSupportDirectory`, which a sandboxed process resolves inside its container — so the frame landing outside one proves that build was unsandboxed. It also predates `2875ed7` by 68 minutes. |
| Finding #8 AAC session | 2026-08-26 | **Yes** | `com.apple.security.app-sandbox = true` in the signed entitlements; the container `~/Library/Containers/net.psd401.securetest.PocA` exists and holds no frames. |

So finding #3 is correct as written for what it measured. What was stale is every
doc that described PoC-A in the **present tense** as unsandboxed:
`poc-a-aac-capture/README.md`'s "What this PoC is NOT", `docs/unblock-checklist.md`,
`docs/plan.md`, and `docs/references/README.md`. All corrected 2026-08-26.

**Two consequences.**

*For `client/`*: the signed entitlements contain **no**
`com.apple.security.temporary-exception.mach-lookup.global-name =
com.apple.assessmentagent`, and the session began anyway. Apple's AAC sample
implies a sandboxed app needs that exception; on macOS 26.6.2 it evidently did
not. That is **one observation on one OS version with a development-signed,
`get-task-allow` build** — not a rule. The right posture is to try without the
exception and add it only if `begin()` fails, rather than adding it preemptively
as the checklist previously instructed.

*For the capture measurement itself*: the baseline and the AAC run would not be
like-for-like. A black or failed frame inside a session could be the sandbox
rather than AAC. **Re-establish the baseline with the current sandboxed build
before entering a session**, so the comparison isolates one variable — that is
step 1 of the test procedure in `README.md` and it is no longer optional.

### 10. There is no way out of an active session — the first run ended in a forced shutdown

The load-bearing question was not reached. Once the session began, the machine
could not be recovered from inside the app and the run ended by holding the power
button. `Capture Frame` was never clicked; `~/Library/Application Support/PocA/
poc-frames/` still holds only `frame-1779241223.jpg`, the 2026-05-19 baseline.

Four independent defects in `AppDelegate.swift`, each sufficient on its own:

1. `toggleSession()` **does** end the session, but the button's title is
   hard-coded `"Enter Assessment"` and never changes. Nothing on screen says an
   exit exists.
2. No main menu is installed at all, so `Cmd-Q` dispatches to nothing — the same
   "no menu item, no shortcut" behavior PoC-B measured for `Cmd-V`. This is true
   even outside a session.
3. `applicationShouldTerminateAfterLastWindowClosed` is not implemented, so it
   defaults to `false`. Closing the window leaves the process alive with the
   session active and no UI at all. That is the total-lockout shape.
4. No timeout, and no `session.end()` on any path except that one button. There
   is no dead-man's switch.

AAC suppresses app switching, so none of the usual escapes apply once this state
is reached.

**Fixed 2026-08-26**, all four, plus two mechanisms that did not exist before:

| Exit | Mechanism | Proven? |
|---|---|---|
| The button | Title derived from controller state on every delegate callback — `Enter Assessment` / `End Assessment` / a live countdown | Simulation, then **verified in a real session 2026-08-26** (finding #12) |
| `Cmd-E` / menu | Main menu exists; `End Assessment` enabled only while a session is up (`autoenablesItems = false`) | **`Cmd-E` verified in a real session 2026-08-26** (finding #12). Whether the menu bar is *visible* in-session is still checklist step 5 |
| `Cmd-Q`, window close, SIGTERM | `applicationShouldTerminate` cancels the quit, ends the session, and re-issues the quit on confirmation. `applicationShouldTerminateAfterLastWindowClosed` → `true` | Simulation: exits ~2s after SIGTERM. **`Cmd-Q` verified in a real session 2026-08-26** (finding #12); window close and in-session SIGTERM still unexercised |
| Same, when `end()` never answers | Off-main backstop hard-exits after 5s | **Verified in simulation** — bounded 5s exit with `end()` rigged to hang |
| In-app watchdog | Ends the session after `--session-timeout` (floor 10s, not disableable) | Simulation: fired at exactly 10s; 8s clamped to 10. **Verified in a real session 2026-08-26** — the countdown ticked and ended the session (finding #12) |
| Watchdog escalation | Quits the process if `end()` doesn't confirm in 5s | **Verified in simulation** — watchdog 10s → escalation 15s → exit 20s |
| `killall PocA` over ssh | SIGTERM trapped and routed to `NSApp.terminate` | **Verified 2026-08-26**, no session active. **Unavailable on the PSD Mac** — see below |
| `run-with-deadline.sh` | Background shell SIGTERMs at a deadline, SIGKILLs 5s later. Needs only the process table | **Verified** — deadline fired, app hard-exited, no stray process |

`--simulate-lockdown` is what made those rows testable. It drives the entire
state machine with no `AEAssessmentSession` behind it, so the watchdog,
escalation and teardown handshake can be exercised on any Mac.
`--simulate-stuck-end` additionally rigs `end()` never to confirm, which is the
only deliberate way to reach the escalation paths. Neither locks anything.

**The one row no simulation could fill — whether `AEAssessmentSession.end()`
actually gives the Mac back — was filled the same evening (finding #12): it
does.** A green simulated run was never evidence about AAC; the real-session
runs are. Still unexercised against a live session: window close, trapped
SIGTERM, both escalation paths (no `end()` hang has been observed), and
`run-with-deadline.sh`'s deadline firing while a session is up.

### 11. `.terminateLater` starves the main queue — the safety net deadlocked the app

Found by simulation on 2026-08-26, before it could be found by a locked Mac.

The first attempt at a confirmed teardown had `applicationShouldTerminate`
return `.terminateLater`, then waited for `assessmentSessionDidEnd` to call
`NSApp.reply(toApplicationShouldTerminate:)`, with a `DispatchQueue.main` timer
as a fallback.

Both were starved. After `.terminateLater`, AppKit waits in a nested run loop
that does not drain `DispatchQueue.main`, so the confirmation callback never
arrived **and** the fallback timer that existed to catch exactly that never
fired. Observed directly: `SIMULATION: end() called.` at `00:59:50`, then
nothing, forever. The app hung with the session still live — the precise state
the exit path exists to prevent, produced by the code written to prevent it.

Two corrections, both load-bearing:

- **`.terminateCancel`, not `.terminateLater`.** Cancel the quit, end the
  session, and re-issue `NSApp.terminate` from the confirmation. Control returns
  to the normal run loop, main keeps draining, and the second terminate finds no
  active session and proceeds.
- **The backstop moved off the main queue** onto its own serial queue, and
  hard-exits rather than trying to route back through AppKit. A watchdog that
  shares a thread with the thing it is watching is not a watchdog — the same
  class of error as the original bug, trusting one mechanism in one place to
  rescue itself.

Generalizes past this PoC: any AppKit app doing async teardown in
`applicationShouldTerminate` has this hazard, and the client will do exactly
that at hand-in.

**The verified exit is the one we cannot use here.** Remote Login is off on this
Mac and enabling it needs admin, which the account does not have (confirmed
2026-08-26: nothing listening on port 22). So `ssh … killall` — the single path
with evidence behind it — is unavailable, and the in-app exits would be running
unbacked. `run-with-deadline.sh` is the substitute: it needs no admin, no
network, and no GUI, only a shell that was started before the session. Use it
for the first session run rather than launching from Xcode.

**The personal-Mac plan is dead, deliberately.** Running PoC-A on a personal
machine would need the device registered to the PSD team, and James declined —
correctly; it burns an org device slot and mixes personal hardware into district
provisioning for one test. Without registration there is no profile, without a
profile no entitlement, and `begin()` fails with error 1 without locking
anything. So the real AAC run can only happen on district hardware, and
simulation exists to make sure that run is the *only* unknown left.

Two script bugs also surfaced while testing, both of which would have wasted a
session run: `find` was matching Xcode's `Index.noindex` stub products (same
name and layout, no binary inside — the script exited in a second looking like a
clean run), and the deadline could not be shortened to test itself. Both fixed;
`POCA_DEADLINE` overrides it, and extra arguments pass through to the app.

### 12. Four exits verified inside a real session — and capture failed at TCC, not at AAC

Run on the PSD Mac on the evening of 2026-08-26 (log stamps are UTC, so they
read `2026-08-27T02:xxZ`), launched through `run-with-deadline.sh`, following
`FIRST-SESSION-RUNBOOK.md`. Terminal log from the capture run:

```
[2026-08-27T02:09:04Z] Delegate: session DID BEGIN.
[2026-08-27T02:09:08Z] Capture: FAILED — The user declined TCCs for application, window, display capture
[2026-08-27T02:09:11Z] AEAssessmentSession.end() called.
[2026-08-27T02:09:14Z] Delegate: session DID END.
```

**Exits — all four worked, each on its own session, all inside a real
`AEAssessmentSession`:** the watchdog countdown fired and ended the session;
the **End Assessment** button; **Cmd-E**; **Cmd-Q**. Every one returned the
desktop without a reboot. `end()` → `DID END` took ~3s in the run above. So the
question the runbook was written around — does `end()` give the Mac back — is
answered on macOS 26.6.2 with the default restrictive configuration: it does.

Two side observations, both narrow:

- `Cmd-E` and `Cmd-Q` dispatched inside a session with
  `allowsKeyboardShortcuts` at its default (`false` on macOS 15+). Whatever that
  flag suppresses, it is not the app's own menu key equivalents. Do not rely on
  it to keep a student from quitting; the client has to own that itself.
- The window kept drawing throughout — the countdown ticked and the button was
  clickable — which is more than finding #8's single rendered line. Not
  measured: whether the menu bar and Dock are *visible*, `Cmd-Tab`, screenshot
  keys. Still checklist step 5.

**Capture — attempted inside the session, failed before reaching AAC.**
`SCShareableContent` threw `The user declined TCCs for application, window,
display capture`. That is the Screen Recording permission, evaluated before any
capture happens, and it fails identically outside a session. Nothing was
measured about AAC.

Why it was denied: System Settings → Privacy & Security → Screen Recording
shows **two rows for what looks like one app**: `PocA` (bare-executable icon,
**on**) and `PocA.app` (**off**). The on row is the May 19 *unsandboxed* build's
grant (finding #3, taken before the `.xcodeproj` restructure — finding #9). The
off row is this sandboxed, entitled bundle, a different code identity to TCC.
No frame was written anywhere: the container has no `poc-frames` directory and
`~/Library/Application Support/PocA/poc-frames/` still holds only the May frame.
Flipping the toggle needs admin on this Mac — the same constraint that took
Remote Login off the table. This is `docs/plan.md` risk #5 (TCC grant UX)
arriving early, on the developer instead of a student.

**Still open, and why.** The load-bearing question is now blocked on an IT
action rather than on Apple or on our code: grant Screen Recording to bundle id
`net.psd401.securetest.PocA` — a Jamf PPPC profile, or an admin flipping the
`PocA.app` row. It is the same conversation as Remote Login and the shipping
client's PPPC profile, and should be one ask. When it lands, resume the runbook
at "Then the measurements", **baseline first, outside a session** — the reason
for that ordering has not changed.

### 13. Capture inside a session returns the app's window as a flat grey box — with `allowsScreenshots` either way

Run on the PSD Mac on the morning of 2026-08-27 (log stamps UTC, `16:4x`–`17:0x`),
macOS 26.6.2, the 2026-08-26 19:07 build for the first three runs and a rebuild
with `--allow-screenshots` for the fourth. Launched through
`run-with-deadline.sh 120` from iTerm2, following `FIRST-SESSION-RUNBOOK.md`
("Then the measurements"). The four frames are in `frames/`.

| Run | When the frame was taken | What the JPEG shows |
|---|---|---|
| Baseline | no session | Live desktop: terminal, System Settings, PocA window text — frame not in the public tree (it was a full desktop screenshot; removed 2026-09-04, the in-session frames below are the evidence) |
| 1 | 3 s after `begin()`, **1 s before** `Delegate: DID BEGIN` | Live: PocA window text readable, watchdog ticking; menu bar and Dock already gone — `…run1-before-did-begin.jpg` (152 KB) |
| 2 | **4 s after** `DID BEGIN`, `allowsScreenshots=false` (default) | PocA window is a **solid grey rectangle** — no title bar, text or buttons; lockdown backdrop and cursor visible — `…run2-in-session.jpg` (64 KB) |
| 3 | **3 s after** `DID BEGIN`, `allowsScreenshots=true` (`--allow-screenshots`) | Identical grey rectangle — `…run3-in-session-allow-screenshots.jpg` (65 KB) |
| Photo | fifth session, 17:23Z, phone camera | On-screen window fully rendered — title bar, buttons, log — `…phone-photo-in-session.jpg` |

Terminal log from run 3, the decisive one:

```
[2026-08-27T17:02:07Z] Config (macOS 26.1+): allowsAccessibilityKeyboard=false allowsAccessibilityLiveCaptions=false allowsAccessibilityReader=false allowsScreenshots=true
[2026-08-27T17:02:07Z] AEAssessmentSession.begin() called. Watchdog will end it in 120s if nothing else does.
[2026-08-27T17:02:11Z] Delegate: session DID BEGIN.
[2026-08-27T17:02:14Z] Capture: targeting display 1 1470x956
[2026-08-27T17:02:14Z] Capture: wrote .../poc-frames/frame-1787850134.jpg (64687 bytes)
[2026-08-27T17:02:14Z] Capture: SUCCESS — frame written.
[2026-08-27T17:02:17Z] AEAssessmentSession.end() called.
[2026-08-27T17:02:19Z] Delegate: session DID END.
```

**What this says.** `SCShareableContent` and `SCScreenshotManager.captureImage`
do not error inside a session — no exception, a full-size frame every time. What
changes is the *content*: once the delegate has reported `DID BEGIN`, the
assessment app's own window is rendered into the capture as an opaque grey
rectangle, with everything else (backdrop, cursor) intact. Run 1 brackets the
moment: a frame taken after `begin()` but before `DID BEGIN` still showed the
window's text, even though the menu bar and Dock were already suppressed. So the
redaction is applied by the session, at or just before the `DID BEGIN` callback,
and it is not the `allowsScreenshots` switch — run 3 set that to true and got
the same box. Nothing in the public `AEAssessmentConfiguration` surface (finding
#5) is left to try.

For the plan this is the README's **fail** case — "frames stripped of the
assessment window's content" — and `docs/plan.md` risk #1's second branch: the
Phase 3 thumbnail grid is dead as designed. What survives is what the redacted
frame still carries (nothing useful — the student's work is inside the box) and
whatever the client can report about itself from inside: item position, timing,
focus/blur events, and the on-demand WebRTC peek, which streams from inside the
app's own process rather than through ScreenCaptureKit and is a separate
measurement (open question 6.16).

**It is a substitution, not a rendering of a grey screen.** Two checks. A
phone photo of the display during a fifth session at 17:23Z
(`frames/2026-08-27-phone-photo-in-session.jpg`, `DID BEGIN` 17:22:44, watchdog
at 99 s) shows the window fully drawn on the lockdown backdrop — title bar,
both buttons, the whole log — so the student sees the app normally. And the
window region of the run 2 and run 3 frames is **99.9 % one exact value,
`#808080`** (the remainder is the cursor; 105–106 distinct colors in a 670×470
crop), where run 1's same region has 256 distinct colors and is 74 % white.
A real grey view would JPEG-compress to a spread of near-greys, and it would
keep its title bar and shadow; this box has neither. AAC hands
ScreenCaptureKit a flat placeholder in place of the assessment app's window.

**Side finding — TCC follows the launching terminal.** The baseline's first
click failed with the same `The user declined TCCs` as finding #12, *outside*
any session and after IT had toggled Screen Recording on for `PocA.app`. It
succeeded two minutes later once Screen Recording was also toggled on for
**iTerm2**. macOS attributes a process launched from a terminal to the terminal
as its *responsible* app, so a PocA started by `run-with-deadline.sh` is checked
against iTerm2's grant, not PocA's. Two consequences: (a) finding #12's
diagnosis — the `PocA`/`PocA.app` row split — was at most half the story; the
2026-08-26 run was launched the same way and would have failed on the
terminal's grant regardless; (b) this does not touch the shipping client, which
students launch from Finder/Jamf and which is attributed to itself. Any future
capture run launched from a shell needs that shell's terminal granted too.

Both sessions ended cleanly via the button (`end()` → `DID END` in ~2–3 s); the
app then ran to the script's 150 s SIGTERM and exited without a stray process.

### 14. An in-process render survives the session — AAC redacts ScreenCaptureKit, not the app

Same Mac, same day, 17:40Z, default configuration, launched through
`run-with-deadline.sh 300`. A third button, **Snapshot Window**, renders the
app's own content view with `NSView.bitmapImageRepForCachingDisplay` +
`cacheDisplay(in:to:)` and writes the JPEG next to the ScreenCaptureKit
frames. No ScreenCaptureKit, no window server capture, no TCC — it is the
app drawing itself into a bitmap.

```
[2026-08-27T17:40:02Z] Snapshot: wrote .../poc-frames/snapshot-1787852402.jpg (103491 bytes, 1440x960)
[2026-08-27T17:40:46Z] AEAssessmentSession.begin() called. Watchdog will end it in 300s if nothing else does.
[2026-08-27T17:40:50Z] Delegate: session DID BEGIN.
[2026-08-27T17:40:52Z] Snapshot: wrote .../poc-frames/snapshot-1787852452.jpg (344173 bytes, 1440x960)
[2026-08-27T17:40:52Z] Snapshot: SUCCESS — in-process render written.
```

`frames/2026-08-27-run4-snapshot-in-session.jpg`, taken 2 s after `DID BEGIN`,
is the whole window content — all three buttons, the countdown at 295 s, every
log line including `DID BEGIN` itself. Compare finding #13's grey box from the
same state. So the redaction is applied where the window server hands frames
to capture clients; the app's own drawing pipeline is untouched.

**What this changes.** Plan open question 6.16 asked whether the "drop
thumbnails, fall back to WebRTC peek" fallback survives, since peek captures the
screen too. It does not — a WebRTC peek *fed by ScreenCaptureKit* would ship
the same grey box. But a peek or a thumbnail fed by the client rendering its
own `WKWebView`/view tree on a timer would ship the test. That is the
mechanism: the client renders itself (`WKWebView.takeSnapshot` is the
web-content equivalent of what PoC-A did here) and pushes the image over the
student plane; nothing screen-capture-based anywhere. It costs the student's
CPU, not a permission — no Screen Recording TCC, no PPPC profile for the
monitoring path. Not measured: `WKWebView.takeSnapshot` specifically (PoC-A
has no web view), and the cost at a realistic cadence; both are client work.

### 15. Checklist steps 5 and 6 — system UI inside a session, and the secondary-app mechanism

**Step 5, default configuration (run 4, hand-checked while the session was
up):**

| Tried | Result |
|---|---|
| `Cmd-Shift-3`, `Cmd-Shift-4`, `Cmd-Shift-5` | Suppressed; the system alert beep |
| `Cmd-Tab` | Suppressed; beep |
| Spotlight (`Cmd-Space`) | Suppressed; beep |
| Dock (mouse to bottom edge) | Suppressed; beep |
| Menu bar (mouse to top edge) | Nothing — no menu bar, no beep |
| Mission Control | Nothing — no beep |

Not tried: QuickTime "New Screen Recording" (there is no way to launch it —
see step 6 for why that is the same finding).

**Step 6, `--allow-calculator` (run 5, 17:44Z).** Calculator is registered via
`setConfiguration(_:for:)` with `requiresSignatureValidation = true` and
`allowsNetworkAccess = false`. Because the Dock and Spotlight are suppressed,
the only way to open a secondary app is for the assessment app to do it — which
is how the shipping client would open an assistive-tech app anyway — so PocA
calls `NSWorkspace.openApplication` itself, Calculator 3 s after `DID BEGIN`
and Safari (not in the configuration) 5 s later as the negative control:

```
[2026-08-27T17:44:09Z] Secondary apps allowed: 1
[2026-08-27T17:44:12Z] Delegate: session DID BEGIN.
[2026-08-27T17:44:15Z] Secondary: Calculator (allowed) launched — pid 73616. Is it visible? (hand-check)
[2026-08-27T17:44:21Z] Secondary: Safari (NOT allowed) launched — pid 73625. Is it visible? (hand-check)
[2026-08-27T17:44:50Z] AEAssessmentSession.end() called.
[2026-08-27T17:44:53Z] Delegate: session DID END.
```

- **Calculator**: appeared in front, took input, could be moved. The
  accommodations mechanism works as documented.
- **Safari**: `openApplication` **succeeded** — a pid came back and the process
  was alive (`ps` confirmed both pids after the session) — but **no window was
  visible** until the session ended, at which point Safari appeared. Calculator
  stayed where it had been moved; both apps persisted after End Assessment.

So AAC gates **visibility, not launch**. A disallowed app launched during a
session is not refused; it is held off-screen and surfaces the moment the
session ends. Two consequences for the client: never launch anything not in the
configuration (it will be waiting on the desktop afterward), and treat "the
session ended" as a moment when previously hidden windows can appear over the
client's own — end-of-session UI should not assume it is frontmost.

## What blocks the original question

Nothing. Measured 2026-08-27: capture runs but is redacted (#13), an
in-process render is not (#14), and the session's other behaviors and the
secondary-app mechanism are characterized (#15). PoC-A has no open items.

## What we said we'd do once the entitlement was granted — and where each item stands

1. ~~Add Automatic Assessment Configuration to PoC-A's Signing & Capabilities. Xcode should auto-create `PocA.entitlements`.~~ **Done 2026-08-26** (finding #8).
2. Update `AssessmentSessionController.swift` to set the actually-settable properties from finding #5 (replacing the stale `Mirror` introspection):
   - Default restrictive: leave everything at defaults.
   - Accommodations example: `config.allowsSpellCheck = true`, `config.autocorrectMode = [.spelling]`, `config.allowsKeyboardShortcuts = true`, etc.
   - Demonstrate the accommodations bundle-ID mechanism by registering Calculator (`com.apple.calculator`) via `setConfiguration(_:for:)`.
3. ~~Rebuild and re-run.~~ **Done 2026-08-26.** Build succeeds; entitlement verified in the signed binary.
4. ~~Verify `AEAssessmentSession.begin()` succeeds~~ **Done — it does** (finding #8), and as of the 2026-08-26 evening runs the app's UI keeps working inside the session: the countdown renders, the button and menu respond, and every exit returns the desktop (finding #12).
5. ~~Capture Frame inside a session.~~ **MEASURED 2026-08-27** (finding #13; the in-process alternative that does work is finding #14). Sandboxed baseline taken first (live desktop); in-session capture writes a frame but the assessment window is a flat grey box, with `allowsScreenshots` false and true. Second branch of the two below applies: the thumbnail grid is dead; live view falls back to WebRTC peek + metadata per the plan's risk #1.
   - ~~If a JPEG is written with live screen content, then ScreenCaptureKit works inside AAC on macOS and the Phase 3 thumbnail-grid plan stands.~~
   - If capture errors or returns black/zeroed frames, the thumbnail grid is dead and we fall back to WebRTC peek + metadata-only live view per the plan's risk #1. **← this one.**
6. ~~Test system-wide screenshot shortcuts (`Cmd-Shift-3`, `Cmd-Shift-4`, screen recording HUD) during a session.~~ **Done 2026-08-27** (finding #15): all suppressed with a beep.

Item 2 (setting the finding-#5 properties) is partly done — `allowsScreenshots`
(finding #13) and a secondary app (finding #15) were exercised via flags; the
rest of the matrix (spell-check, autocorrect, keyboard shortcuts, the
accessibility trio) is client work, not PoC work. Steps 5 and 6 of
`docs/unblock-checklist.md` are done (finding #15).

## Bottom line

The entitlement gate is **closed out**: authorization exists, it reaches the
signed binary, and `AEAssessmentSession.begin()` succeeds on macOS 26.6.2. That
was the external dependency and it is gone.

The exit path is **closed out too**: watchdog, button, `Cmd-E` and `Cmd-Q`
each ended a real session on 2026-08-26 and the Mac came back every time
(finding #12). Finding #10's defect is fixed and proven in the environment it
exists for.

The load-bearing question — ScreenCaptureKit inside an active session — is
**answered** (finding #13, 2026-08-27): the capture API works, the assessment
window comes back as a grey box, and `allowsScreenshots` does not change that.
The Phase 3 thumbnail grid as designed does not survive — but finding #14
shows the replacement: the client renders its own view tree and pushes the
image, and that survives the session untouched. Live monitoring is in-process
renders plus what the client reports about itself; nothing screen-capture-based.
Steps 5 and 6 are measured (finding #15). PoC-A has done what it was built for.
