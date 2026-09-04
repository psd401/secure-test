# First session runbook — PoC-A on a PSD Mac

The entitlement is granted and `AEAssessmentSession.begin()` succeeds. The
first run that started a session had no exit and the machine was power-cycled
(RESULTS finding #10). This runbook was written for the run after that.

**Status 2026-08-26 (evening): runs 1–4 done.** Watchdog, button, `Cmd-E` and
`Cmd-Q` each ended a real session and the Mac came back every time (RESULTS
finding #12). Run 5 needs Remote Login. **2026-08-27:** IT admin-toggled Screen
Recording on for the sandboxed `PocA.app`, so the measurements are no longer
blocked — "Before you start" step 3 (where the 2026-08-26 capture attempt
failed) can now be done. Remote Login is not yet enabled; that conversation is
scheduled, so run 5 stays on `run-with-deadline.sh` until it lands.

## Why this can only happen on district hardware

AAC needs the restricted entitlement, which needs a provisioning profile from
team `<TEAM_ID>`, which needs the device registered to that team. A personal
Mac would have to be enrolled to run this, which is not a reasonable trade for
one test. On an unregistered machine `begin()` fails with
`AEAssessmentErrorDomain` error 1 and nothing locks — safe, but it measures
nothing.

## What is already proven, and what isn't

`--simulate-lockdown` drives the whole state machine with no `AEAssessmentSession`
behind it, so most of the exit path was verified without locking anything.

| Behavior | Status |
|---|---|
| Watchdog ends the session at `--session-timeout` | Verified in simulation (fired at exactly 10s; 8s clamped to the 10s floor) |
| Escalation quits the process when `end()` hangs | Verified in simulation (10s → 15s → exit at 20s) |
| Quit path with confirmation | Verified in simulation (~2s after SIGTERM) |
| Quit path when `end()` never answers | Verified in simulation (bounded 5s hard-exit) |
| `run-with-deadline.sh` external deadline | Verified (deadline fired, no stray process) |
| Button label tracks state | State machine verified; the rendering itself is unclicked |
| `Cmd-E` dispatches inside a session | **Verified 2026-08-26** (finding #12); whether the menu bar is *visible* is still checklist step 5 |
| **Does `end()` actually give the Mac back** | **Verified 2026-08-26** — watchdog, button, `Cmd-E`, `Cmd-Q` each ended a real session (finding #12) |

Both of those rows were filled on 2026-08-26. Treat a green simulated run as
evidence about our code, never about AAC.

## Before you start

1. **Ask IT for two things in one message.** (a) Sharing → **Remote Login**
   needs admin; it restores `ssh <mac> killall PocA`, the one exit with
   independent evidence behind it (if no, continue — `run-with-deadline.sh` is
   the substitute). (b) **Screen Recording for bundle id
   `net.psd401.securetest.PocA`** — a Jamf PPPC profile, or an admin flipping
   the `PocA.app` row in System Settings. Without (b) the measurements below
   cannot run at all (finding #12). **Status 2026-08-27:** (a) still pending,
   conversation scheduled; (b) done by admin toggle, PoC bundle only — the
   shipping client (`net.psd401.securetest.client`) will need its own request
   once it is packaged, so keep its bundle id handy for that ask. **And the
   terminal you launch from needs Screen Recording too** — TCC attributes a
   process started from a shell to the terminal app (iTerm2 here), so (b)
   alone still failed until iTerm2 was toggled on (finding #13).

2. **Confirm the entitlement reached the binary.**
   ```
   codesign -d --entitlements - "$(find ~/Library/Developer/Xcode/DerivedData \
     -maxdepth 6 -path '*/Build/Products/Debug/PocA.app' \
     -not -path '*Index.noindex*' | head -1)"
   ```
   Expect `com.apple.developer.automatic-assessment-configuration` true, next to
   `com.apple.security.app-sandbox` true. Excluding `Index.noindex` matters —
   Xcode's indexer keeps a stub with the same name and no binary inside.

3. **Take the capture baseline first, outside any session.** Launch normally,
   click **Capture Frame** once, grant Screen Recording at the prompt.
   **Check the grant landed on the right row**: System Settings → Privacy &
   Security → Screen Recording can show two entries — `PocA` (bare-executable
   icon; the May unsandboxed build) and `PocA.app` (this sandboxed bundle).
   Only the second counts. On 2026-08-26 the first was on, the second off, and
   `SCShareableContent` failed with `The user declined TCCs` inside the session
   (finding #12). Flipping it needs admin on the PSD Mac — step 1(b). Two
   reasons it comes first: that TCC dialog is the last thing you want appearing
   inside a session, and the only baseline on file was taken by May's
   *unsandboxed* build, so it is not comparable to anything this build produces.
   Without a sandboxed baseline a black frame in-session is uninterpretable —
   sandbox or AAC, no way to tell.

4. **Rehearse in simulation on the same machine.** Costs a minute and confirms
   the build on this hardware behaves like the one that was tested:
   ```
   ./run-with-deadline.sh 10 --simulate-lockdown --auto-begin
   ```
   Expect DID BEGIN, a countdown, WATCHDOG at 10s, DID END, and no stray process.

## Run 1 — does the Mac come back

One question only. Do not combine it with capture; if something goes wrong you
want one variable.

1. **Launch through the script, never from Xcode.** Xcode's Stop button sends
   SIGKILL, which is untrappable — `end()` never runs.
   ```
   ./run-with-deadline.sh 30
   ```
   In-app watchdog 30s, external SIGTERM 60s, SIGKILL 65s. Log goes to this
   terminal as well as the window, so it survives any kill.

2. **Click Enter Assessment. Then touch nothing.** Not the button, not the menu,
   not Cmd-Q. Start a stopwatch.

3. **Watch two things.** The button should read `End Assessment — auto-ends in
   Ns` and tick down; a frozen countdown means the watchdog is not being
   serviced inside a session, which is itself the finding. Note what happened to
   the menu bar and Dock.

### Reading the result by the clock

| Desktop returns at | Means |
|---|---|
| ~30s | In-app watchdog works inside a session. This is the result that makes the client safe to build. |
| ~60s | Watchdog did not fire under AAC; trapped SIGTERM did. Rework the watchdog before the client goes near `begin()`. |
| ~65s | Both in-app paths failed, but macOS releases a session on process death. Worth knowing. |
| never | AAC does not reclaim on process death and no external kill helps. Power-cycle, then write it down — it makes an MDM-level escape a hard requirement, and it means the shipping client can strand a student. |

## Runs 2–5 — one exit per session

Only after run 1 returns. Use `./run-with-deadline.sh 120` so the external
deadline does not pre-empt the exit you are testing. One exit per run, or you
cannot attribute the result.

- **Run 2 — the button.** Enter, wait, click **End Assessment**. Look for
  `Delegate: session DID END`.
- **Run 3 — the menu.** Enter, then `Cmd-E`. Doubles as the answer to whether
  the menu bar is reachable at all inside a session (checklist step 5).
- **Run 4 — quit.** Enter, then `Cmd-Q`. Expect a brief pause while the quit is
  cancelled, the session ends, and the quit is re-issued.
- **Run 5 — remote kill.** Only if IT enabled Remote Login. Enter, then from
  another machine: `killall PocA`.

## Then the measurements

The questions PoC-A was built for, unreachable until now.

- ~~**Capture inside a session.**~~ **Done 2026-08-27** (finding #13): the
  frame is written, the assessment window in it is a flat grey box, with the
  default config and with `--allow-screenshots` (sets
  `config.allowsScreenshots = true`). Thumbnail grid dropped; live monitoring
  falls back to WebRTC peek plus metadata. Frames in `frames/`.
- ~~**System behaviors.**~~ **Done 2026-08-27** (finding #15): screenshot
  keys, `Cmd-Tab`, Spotlight, Dock suppressed with a beep; menu bar and
  Mission Control silent. QuickTime not launchable from inside a session.
- ~~**Secondary apps.**~~ **Done 2026-08-27** (finding #15): run with
  `--allow-calculator`; the app launches Calculator, then Safari, itself.
  Calculator visible and interactive; Safari launches but stays hidden until
  the session ends. This is the mechanism every assistive-tech accommodation
  runs through.
- **In-process snapshot** (added the same day, finding #14): the **Snapshot
  Window** button renders the app's own view with `cacheDisplay` — full
  content inside a session, where Capture Frame returns a grey box.

## Recording it

Log lines go to stderr as well as the window, so the terminal running the script
keeps the record even through a SIGKILL. Save each run's output and fold the
outcomes into `RESULTS.md`; update `docs/plan.md` risk #1 if capture changes the
architecture.

Two things do **not** transfer from any test machine and need re-verification on
managed hardware before a pilot: Screen Recording granted by a Jamf PPPC profile
rather than a manual prompt, and behavior under a non-admin student account.
