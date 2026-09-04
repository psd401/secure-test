# Unblock Checklist

When each of the two external dependencies clears, these are the exact steps to take so the relevant PoC produces empirical results the same day. Both can run in parallel if both clear at once.

---

## When Apple grants the AAC entitlement — **TRIGGERED 2026-08-26**

Trigger: an email from Apple Developer Support confirming `com.apple.developer.automatic-assessment-configuration` has been authorized for PSD's Apple Developer Program team (the team behind the Apple ID James uses with Xcode).

**This fired on 2026-08-26.** Apple indicated the authorization had been in place
for a while and the notification was missed on their side, so the grant date is
unknown; 2026-08-26 is when we found out. Status of the steps below:

| Step | State |
|---|---|
| Pre-checks | Done — capability appears in the picker for team `<TEAM_ID>`; PoC-A builds clean |
| 1. Add the capability | **Done.** `PocA/PocA/PocA.entitlements` + `CODE_SIGN_ENTITLEMENTS` on both configurations |
| 2. Verify it reached the build | **Done.** `codesign -d --entitlements -` shows the key true (PoC-A RESULTS finding #8) |
| 3. Run PoC-A | **Done.** `DID BEGIN` on macOS 26.6.2 / Xcode 26.6; first run needed a forced shutdown; the evening's runs ended sessions via watchdog, button, Cmd-E and Cmd-Q (RESULTS finding #12) |
| 4. ScreenCaptureKit inside a session | **MEASURED 2026-08-27** (finding #13). Baseline live; in-session frame written but the assessment window is a flat grey box, `allowsScreenshots` false or true. "Black / zeroed / missing content" outcome → thumbnail grid dropped |
| 5. Characterize other behaviors | **Done 2026-08-27** (finding #15): screenshot keys, Cmd-Tab, Spotlight, Dock suppressed with a beep; menu bar and Mission Control dead silent |
| 6. Secondary-app accommodations | **Done 2026-08-27** (finding #15, `--allow-calculator`): Calculator visible and interactive; Safari launches as a process but stays invisible until the session ends, then appears |

### Step 0 — build an exit path, and arm an out-of-band escape

Added 2026-08-26, ahead of everything below, because skipping it cost a forced
shutdown. AAC suppresses app switching; once a session is up, the only way out is
the app's own code.

- ~~PoC-A's exit path is broken in four separate ways (RESULTS finding #10).~~
  **Written 2026-08-26.** Button label tracks session state; a main menu exists
  with `End Assessment` (Cmd-E) and Quit (Cmd-Q); closing the window quits and
  quitting ends the session; SIGTERM is trapped; and a watchdog ends the session
  after `--session-timeout` seconds (default 120) with a 5s escalation to process
  exit if `end()` hangs. **Verified inside a real session on 2026-08-26**: watchdog,
  button, Cmd-E and Cmd-Q each ended a session and returned the desktop (RESULTS
  finding #12). Window close, SIGTERM and the escalation paths remain
  simulation-only.
- Independently of the code: enable System Settings → General → Sharing →
  **Remote Login**, and verify from a phone or second machine that
  `ssh <thismac> killall PocA` connects *before* starting a session. `killall`
  sends SIGTERM, which the app now traps and turns into an ordered teardown
  (verified outside a session on 2026-08-26); whether that lands while AAC is
  active is unverified — note the answer.
- **The full procedure now lives in `poc-a-aac-capture/FIRST-SESSION-RUNBOOK.md`** —
  prerequisites, the one-question smoke test, a clock-based reading of the
  result, then one exit per run. Follow it instead of improvising from this
  checklist.
- **Rehearse first.** `./run-with-deadline.sh 10 --simulate-lockdown --auto-begin`
  exercises the watchdog, escalation and teardown handshake without creating a
  session. Everything except "does AAC release the Mac" is verifiable this way,
  and it needs no entitlement.
- **On a Mac where you are not an admin, the step above is not available** and
  the only verified exit goes with it. That is the situation on James's PSD
  machine as of 2026-08-26. Substitute `poc-a-aac-capture/run-with-deadline.sh`,
  which puts the kill-switch in a background shell instead of over the network:
  no admin, no sshd, no GUI required. Launch the session run through it rather
  than from Xcode.
- Do not set `config.allowsKeyboardShortcuts = true` just to make `Cmd-Q` live on
  the first measurement run. It defaults to `false` on macOS 15+, and the default
  configuration is what step 5 is supposed to characterize. Flip it on a later run,
  deliberately.

**Read this first — there are now TWO targets, and they want different things.**

This checklist was written in May, when PoC-A was the only thing that could use
the entitlement. It is still correct for PoC-A, and PoC-A is still the right
place to answer the load-bearing question (does ScreenCaptureKit work inside a
session?) because it is a bare spike with nothing else in the way.

But the app that actually ships is now `client/` (Phase 5, slices 51-73). It is
a working student client — join, deliver, answer all eight item types, spool,
upload, hand in — and it has NO `AEAssessmentSession` code at all, because for
its whole life there was no entitlement to write it against. So:

- **PoC-A** — step 0 above, then steps 1-6 below. Steps 1-3 are already done; step 0 and steps 4-6 are what remain. Answers the capture question.
- **`client/`** — steps A-C under "Then wire the real client" further down. Adding
  the capability is not enough; the session has to be written. (An earlier version
  of this line said the client is sandboxed "where PoC-A's measurements were taken
  unsandboxed." Half right: only PoC-A's **May capture baseline** was unsandboxed —
  the target has had `ENABLE_APP_SANDBOX = YES` since the restructure later that
  same day, and the 2026-08-26 AAC session was sandboxed. Both apps are sandboxed
  now. See RESULTS finding #9.)

Do PoC-A first. Its answer decides whether the thumbnail grid is in the client's
future at all, and it is a much smaller thing to debug if the entitlement turns
out not to be applied correctly.

Pre-checks (1 minute):

- The Apple ID associated with PSD's team is added to your Xcode → Settings → Accounts.
- The PSD team appears in the Team dropdown when you open `poc-a-aac-capture/PocA/PocA.xcodeproj` → PocA target → Signing & Capabilities.
- PoC-A still builds clean (`xcodebuild -project PocA/PocA.xcodeproj -scheme PocA -destination 'platform=macOS' build` from within `poc-a-aac-capture/`).

Steps:

1. **Add the capability in Xcode.**
   - PocA target → Signing & Capabilities tab → confirm Team = "Peninsula School District" (or whatever PSD's team name is).
   - **+ Capability** → search "Automatic Assessment Configuration" → double-click.
   - Xcode will auto-create `PocA/PocA/PocA.entitlements` containing `com.apple.developer.automatic-assessment-configuration = true`.

2. **Verify the entitlement made it into the build.**
   ```
   cd poc-a-aac-capture
   xcodebuild -project PocA/PocA.xcodeproj -scheme PocA -destination 'platform=macOS' build
   BIN=$(find ~/Library/Developer/Xcode/DerivedData -name PocA -type f -path '*Products*' 2>/dev/null | head -1)
   codesign -d --entitlements - "$BIN"
   ```
   Expect the entitlements dump to include the AAC key set to `true`.

3. **Run PoC-A.** Xcode → Cmd-R.
   - Window appears as before.
   - Click **Enter Assessment**.
   - Expected log:
     ```
     macOS 26.x.y
     AEAssessmentSession.supportsMultipleParticipants = ...
     AEAssessmentSession.supportsConfigurationUpdates = ...
     Config: mainParticipantConfiguration.allowsNetworkAccess = ...
     Config (macOS 15+): ...
     Config (macOS 26.1+): ...
     Secondary apps allowed: 0
     AEAssessmentSession.begin() called.
     Delegate: session DID BEGIN.
     ```
   - If you instead see `Delegate: session FAILED TO BEGIN — ... [domain=AEAssessmentErrorDomain code=N]`, the entitlement is not actually applied. Re-verify the codesign step above before continuing.

4. **Test the load-bearing question: does ScreenCaptureKit work inside an active session?**
   - **Prerequisite (2026-08-26) — met 2026-08-27:** Screen Recording must be granted to the sandboxed `PocA.app` row, not the stale `PocA` executable row from May — two rows coexist in System Settings and only the bundle one counts (RESULTS finding #12). An IT admin toggled the `PocA.app` row on 2026-08-27. Re-check the row before each run: TCC keys on code identity, so a rebuild that changes signing or sandbox can leave the grant on a row that no longer matches. Take the sandboxed baseline outside a session first.
   - With session active, click **Capture Frame**.
   - Open the resulting JPEG at `~/Library/Application Support/PocA/poc-frames/`.
   - Three possible outcomes:
     - **Live screen content**: Phase 3 thumbnail-grid plan stands. Update `poc-a-aac-capture/RESULTS.md` accordingly.
     - **Black / zeroed / missing content**: thumbnail grid is dead. Update `RESULTS.md` and `docs/plan.md` Phase 3 entry to drop thumbnails; live monitoring falls back to WebRTC-peek + metadata only. **← Outcome 2026-08-27** (RESULTS finding #13, frames in `poc-a-aac-capture/frames/`): the window is a solid grey rectangle in every in-session frame, including one with `config.allowsScreenshots = true` (`--allow-screenshots`). Note the baseline needed Screen Recording granted to **iTerm2** as well — a terminal-launched PocA is attributed to the terminal by TCC.
     - **Error**: copy the exact error to `RESULTS.md`; investigate.

5. **Characterize the session's other behaviors** while it's active. Record outcomes in `RESULTS.md`:
   - `Cmd-Shift-3` / `Cmd-Shift-4`: do screenshots get taken?
   - `Cmd-Shift-5`: does the screenshot HUD appear?
   - `Cmd-Tab`: does it switch apps, or is it suppressed?
   - QuickTime Player's "New Screen Recording": does it work?
   - The menu bar, Dock, Mission Control: how do they behave?
   - **Outcome 2026-08-27** (RESULTS finding #15): `Cmd-Shift-3/4/5`, `Cmd-Tab`, Spotlight and the Dock are suppressed with the alert beep; the menu bar and Mission Control do nothing, no beep. QuickTime not tried — nothing can be launched from inside a session except by the app itself (step 6).

6. **Test the accommodations mechanism (secondary apps).** **Done 2026-08-27** — run PocA with `--allow-calculator` (the block below is now behind that flag, and the app launches Calculator then Safari itself 3 s / 8 s after `DID BEGIN`, since Spotlight and the Dock are suppressed). Outcome (RESULTS finding #15): Calculator visible and interactive; Safari's `NSWorkspace.openApplication` *succeeds* but the window is held off-screen until the session ends. AAC gates visibility, not launch. Original instructions:
   ```swift
   let calc = AEAssessmentApplication(bundleIdentifier: "com.apple.calculator")
   calc.requiresSignatureValidation = true
   let calcConfig = AEAssessmentParticipantConfiguration()
   calcConfig.allowsNetworkAccess = false
   config.setConfiguration(calcConfig, for: calc)
   ```
   Rebuild, click Enter Assessment, then try to launch Calculator from Spotlight or Dock. It should launch (it's allowed). Try to launch something not on the allow list (e.g., Safari). It should be blocked.

7. ~~**Commit results.**~~ Done 2026-08-27 — RESULTS findings #13–15; `docs/plan.md` risk #1, Phase 2/3 entries and 6.16 updated.

### Then wire the real client

**A. Add the capability to the shipping app.** ✅ DONE 2026-08-27 (AAC-2a,
phase-7 slice 93) — but NOT this way: Xcode's capability UI auto-write had
dropped the package refs from the pbxproj, so the entitlements file
(`client/SecureTest/SecureTest.entitlements`, AAC key only — sandbox keys stay
synthesized from `ENABLE_*` settings) and `CODE_SIGN_ENTITLEMENTS` were written
by hand. **App ID: DONE 2026-09-03.** An admin created
`net.psd401.securetest.client` with the restricted AAC capability enabled, and
`PRODUCT_BUNDLE_IDENTIFIER` was flipped off PoC-A's borrowed App ID (both
configurations, by hand in the pbxproj). Verified on the built app: signed
entitlements carry the AAC key and all three sandbox keys, and
`application-identifier` = `<TEAM_ID>.net.psd401.securetest.client`. The
real-session confirmation — that the Mac actually locks — is a hand-run row,
not something `codesign` can prove.
The original steps, for the record:

- Open `client/SecureTest.xcodeproj` → SecureTest target → Signing & Capabilities.
- **+ Capability** → Automatic Assessment Configuration.
- Xcode creates `client/SecureTest/SecureTest.entitlements`.

**B. The sandbox exception — try WITHOUT it first.** *(Rewritten 2026-08-26; the
previous instruction was based on a false premise.)*

Apple's own AAC sample shows a sandboxed app additionally declaring:

```
com.apple.security.temporary-exception.mach-lookup.global-name
  = com.apple.assessmentagent
```

We now have a counter-observation. PoC-A is sandboxed (`ENABLE_APP_SANDBOX = YES`),
its signed entitlements contain **no** such exception, and
`AEAssessmentSession.begin()` succeeded anyway on macOS 26.6.2 (RESULTS finding
#9). One data point, one OS version, a development-signed `get-task-allow` build —
not proof it is never needed, but enough that adding a temporary exception
preemptively is the wrong default.

So: build `client/` without it and try to begin a session. If `begin()` fails,
add the exception and try again — that failure looks exactly like a missing
entitlement, so check `codesign -d --entitlements -` for the AAC key before
concluding anything.

**C. Write the session.** ✅ Begun 2026-08-27 (AAC-2a):
`client/SecureTest/RealLockdownSession.swift` adapts `AEAssessmentSession` to
`AssessmentLockdown.Session` with the restrictive default configuration;
selection is env override → simulated, entitled binary → real, else simulated
(built WITHOUT the mach-lookup exception, per B). Every exit path was already
in `AssessmentLockdown` (AAC-1) and the slice-92 events ride along. The
accommodations mapping (AAC-2b) landed 2026-08-28 (`LockdownConfigurationPlan`
in Core, applied by `RealLockdownSession(plan:)` — phase-7 slice 94), and the
AAC-2a real-session rows ran 2026-08-27 night. Still open from this step:
the AAC-2b hand-run rows ("Accommodations → session config" in
MANUAL-CHECKS). The original notes:

There is nothing to enable — `AEAssessmentSession` does not appear anywhere in
`client/`. What exists is the shape it plugs into:

- `AssessmentViewController` owns the web view and already reports its lifecycle
  through the `[security]` log channel. Beginning the session belongs around the
  point the bundle loads, and ending it around hand-in.
- The per-assessment accommodations already arrive resolved for the individual
  student (`DeliveryBundle.accommodations`, tool id → value). That map is the
  input to `AEAssessmentConfiguration`: the version-gated flags from PoC-A
  RESULTS finding #5, plus `setConfiguration(_:for:)` for any assistive-tech app
  the student is entitled to. The catalog is `lib/accommodations/catalog.ts`.
- **Write the exit path in the same slice as `begin()`, not after it.** PoC-A's
  omission is the whole reason this checklist has a step 0. For the client that
  means at minimum: hand-in ends the session, `applicationWillTerminate` ends the
  session, and a session that outlives its attempt ends itself. A student must
  never be able to reach a state only a power button resolves.
- `client/MANUAL-CHECKS.md` has the hand-check list. Add the AAC rows to it —
  Cmd-Tab, Mission Control, Dock, Spotlight, screenshot keys, dictation — which
  is also where `docs/plan.md`'s "layered-lockdown verification" checklist should
  end up living.

**D. Re-run the manual checks.** Several existing rows change meaning inside a
session: hardware function keys mapped to Mission Control and Spotlight are
OS-governed and are the ones AAC is supposed to take away. They are listed as
"still open" in MANUAL-CHECKS.md precisely because only AAC can close them.

Common gotchas:

- If the capability picker still doesn't show "Automatic Assessment Configuration", the entitlement isn't granted for your team — double-check the Apple email and verify the Team ID matches.
- If the App ID doesn't have the capability enabled, you may need to visit developer.apple.com → Identifiers → App IDs → edit your App ID → check the AAC capability.
- "Sign to Run Locally" won't include managed entitlements — the team selector must be set to PSD's team.
- macOS 26.1+ has more settable flags; if you're on an older release you'll see fewer log lines.

---

## ~~When ClassLink Partner Portal grants application access~~ — HISTORICAL

**Retired 2026-08-26 (ADR 0017, slice 81).** Identity is Google OIDC and the
roster comes from the PSD data warehouse; no ClassLink credential is on any
path, and the Partner Portal registration is no longer awaited. The steps
below are kept as the record of what PoC-C established (PKCE round-trips at
ClassLink's auth endpoint; `ASWebAuthenticationSession` routes a custom-scheme
callback without `CFBundleURLTypes` — the second finding carried into slice
80). What replaces this section: the sign-in rows in `client/MANUAL-CHECKS.md`
and the "Still waits on" list in `docs/phase-6-slices.md`.

Trigger: notification (email or in-portal) that PSD's Partner Portal account is approved and you can create an Application.

Pre-checks (1 minute):

- PoC-C client still builds: `cd poc-c-classlink-sso/client && swift build`.
- PoC-C verify Lambda is still deployed: `curl https://i59aczq3rf.execute-api.us-west-2.amazonaws.com/poc/verify` should return a 4xx (it's POST-only).
- `AWS_PROFILE=<your-sso-profile>` set in your shell.

Steps:

1. **Create the Application in the Partner Portal.**
   - Log in at https://partnerportal.classlink.com/
   - Navigate to Applications → New
   - Field values:
     - **Application name**: `PSD Secure-Test` (or similar)
     - **Description**: `District-built macOS secure-testing browser. Used for in-classroom assessment delivery to PSD students on managed Macs.`
     - **Redirect URI**: `securetestpoc://callback` (exact, no trailing slash)
     - **Grant types**: Authorization Code, with PKCE if the portal exposes it as a checkbox
     - **Scopes**: `openid profile email oneroster` (request `classes` and `classes.readonly` too if relevant for the roster path)
     - **Platforms**: macOS native client
   - Save and copy the **Client ID**. Also note the **Client Secret** if shown (we shouldn't need it for PKCE, but capture it in case PKCE rejection surprises us — see step 5b fallback).

2. **Configure the client.**
   ```
   cd poc-c-classlink-sso/client
   cp config.example.json config.json
   ```
   Edit `config.json`: paste the `clientId` from step 1. Verify the rest:
   ```json
   {
     "issuer": "https://launchpad.classlink.com",
     "authEndpoint": "https://launchpad.classlink.com/oauth2/v2/auth",
     "tokenEndpoint": "https://launchpad.classlink.com/oauth2/v2/token",
     "clientId": "<paste from portal>",
     "redirectURI": "securetestpoc://callback",
     "scopes": ["openid", "profile", "email", "oneroster"],
     "usePKCE": true,
     "callbackURLScheme": "securetestpoc"
   }
   ```
   `config.json` is gitignored; don't commit it.

3. **Run the client.**
   ```
   swift run
   ```
   Window appears. The log should show `Config loaded. issuer=https://launchpad.classlink.com clientId=...`.

4. **Click "Sign in via ClassLink".**
   - System browser opens to ClassLink LaunchPad.
   - Log in with a PSD test user (a real student / staff account, or whatever the portal app is scoped to).
   - On success, the browser redirects to `securetestpoc://callback?code=...`, ASWebAuthenticationSession captures it, and the client log fills with:
     ```
     Auth URL: https://launchpad.classlink.com/oauth2/v2/auth?... &code_challenge=...&code_challenge_method=S256
     Callback: securetestpoc://callback?code=...&state=...
     exchange: HTTP 200
       access_token: ...
       id_token: ...
       refresh_token: ...
       expires_in: <NUMBER>
     id_token claims:
       sub: ...
       classLink_sourcedId: ...
       classLink_role: ...
       email: ...
       ...
     ```
   - **Record `expires_in` in `RESULTS.md` finding #2.** This is the value that decides whether MVP needs silent refresh mid-test or can rely on a single token for the duration.
   - **Verify `classLink_sourcedId` is present in the id_token claims.** If absent, the `oneroster` scope may not be granted to your portal app or we need a different scope name — investigate with ClassLink support.

5. **Verify the id_token server-side.**
   ```
   curl -X POST -H 'content-type: application/json' \
        -d '{"id_token":"<paste from client log>"}' \
        https://i59aczq3rf.execute-api.us-west-2.amazonaws.com/poc/verify
   ```
   Expect HTTP 200 with `{"ok": true, "header": {...}, "claims": {...}}`. If 401, inspect the error message — signature verification failure could mean a key rotation, an issuer mismatch, or a clock skew.

   **5b. PKCE rejection fallback.** If step 4's token exchange returns an error mentioning `code_challenge`, `code_verifier`, or `unsupported_grant_type`:
   - Edit `config.json` → set `usePKCE: false`.
   - This sends the request without PKCE. The auth endpoint accepted PKCE round-trip in our 2026-05-19 probe but if the token endpoint rejects it, you'll need to also configure the client to send `client_secret` on the token exchange. That requires a slightly bigger code change — adopt a confidential-client proxy Lambda design instead (the verify Lambda extended to also do code-for-token exchange server-side). Document the rejection in `RESULTS.md` finding #2.

6. **Test refresh.** Click **Refresh Token**.
   - Expect log: `refresh: HTTP 200` plus a new `access_token`. Note whether `refresh_token` is rotated (new value) or stays the same.
   - Record refresh behavior in `RESULTS.md`.

7. **Commit results.** Update `poc-c-classlink-sso/RESULTS.md` with token lifetimes, claim contents, and any PKCE behavior. If the lifetimes are shorter than ~60 minutes, also update `docs/plan.md` MVP design to require silent in-session refresh.

Common gotchas:

- **PKCE config gotcha**: some portals expose a "Public Client" toggle that must be on for PKCE to work. If you see authorization rejected outright, look for this.
- **Redirect URI exact match**: ClassLink will reject the auth request if the `redirect_uri` parameter doesn't match exactly (including trailing slash, scheme case).
- **Test user**: ensure you have a ClassLink test student / staff account you can log in with — your district admin account may not work for the OAuth flow.
- **Token endpoint TLS / clock skew**: if signature verification fails with a confusing error, check that the Lambda's clock is in sync (it should be — but worth ruling out).
- **Scope grants**: scopes you request might not all be granted. If `classLink_sourcedId` isn't in the id_token, check whether `oneroster` is in the granted scope (often visible in the token response as `scope` field).

---

## When both clear

PoC-A and PoC-C step 4 can run in parallel (different Macs or different terminals). After both complete:

- Update `docs/plan.md` Phase 3 entry based on the ScreenCaptureKit result.
- Update `docs/plan.md` risk #1 (capture) and risk #2 (PKCE/lifetime) with the now-final empirical answers.
- Decide on MVP scope adjustments: is per-student accommodations needed in MVP, or wait for Phase 3? Is silent refresh a Phase 1 requirement or Phase 2?
- Notify any stakeholders waiting on the feasibility outcome.
