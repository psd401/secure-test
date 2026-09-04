# Secure-Test (macOS) — Feasibility, MVP, and PoC Plan

## Context

- PSD needs a macOS app that acts as a secure browser for students taking tests on managed Macs.
- Two delivery modes: teacher-pushed via rostering (ClassLink) and ad-hoc session codes.
- Must lock out other applications; staff roles configure accommodations (assistive tech, more permissive mode).
- Teacher monitor: live thumbnails, live progress, on-demand screen share, anomaly alerts.
- All Macs are in PSD's managed environment (Jamf, supervised).
- Output: feasibility memo + MVP scope + PoC scoped to greenlight a build.
- Greenfield project at `/Users/cantonwinej/code/secure-test/` (empty directory).

## Recommended Approach: Custom Swift app on Apple AAC

- Apple's **Automatic Assessment Configuration (AAC)** is supported on macOS since 10.15.4 (Catalina); WWDC20 expanded parity with iPadOS.
- AAC on macOS exposes a "secondary app" accommodations mechanism via `AEAssessmentConfiguration.setConfiguration(_:for:)` — register `AEAssessmentApplication(bundleIdentifier:teamIdentifier:)` for each assistive-tech app that should remain reachable during an assessment. (Earlier draft of this plan said `AEAssessmentParticipantConfiguration` was the accommodations primitive on macOS; that was incorrect — verified against the SDK headers 2026-05-19. On macOS the participant config has only `allowsNetworkAccess`, `required`, and `configurationInfo`. Per-feature flags like spell-check and autocorrect live on `AEAssessmentConfiguration` itself, gated by macOS version.)
- Safe Exam Browser was evaluated and rejected: MPL-1.1 source but closed security module; meaningful customization needs SEB Alliance Platinum/Diamond; no documented ClassLink/OneRoster path; SEB does not use AAC under the hood.
- macOS AAC gap to be aware of: spell-check and autocorrect are **not** auto-restricted on macOS (unlike iPadOS). Handle at WKWebView level via `spellcheck="false"` and `autocomplete="off"`.
- Trade-off accepted: PSD owns the security surface. Mitigated by keeping the surface narrow (Apple frameworks, no custom kernel / system extension code).

## System Architecture

```
                +-----------------------------------------------------------+
                |                  TEACHER WEB MONITOR (React)              |
                |  thumbnail grid | progress | on-demand peek | alerts      |
                +------------------------------^----------------------------+
                                               |  HTTPS / WSS
+--------------------------------------+       |       +--------------------+
|  ClassLink LaunchPad (OIDC)          |       |       | ClassLink Roster   |
|  - student & staff SSO               |       |       | Server (OneRoster  |
|  - PKCE (CONFIRM with vendor)        |       |       | 1.2, OAuth2 CC)    |
+------------------+-------------------+       |       +---------+----------+
                   | id_token                  |                 | daily pull
                   v                           v                 v
+----------------------------------------------------------------------------+
|                  AWS BACKEND (standalone account)                          |
|                                                                            |
|  API Gateway (HTTPS + WebSocket)                                           |
|     +-- Lambda: auth (OIDC verify, session JWT mint)                       |
|     +-- Lambda: roster-sync (OneRoster -> Aurora)                          |
|     +-- Lambda: session/test delivery                                      |
|     +-- Lambda: response intake                                            |
|     +-- Lambda: anomaly intake -> EventBridge -> SNS                       |
|                                                                            |
|  Aurora Postgres Serverless v2  (users, rosters, sessions, responses)      |
|  S3 (test items, thumbnails, response artifacts; SSE-KMS)                  |
|  Kinesis Video Streams + WebRTC  (on-demand 1:1 screen share)              |
|  Cognito (teacher dashboard; students auth direct via ClassLink)           |
|  CloudWatch + GuardDuty + WAF                                              |
+-------------------^---------------------------------^----------------------+
                    | HTTPS                            | WebRTC signaling
                    v                                  v
+----------------------------------------------------------------------------+
|                       macOS CLIENT (Swift / AppKit)                        |
|                                                                            |
|  AEAssessmentSession              <- AAC kiosk (Apple)                     |
|  setConfiguration(_:for:)         <- accommodations: allow AT apps by      |
|                                      bundle ID (the macOS mechanism)       |
|  WKWebView                        <- test item renderer (sandboxed)        |
|  ScreenCaptureKit                 <- thumbnails (PoC must prove inside AAC)|
|  NSWorkspace / NSPasteboard       <- anomaly observers                     |
|  amazon-kinesis-video-streams-webrtc SDK                                   |
|  Keychain                         <- refresh token, session JWT            |
+-------------------^--------------------------------------------------------+
                    |
            +-------+--------+
            |   Jamf Pro     |  PPPC profile (Screen Recording grant),
            |   (MDM)        |  config profiles, app deployment,
            +----------------+  supervised-device assumption
```

