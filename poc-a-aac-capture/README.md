# PoC-A — AAC + ScreenCaptureKit

## Status

**Entitlement granted** (notified 2026-08-26). `AEAssessmentSession.begin()`
succeeds on macOS 26.6.2 and the session enters lockdown.

**Exits, added 2026-08-26** after the first run had to be ended by holding the
power button (RESULTS finding #10). Any of these ends a session:

- the button, which now says `End Assessment` and counts down;
- `Cmd-E`, or **End Assessment** in the app menu;
- `Cmd-Q`, or closing the window;
- `ssh <thismac> killall PocA` from a phone or second machine — **not available
  on this Mac**: Remote Login is off and turning it on needs admin we don't have;
- nothing at all — the watchdog ends it after 120s. `--session-timeout <sec>`
  lengthens that for a longer characterization run; it cannot switch it off.

Because the ssh escape is unavailable, launch the first session run through the
external kill-switch instead of from Xcode:

```
./run-with-deadline.sh 60      # in-app watchdog 60s, external SIGTERM at 90s
```

That deadline lives in a background shell, so AAC cannot click it away, switch
away from it, or starve it — it only needs the process table.

Most of that is now **verified in simulation** — `--simulate-lockdown` drives
the whole state machine with no `AEAssessmentSession` behind it, and
`--simulate-stuck-end` rigs `end()` never to confirm so the escalation paths can
be reached deliberately. Neither locks anything, so they run on any Mac:

```
./run-with-deadline.sh 10 --simulate-lockdown --auto-begin
```

> **Caveat that matters.** Simulation proves our code, not AAC. Whether
> `end()` actually gives the Mac back is untested and untestable without the
> entitlement. Treat the next real run as a test of the exits as much as of
> capture — the procedure is in [FIRST-SESSION-RUNBOOK.md](./FIRST-SESSION-RUNBOOK.md).

The load-bearing question below is still unanswered. See
[RESULTS.md](./RESULTS.md) for everything learned so far.

## Question this answers

Can a macOS app call `ScreenCaptureKit` (`SCScreenshotManager.captureImage` / `SCStream`) while inside an active `AEAssessmentSession`? Apple docs don't say; SEB's release notes say it's unreliable. The Phase 3 thumbnail-grid plan depends on resolving this.

## Pass / fail

- **Pass**: `Capture Frame` writes a JPEG to `~/Library/Application Support/PocA/poc-frames/` while a session is active, and the frame content matches the actual screen (not black, not zeroed).
- **Fail**: capture errors out, returns black frames, or returns frames stripped of the assessment window's content. → Phase 3 thumbnail grid dies; live monitoring falls back to WebRTC-peek + metadata only.

**Outcome (2026-08-27): fail, the third form.** Capture succeeds inside a session, but the assessment window is a solid grey rectangle in the frame — with `allowsScreenshots` false and true (`--allow-screenshots`). RESULTS finding #13; frames in `frames/`. (Frames land in the app container, not `~/Library/Application Support/PocA/` — the app is sandboxed.)

## Setup

1. Open `PocA/PocA.xcodeproj` in Xcode.
2. Select the PocA target → **Signing & Capabilities** → confirm the **Peninsula School District** team is selected.
3. ~~Once Apple has granted the AAC entitlement: **+ Capability** → **Automatic Assessment Configuration**.~~ **Already done** (2026-08-26). `PocA/PocA/PocA.entitlements` is committed and `CODE_SIGN_ENTITLEMENTS` is set on both configurations. To re-verify after a build:
   ```
   codesign -d --entitlements - "$(find ~/Library/Developer/Xcode/DerivedData -name 'PocA.app' -path '*Products*' | head -1)"
   ```
   Expect `com.apple.developer.automatic-assessment-configuration` = true alongside `com.apple.security.app-sandbox` = true.
4. **Cmd-R** to build and run. macOS will prompt for Screen Recording permission on first capture — grant it via System Settings → Privacy & Security → Screen Recording.

The PoC window shows two buttons (Enter Assessment, Capture Frame) and a scrolling log view. On Enter Assessment, the controller logs the `Mirror` walk of the AAC configuration before calling `begin()` (note: `Mirror` returns no labeled children for these Obj-C bridged types — separate finding, see RESULTS.md).

## Test procedure

**Precondition: the exit path must be in place first** (RESULTS.md finding #10).
Before clicking Enter Assessment, also arm an out-of-band escape: enable System
Settings → General → Sharing → **Remote Login**, and confirm from a phone or a
second machine that `ssh <thismac> killall PocA` reaches it. Whether killing the
process ends the session is itself unverified — record what happens.

Record outcomes in `RESULTS.md`. Run each row twice — once with assessment active, once inactive — and note any difference. **Step 1 is not a formality**: the only capture baseline we have was taken unsandboxed in May, so it is not comparable to anything measured now (RESULTS finding #9). Re-take it first or a failed capture inside a session is uninterpretable.

1. Click **Capture Frame** with no session active → baseline. Expect: JPEG written, content visible.
2. Click **Enter Assessment** → record what the system UI does (menu bar, Dock, Cmd-Tab, screenshot shortcut, screen recording shortcut).
3. Click **Capture Frame** while session is active → key data point.
4. Open the JPEG. Is it the live screen? Black? Partial? Stripped of the AAC window?
5. End session. Repeat capture. Expect: returns to baseline.

Also worth observing while a session is active:
- Does `Cmd-Shift-3` / `Cmd-Shift-4` produce screenshots on disk?
- Does QuickTime's "New Screen Recording" work?
- Does macOS's built-in screenshot HUD appear?

## What this PoC is NOT

- Not notarized — Xcode's automatic local signing is sufficient for development.
- **Sandboxed** — `ENABLE_APP_SANDBOX = YES`, and the signed entitlements confirm it. Frames therefore land in the app's container, not in `~/Library/Application Support/PocA/`. (This line used to say "not sandboxed", which was true only of the pre-`.xcodeproj` build that took the May capture baseline. See RESULTS.md finding #9.)
- Not networked — no upload anywhere. Everything stays local.
- Not a UI — buttons + log. No styling, no error recovery.

## File map

- `PocA/PocA.xcodeproj/` — Xcode project (file-system-synchronized groups).
- `PocA/PocA/AppDelegate.swift` — `@main` plus explicit `static func main()` that wires the delegate (no storyboard).
- `PocA/PocA/AssessmentSessionController.swift` — `AEAssessmentSession` wrapper + `Mirror` introspection.
- `PocA/PocA/ScreenCaptureService.swift` — single-shot `SCScreenshotManager.captureImage`.
- `PocA/PocA/Assets.xcassets/` — default Xcode asset catalog.
- `RESULTS.md` — running log of what this PoC has actually learned.

## Why an Xcode project and not Swift Package Manager

SwiftPM packages opened in Xcode do not expose the Signing & Capabilities tab. Capability provisioning (which is what we need for the AAC entitlement) requires a real Xcode `.xcodeproj`. The earlier SwiftPM-only scaffold was correct for the question we *thought* this PoC would answer; it became wrong once we discovered the entitlement gate.

## Open questions for next iteration

Tracked in `RESULTS.md`'s "What we'll do once the entitlement is granted" section.