- **Reused / standards-based**: AAC, ScreenCaptureKit, WKWebView, OneRoster 1.2, OIDC + PKCE, LTI 1.3 (phase 4), WebRTC.
- **District-built**: session/test delivery service, accommodations engine, anomaly engine, teacher web monitor, item authoring (phase 3).

## PoC (all three in parallel)

Three thin, independently shippable spikes. Each has a clear pass/fail.

### PoC-A — AAC + ScreenCaptureKit interaction (load-bearing)

- Signed Mac app (Developer ID + hardened runtime); Screen Recording TCC granted manually for the spike.
- Enters `AEAssessmentSession` with a default-restrictive `AEAssessmentConfiguration`.
- Attempts `SCStream` capture of own window and full display; writes frames to `~/Library/Application Support/PocA/poc-frames/`.
- **Proves / disproves**: whether the assessment app itself can capture inside an active session. (Apple does not expose a public flag governing `SCStream` behavior during a session; the question is whether the OS denies capture regardless of caller. The `allowsScreenRecording` flag we initially expected does not exist — what does exist on macOS 26.1+ is `AEAssessmentConfiguration.allowsScreenshots`, which only governs the Cmd-Shift-3/4 clipboard pathway, not API-driven capture. SDK-header verified 2026-05-19.)
- **If A fails**: thumbnail grid is dropped from the roadmap; fall back to WebRTC-only peek + metadata live view.

### PoC-B — Test delivery loop

- Same Mac app target, second mode.
- Loads hardcoded JSON payload (3 MC items) from bundled file.
- Renders in `WKWebView` with JS bridge whitelisted to response-capture messages only.
- POSTs responses to stub API Gateway → Lambda → CloudWatch log.
- **Proves**: item schema viability, WKWebView sandboxing posture, response round-trip on real AWS.

### PoC-C — ClassLink dev tenant + SSO

- Sign PSD up via the **ClassLink Partner Portal** (`partnerportal.classlink.com`) — free, self-service, no district-vendor approval needed. IT available as backstop if signup hits friction.
- Use sandbox endpoint `https://sandbox-vn-v2.oneroster.com` for OneRoster tests.
- Native OIDC flow with PKCE via `ASWebAuthenticationSession` from the Mac app.
- Stub Lambda verifies id_token signature; observe access/refresh token lifetimes.
- **Proves / disproves**: PKCE support on LaunchPad (unconfirmed in docs), refresh-token behavior across a realistic test window, whether mid-test re-auth is needed.

## MVP Scope (Phase 1)

**Goal:** smallest thing that proves PSD can run a test on a Mac in lockdown with student auth from ClassLink.

**IN**
- Signed, notarized macOS app, deployed via Jamf to supervised devices.
- ClassLink LaunchPad OIDC login (PKCE), refresh-token flow, session JWT to AWS.
- AAC kiosk via `AEAssessmentSession`; restrictive `AEAssessmentConfiguration`; WKWebView-level block of spell-check/autocorrect.
- Session-code delivery only (6-char code).
- Text-only items: multiple choice + short constructed response. Single item at a time.
- Response upload (HTTPS, idempotent retry, local SQLite spool if offline).
- Teacher web dashboard: session create, manually-pasted student list, results view (post-hoc, not live).
- Jamf PPPC profile shipped so Screen Recording grant is in place ahead of phase 2/3.

**OUT (deferred)**
- OneRoster auto-sync (phase 2)
- Live thumbnails / anomaly stream / on-demand peek (phase 2/3) — screen-capture-based thumbnails are dead (AAC redacts the assessment window in ScreenCaptureKit frames, PoC-A finding #13); both image features rebase on the client's in-process render (finding #14). The anomaly stream's server half is BUILT (slice 91: `attempt_events`, `POST /api/attempts/:attemptId/events`, alerts folded into attendance + monitor); the client's event wiring remains (with AAC-2)
- Accommodations engine via `setConfiguration(_:for:)` (phase 3)
- Authoring portal (phase 3)
- LTI 1.3 launchers to Edulastic / NWEA / state (phase 4)
- iPad and Chromebook clients (phase 4)
- ~~Item types beyond MC + short text~~ — BUILT. All eight types author, deliver
  and score (design-tool phases 3-4, client Phase 5).
- ~~Accommodations engine~~ — the per-student RESOLUTION is built and reaches the
  client (`DeliveryBundle.accommodations`). What is still deferred is the AAC
  half: `setConfiguration(_:for:)` to permit assistive-tech apps. As of
  2026-08-26 the entitlement is granted, so this is buildable work rather than a
  wait — it is untested (PoC-A checklist step 6 was never reached).

**Note on phase numbering.** The phases above are this document's original May
numbering (MVP / OneRoster / anomaly+thumbnails / LTI). The design tool grew its
own Phase 1-4 (`docs/phase-*-slices.md`) and the student client is Phase 5
(`docs/phase-5-slices.md`), which are a DIFFERENT sequence — "Phase 3" means two
unrelated things depending on which document you are reading. Worth
reconciling.

## Phased Roadmap

- **Phase 1 — MVP**: as scoped above.
- **Phase 2**: ~~OneRoster pull-sync (daily Lambda)~~ → warehouse extract nightly (ADR 0017, built; awaiting the data engineer's first push), ~~teacher monitor v2 (live progress metadata via WebSocket, no images)~~ → **done 2026-08-27** as polling (phase-7 slices 85–87), ~~session pre-assignment from roster~~ → **done 2026-08-27** (phase-7 slices 82–84), on-demand peek (1:1, teacher-initiated, student-notified; fed by the client's in-process render, not screen capture — PoC-A finding #14), session pre-assignment from roster.
- **Phase 2, added 2026-09-01 (E5 slice 2 decision)**: per-question paging in the student client — today the page is one scrolling document, which James accepted for the MVP; a stimulus marked `own_page` therefore renders inline until paging exists, and the flag already rides the delivery bundle for when it does. **BUILT 2026-09-02: `docs/client-paging-design.md`** (a per-assessment setting, default scroll, migration 0027; own_page = a passage page then one page per question; slices 1–3 landed the same day, hand-runs wait on the deploy; follow-up: answered marks fed by the delivery route).
- **Phase 3**: anomaly event stream (focus loss, paste, key combos), thumbnail grid (gated on PoC-A result), accommodations engine driving `setConfiguration(_:for:)` (allow assistive-tech apps by bundle ID), district-built authoring portal with item bank in S3 + Aurora.
- **Phase 4**: LTI 1.3 launchers (Edulastic / NWEA / state — each its own integration), iPad client (UIKit shell, reuse AAC), Chromebook PWA (ChromeOS managed kiosk; no AAC equivalent).

## Key Risks (ranked)

1. **AAC + ScreenCaptureKit unverified inside session.** ***MEASURED 2026-08-27 — capture runs, assessment window redacted; thumbnail grid dropped*** (PoC-A RESULTS finding #13: a frame is written inside the session, but the app's own window is a flat grey rectangle, with `allowsScreenshots` false and true; a frame taken after `begin()` but before `DID BEGIN` still showed content). Second branch below applies. *History:* Apple's SDK headers (verified 2026-05-19) reveal no public property governing `SCStream` behavior during an active session. SEB release notes say AAC's capture blocking on macOS is unreliable. The question is whether the OS denies capture regardless of caller. The entitlement gate (risk #6) **cleared 2026-08-26** and `AEAssessmentSession.begin()` now succeeds, so a session can be entered. The first 2026-08-26 run ended in a forced shutdown (no exit path); the exit path was built and then verified inside a real session the same evening — watchdog, button, Cmd-E and Cmd-Q all returned the Mac. The capture attempt itself failed at **TCC, not AAC**: Screen Recording is granted to the May build's code identity, not to the sandboxed `PocA.app`, and flipping it needs admin on the PSD Mac (RESULTS finding #12). → IT grants Screen Recording to `net.psd401.securetest.PocA` (PPPC or admin), then run the spike, sandboxed baseline first. If capture fails, drop thumbnail grid; fall back to WebRTC-peek + metadata live view — subject to open question 6.16. **Resolved:** 6.16 closed the same day — the fallback is an in-process render, not screen capture (finding #14).
2. **~~ClassLink PKCE + token lifetime mid-test.~~ RETIRED 2026-08-26 (ADR 0017).** Identity moved to Google OIDC: PKCE is documented and mandatory for Google's native clients, so the ClassLink probe (2026-05-19, RESULTS in `poc-c-classlink-sso/`) no longer bears on anything. The client's PKCE flow is built and unit-tested (slice 80); the session it mints is the design tool's own 8-hour JWT (`lib/auth/session.ts`), so mid-test re-auth is governed by that TTL, not by an IdP token lifetime. *Successor risk:* whether Google Workspace trusts the OAuth client for `edtools.psd401.net` student accounts — Workspace for Education blocks unconfigured third-party apps for under-18 users by default. → Verified at the first student sign-in (`client/MANUAL-CHECKS.md`, slice 80 rows); if refused, the Workspace admin allowlists the client id.
3. **Jamf has no native time-windowed profile activation.** → Activate restrictions from the app at session start or pre-stage permissive profile and have the app enforce at runtime; do not rely on Jamf scheduling.
4. **FERPA scope creep with video of minors.** → WebRTC peek is 1:1, ephemeral, no Kinesis archival; thumbnails (if enabled) low-res, retention ≤ 30 days, KMS-encrypted, access-logged; parent notification language drafted with district counsel before phase 3.
5. **TCC Screen Recording grant UX.** TCC is per-Mac per-user; first-time student on a new Mac would see a prompt. → Jamf PPPC profile pre-stages non-admin grant; policy ensures profile on every assessment-eligible Mac. *Arrived early, 2026-08-26:* the developer's own PoC build was denied because the grant sat on a previous code identity (`PocA` executable vs `PocA.app` bundle) and the non-admin account cannot flip it — TCC keys on code identity, so a rebuild that changes sandbox/signing silently loses the grant (RESULTS finding #12).
6. **~~Apple AAC entitlement is restricted.~~ RESOLVED 2026-08-26.** `com.apple.developer.automatic-assessment-configuration` is a restricted entitlement that does not appear in Xcode's "+ Capability" picker until Apple authorizes it for the team. Requested from Apple Developer Support 2026-05-19; **granted**, with the notification reaching us 2026-08-26 (Apple indicated the authorization itself predated that and the notification was missed). Verified end to end: the capability appears in the picker for team `<TEAM_ID>`, the key survives into the signed binary, and `AEAssessmentSession.begin()` succeeds on macOS 26.6.2 — confirming that the earlier `AEAssessmentErrorDomain` error 1 (`AEAssessmentErrorUnknown`) was the missing entitlement and nothing else. **Successor risk (new, ours not Apple's): an app that can enter lockdown and not leave it.** PoC-A's first session had to be ended by holding the power button. → Every code path that calls `begin()` ships with an exit path in the same change: a visible end control, session teardown on quit, a non-disableable timeout, and a last-resort backstop that does not run on the main queue. Build it behind a simulation seam so it is testable without the entitlement — that is how the `.terminateLater` deadlock (RESULTS finding #11) was caught before it locked a Mac. As of the evening of 2026-08-26 the watchdog, button, Cmd-E and Cmd-Q have each ended a real session and released the machine (RESULTS finding #12); window close, SIGTERM and the escalation paths remain simulation-only. Side observation from the same runs: `allowsKeyboardShortcuts` at its default did not suppress the app's own Cmd-E/Cmd-Q — the client must own quit-prevention itself. Tracked in `poc-a-aac-capture/RESULTS.md` findings #10-#11, `poc-a-aac-capture/FIRST-SESSION-RUNBOOK.md`, and `docs/unblock-checklist.md` step 0.

   **Device-registration constraint (2026-08-26):** the entitlement needs a provisioning profile from Apple team `<TEAM_ID>`, which needs the device registered to it. AAC therefore only runs on district-provisioned Macs — a personal machine cannot be used to test it without enrolling it in the org, which was declined. Plan every AAC measurement as district hardware time.
7. **WKWebView item-render escape surface.** → Strict CSP, no remote script eval, content served same-origin from district CDN, JS bridge whitelisted to named messages only.
8. **Standalone AWS account ops burden.** → IaC from day 1 (CDK or Terraform), reuse IAM/SSO baseline from existing AI Studio account.
9. **Accommodations selective re-enable inside AAC.** *Mechanism corrected 2026-05-19.* The macOS accommodations primitive is `AEAssessmentConfiguration.setConfiguration(_:for:)` — register `AEAssessmentApplication(bundleIdentifier:teamIdentifier:requiresSignatureValidation:)` instances for each assistive-tech app to remain reachable. The per-app participant config controls `allowsNetworkAccess`. AAC supports `update(to:)` mid-session if `AEAssessmentSession.supportsConfigurationUpdates` is true. → Per-student accommodations flow: at session create, read the student's accommodation flags, build a config that allows the relevant AT app bundle IDs, begin the session with that config.

## Critical Files (to be created)

Actual PoC layout (created 2026-05-19, paths differ from the original sketch):

- `poc-a-aac-capture/PocA/PocA.xcodeproj/` — Xcode project for PoC-A (SwiftPM was insufficient because it can't expose Signing & Capabilities for entitlement provisioning).
- `poc-a-aac-capture/PocA/PocA/AssessmentSessionController.swift` — `AEAssessmentSession` wrapper; logs config preconditions and full error-code names.
- `poc-a-aac-capture/PocA/PocA/ScreenCaptureService.swift` — `SCScreenshotManager.captureImage` single-shot.
- `poc-b-test-loop/client/Sources/PocBClient/TestRunner.swift` — sandboxed `WKWebView` with hardening (rightMouseDown swallow, navigation delegate, locked-down responder chain).
- `poc-b-test-loop/client/Sources/PocBClient/AppDelegate.swift` — programmatic main menu, security event log channel.
- `poc-b-test-loop/infra/lib/poc-b-stack.ts` — CDK stack `SecureTestPocB` (API GW + Lambda + 1-week log retention).
- `poc-c-classlink-sso/client/Sources/PocCClient/OIDCClient.swift` — PKCE flow via `ASWebAuthenticationSession`, id_token decode, refresh.
- `poc-c-classlink-sso/client/Sources/PocCClient/CallbackProbe.swift` — empirical proof that SwiftPM client can route custom-scheme callbacks (no Xcode conversion needed).
- `poc-c-classlink-sso/infra/lib/poc-c-stack.ts` — CDK stack `SecureTestPocC` (id_token verify via OIDC-discovery-resolved JWKS).

Built since (Phase 5, slices 51-70 — see `client/README.md`):

- `client/SecureTestCore/` — the student client's logic as a SwiftPM package, so
  it is testable without Xcode or a window server (ADR 0013).
- `client/SecureTest.xcodeproj/` — the AppKit app target. An `.xcodeproj` rather
  than a SwiftPM executable because only a real project exposes Signing &
  Capabilities, which is where the AAC entitlement has to go.
- `design-tool/app/api/test-sessions/`, `.../attempts/`,
  `.../assessments/[id]/delivery/` — the student plane: join codes, attempts,
  response ingest, and the key-stripped delivery bundle.

Still to be created:

- `teacher-monitor/src/sessions/SessionDashboard.tsx` — session create, post-hoc review (MVP).
- `jamf/pppc/secure-test-screen-recording.mobileconfig` — PPPC payload for Screen Recording grant (MVP). Deferred to IT.

## Verification

- **PoC-A pass**: frames are written to disk while `AEAssessmentSession` is active (default restrictive configuration); inspect for content fidelity. Failure → thumbnail grid is dropped. (Entitlement granted 2026-08-26 and the session begins; the capture measurement itself is still outstanding and gated on giving PoC-A an exit path.)
- **PoC-B pass**: launching the PoC, completing 3 items, and observing the JSON response payload in CloudWatch logs at API Gateway. Verify WKWebView blocks `window.open`, drag-out, right-click context menus.
- **PoC-C pass**: a real ClassLink dev-tenant student account completes the OIDC flow; `id_token` is signature-verified server-side; refresh-token flow succeeds at least once across the typical test window length; PKCE is confirmed in the network capture.
- **MVP pass**: a teacher creates a session in the web dashboard, gets a code; a student SSO's via ClassLink on a Jamf-managed Mac, enters the code, sees and answers 5+ items inside an `AEAssessmentSession`; responses appear in the dashboard; attempting `Cmd-Tab` and `Cmd-Q` is blocked; screenshot key produces nothing. Paired requirement: hand-in ends the session cleanly and returns the Mac to the student, without a reboot.
- **Layered-lockdown verification**: manual checklist run by IT — Cmd-Tab, Mission Control, Dock, Spotlight, screenshot keys, screen recording shortcut, AirDrop, AirPlay, Handoff, dictation, Universal Clipboard, lid close, external display. Each behavior recorded and approved before pilot.

## Resolved Decisions (post-plan-approval)

- **6.1 — Build env**: Xcode + James's personal Apple Developer cert for PoC. Distribution will be via Jamf Self-Service (or equivalent) using the existing `psd-sign` workflow. No district Apple Dev Enterprise enrollment needed.
- **6.2 — ClassLink dev tenant**: PSD signs up directly via the free **ClassLink Partner Portal** (`partnerportal.classlink.com`) — self-service, no vendor-approval bottleneck. IT is backstop. Sandbox endpoint `https://sandbox-vn-v2.oneroster.com` available for OneRoster work.
- **6.5 — AWS**: deploy into James's existing **AWS "playground" account** (not a net-new account). CDK/Terraform IaC still required; reuse existing IAM/SSO baseline.

## Findings from PoC work (added 2026-05-19, post-approval)

What changed about the plan as a result of empirical work:

### AAC (PoC-A area)

- The macOS AAC API surface is **narrower than iOS docs imply**. Settable flags live on `AEAssessmentConfiguration`, not on `AEAssessmentParticipantConfiguration`. The participant config on macOS has only three properties: `allowsNetworkAccess`, `required` (26.0+), `configurationInfo` (15.0+). Settable on `AEAssessmentConfiguration` itself (gated by macOS version): `allowsSpellCheck` / `autocorrectMode` / `allowsKeyboardShortcuts` / `allowsPredictiveKeyboard` (15.0+), plus `allowsAccessibilityKeyboard` / `allowsAccessibilityLiveCaptions` / `allowsAccessibilityReader` / `allowsScreenshots` (26.1+). The earlier scaffold's guesses about `allowsAutoCorrect` and `allowsScreenRecording` were wrong; SDK headers are authoritative.
- The accommodations mechanism on macOS is `setConfiguration(_:for:)` taking an `AEAssessmentApplication(bundleIdentifier:teamIdentifier:)` plus a per-app `AEAssessmentParticipantConfiguration`. Apple's own sample uses this for Calculator and Dictionary. We will use it for assistive-tech apps (Read & Write, Co:Writer, etc.). See `docs/accommodations.md`.
- AAC requires the restricted entitlement `com.apple.developer.automatic-assessment-configuration`. Apple authorization is required; the capability does not appear in Xcode's "+ Capability" picker until granted. Without it, `AEAssessmentSession.begin()` fails with `AEAssessmentErrorDomain` error 1 (`AEAssessmentErrorUnknown`). Apple ticket submitted 2026-05-19; **granted, notified 2026-08-26**. With the entitlement in place `begin()` succeeds on macOS 26.6.2, which confirms the error-1 diagnosis. This no longer blocks PoC-A's load-bearing test — the missing exit path does.
- Sandboxed AAC apps additionally need `com.apple.security.temporary-exception.mach-lookup.global-name = com.apple.assessmentagent` (from Apple's own sample). ~~PoC-A is unsandboxed; this matters at MVP when we sandbox.~~ **Corrected 2026-08-26.** PoC-A has had `ENABLE_APP_SANDBOX = YES` since it became an `.xcodeproj` — only the May capture baseline, taken about an hour earlier, was unsandboxed. And its signed entitlements carry no such temporary exception, yet the session began on macOS 26.6.2. One observation, one OS version, a development-signed build — so the guidance is now "try without it, add it only if `begin()` fails," not "add it preemptively." Second-order effect: the existing capture baseline is unsandboxed and the AAC run will be sandboxed, so the baseline has to be re-taken before the comparison means anything. See PoC-A RESULTS finding #9.

- **An AAC session needs an exit path written at the same time as `begin()`.** PoC-A's first successful session (2026-08-26) could not be left: the end control never labelled itself, no main menu meant `Cmd-Q` dispatched to nothing, `applicationShouldTerminateAfterLastWindowClosed` defaulted to `false` so closing the window orphaned the process, and there was no timeout. AAC suppresses app switching, so nothing outside the app could recover it. The run ended with the power button. Applies with more force to the shipping client, where the person trapped would be a student.
- The `@main` attribute on an AppKit AppDelegate does **not** auto-wire the class as the application delegate (storyboard usually does that wiring). Without a storyboard, an explicit `static func main()` is required. Codified in PoC-A.

### ClassLink (PoC-C area)

- ClassLink OIDC endpoints are now empirically discovered: issuer `https://launchpad.classlink.com`, auth `/oauth2/v2/auth`, token `/oauth2/v2/token`, jwks **`/oauth2/v2/jwks`** (the OIDC-default `/.well-known/openid-configuration/jwks` does **not** work; ClassLink reorganized that path), userinfo `https://nodeapi.classlink.com/v2/my/profileinfo` (different host).
- ID tokens are RS256 only.
- ID token claims include `classLink_sourcedId` (the OneRoster bridge), `classLink_role`, `classLink_role_level`, `classLink_tenant_id`, `classLink_org_sourcedids` — meaning we do **not** need a separate userinfo call to bridge SSO identity to roster identity. Reduces an MVP round-trip.
- Useful scopes available: `openid`, `profile`, `email`, `oneroster`, `classes`, `classes.readonly`. We should request `openid profile email oneroster` at minimum.
- **PKCE empirical status**: not advertised in the discovery doc, but the auth endpoint accepts and round-trips `code_challenge` + `code_challenge_method=S256` (verified 2026-05-19). Strong evidence PKCE is functionally supported. The plan's confidential-client-proxy fallback (risk #2) is unlikely to be needed but the code path remains in PoC-C for safety.
- The ClassLink Partner Portal is free and self-service. PSD signup submitted 2026-05-19; application registration awaits portal approval.

### WKWebView host hardening (discovered while characterizing PoC-B)

Three MVP requirements not originally in the plan, identified by sandbox-escape probing and **already implemented as reference code in PoC-B**:

1. **Context menu must be fully suppressed.** Default macOS context menu exposes Search-with-Google, Share, Services submenu (with system services that can reach the network), and text-field Autofill. `willOpenMenu(_:with:)` alone is insufficient because Services and Autofill bypass it. Robust suppression: override `rightMouseDown(with:)` to swallow + override `validRequestor(forSendType:returnType:)` to return nil + `willOpenMenu` empty-and-cancelTracking as defense-in-depth.
2. **`WKNavigationDelegate` must reject non-bundled navigations.** `location.href = "https://..."` is otherwise capable. Allow only the initial `about:blank` from `loadHTMLString`; cancel everything else and log.
3. **Programmatic `NSApplication.mainMenu` required for Cmd-shortcuts.** A programmatic AppKit app without `MainMenu.xib` has no Edit menu; Cmd-V / Cmd-F / Cmd-Q silently no-op. Provide at minimum an Edit menu (Cut/Copy/Paste/Select All) and an Application menu (Quit).

What still isn't covered by current PoC-B hardening (MVP needs to revisit): Cmd-C still functions, drag-IN file drop not blocked, touch-bar shortcuts untested, multi-window behavior undefined.

### Operational

- PoC-A is now an Xcode project (`poc-a-aac-capture/PocA/PocA.xcodeproj/`) — SwiftPM packages opened in Xcode don't expose Signing & Capabilities, which we need for entitlement provisioning.
- PoC-C is **not** converted; an `ASWebAuthenticationSession` callback-routing probe confirmed SwiftPM is architecturally sufficient for the OIDC flow because the auth session captures URLs by scheme internally rather than via system URL routing.
- Both PoC-B and PoC-C deploy CDK stacks (`SecureTestPocB`, `SecureTestPocC`) into James's AWS playground (<account-id>) in us-west-2. Idle cost is essentially zero; teardown commands are in each PoC's `RESULTS.md`.
- Bun + esbuild is the local CDK bundling stack (no Docker required).
- `CDK NodejsFunction` requires either Docker or a local `esbuild`; we use the latter.

## Documents that grew out of this work

- OSPI's *2025–26 Guidelines on Tools, Supports, and Accommodations* (linked from `docs/references/README.md`) — WA OSPI source for accommodations catalog.
- `docs/references/README.md` — pointer to Apple's `BuildAnEducationalAssessmentApp` sample (gitignored locally) plus key extracted findings.
- `docs/accommodations.md` — OSPI-to-macOS implementation strategy mapping (in progress).
- `docs/unblock-checklist.md` — exact steps for the moment each external dep clears.
- `poc-a-aac-capture/RESULTS.md`, `poc-b-test-loop/RESULTS.md`, `poc-c-classlink-sso/RESULTS.md` — per-PoC empirical logs.

## Unresolved Questions

6.3 PSD AI Studio item format reusable as MVP schema, or new?
6.4 Jamf: dedicated test-fleet smart group, or share existing student-Mac scope?
6.6 **Moot 2026-08-27** — codes stay per sitting; pre-assignment surfaces scoped sittings to the student instead (`docs/phase-7-slices.md`). *Original:* Session-code: per-session generated, or pre-issued per class?
6.7 Offline policy: hard fail on network loss, or queue + sync? (MVP says queue — confirm.)
6.8 Accommodations source of truth: IEP system, SIS, manual entry by test admin?
6.9 Anomaly events: which auto-flag vs auto-pause vs auto-end?
6.10 Parent notification language for video / thumbnail capture — who drafts, who approves?
6.11 State assessment scope: OSPI/SBAC interop a phase-4 requirement, or only commercial vendors (Edulastic, NWEA)?
6.12 Spell-check/autocorrect block on macOS: WKWebView attr disable acceptable, or need OS-level (AAC won't give us)?
6.13 Pilot population: which school(s), grade band, subject area for first run?
6.14 Teacher monitor auth: Cognito + email/password, Entra SSO, or ClassLink staff SSO?
6.15 Data residency: any WA state requirement to keep data in us-west-2 specifically?
6.17 **RESOLVED 2026-08-26 — ADR 0017, built in slices 74–81.** Google OIDC direct (no Cognito pool: `/api/auth/exchange` verifies Google's id_token itself, and no blocker needed a pool), role by verified email domain, roster from a nightly warehouse extract (not AI Studio's OneRoster tables — see the ADR for why), students matched by lowercase email and scoped to the sitting owner's sections, accommodations still keyed by SSID. Still open: the data engineer's SSID column + push mechanism; the first live sign-in. The original question, for the record: stay on ClassLink OIDC, or follow AI Studio (Cognito + Google federation, roster joined by lowercase email)? Raised 2026-08-26 — "we might pivot as an org." What AI Studio has (`psd401/aistudio` @ `dev`, 2026-08-23): a nightly OneRoster sync Lambda (`infra/lambdas/oneroster-sync/`, ~4.2k lines incl. tests) mirroring `orgs`/`academicSessions`/`courses`/`classes`/`users`/`enrollments` into `oneroster_*` tables (migration 141); an optional email-joined role pass (156); teacher-composed `rooms` over class sections + explicit emails (157–158); `/admin/rosters` UI; feature doc `docs/features/oneroster-classlink-sync.md`. Its auth modes (OAuth1 direct, or ClassLink OAuth2 Proxy static bearer) both need Partner Portal credentials, so a pivot removes the OIDC `client_id` dependency but not the OneRoster one. Gaps if reused here: `oneroster_users` does not request `identifier`/`userIds`, so there is no SSID column to join TIDE accommodations on — join would be by email or need a field added; our `students` table is per-teacher and keyed by `ssid` + `classlink_sourced_id`, with no email column (`lib/api/resolveStudent.ts`); `roles.ts`'s ClassLink role vocabulary becomes moot. Decide before writing any more sign-in code on either side.
6.16 **RESOLVED 2026-08-27 (PoC-A findings #13–14).** ScreenCaptureKit is not denied, it is redacted — the assessment window comes back as a grey box — so a WebRTC peek fed by screen capture would fail the same way. The mechanism that survives is an in-process render of the client's own view tree (`NSView.cacheDisplay` measured; `WKWebView.takeSnapshot` is the web-content equivalent, unmeasured), pushed over the student plane. Phase 2 peek and any Phase 3 thumbnails are rebased on that; nothing screen-capture-based, no Screen Recording TCC for monitoring. *Original question:* If PoC-A shows ScreenCaptureKit is denied inside a session, does the stated fallback still stand? "Drop thumbnails, fall back to WebRTC peek" (PoC-A section, above) assumes peek survives — but peek captures the screen too, so the same denial should hit it. Either the fallback needs a mechanism that is not ScreenCaptureKit, or peek only works outside an active session, which no document says. Resolve before committing to phase 2's on-demand peek. (Raised 2026-08-26; scope of live monitoring itself is unchanged.)
