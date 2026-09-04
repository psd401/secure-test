# Phase 7 — sittings in the dashboard, pre-assignment from the roster

Plan Phase 2's "session pre-assignment from roster", built on Phase 6's
roster tables and scoped sittings. Decided 2026-08-27 with James: a
pre-assigned test is a section- or student-scoped sitting surfaced to the
signed-in student, who joins it without typing a code; the code stays for
ad-hoc use. That settles phase-6 open question 3.5 ("both — section-scoped is
the default path") and makes plan 6.6 moot (codes stay per sitting; none are
pre-issued per class).

## Slices

| # | Commit | What | Verified |
|---|---|---|---|
| 82 | _see git log_ | **Sittings tab on the assessment page.** `SittingsPanel`: create (all my sections / one section / picked students, duration), the code, close early, and per-sitting **attendance** — who the scope expects vs who has joined or submitted. New: `GET /api/roster/students` (the picker), `GET /api/test-sessions/:id/attendance`, `lib/api/sittingAttendance.ts`. `POST /api/test-sessions` now refuses a draft assessment (`409 not_published`); the panel says so and disables Create. | 8 DB tests (`test/sittings-attendance-api.test.ts`); full suite passes; hand-checked in the browser on James's account 2026-08-27 with the dev roster seeded from the fixture (his email as `teacher.one`): draft → notice + disabled Create; publish → section picker "Algebra 1 · 3(A) (2)"; create → code; attendance lists Fixture, Ada / Sample, Ben as not joined (0 of 2); picked-students list shows both with their sections; close → `closed` |
| 83 | _see git log_ | **Student "my sittings".** `GET /api/me/sittings` — every open, unexpired sitting whose scope admits the signed-in student (`isAdmittedToSitting`, the redeem rule), with assessment name, teacher email, scope, section label, expiry and the student's existing attempt. No separate join-by-id: `POST /api/attempts { test_session_id }` already is one (slice 61 — `loadJoinableSitting` + the same resolution), so the client goes list → start attempt, skipping redeem. Listing never binds an overlay row. | 4 DB tests (`test/my-sittings-api.test.ts`): Ada/Ben/Cy each see exactly their sittings across all/section/explicit/closed/expired/other-teacher; existing attempt attached; `not_on_roster` / `no_email` reasons, staff 403; no overlay row created. Full suite passes. End-to-end against the dev server with a minted student JWT for the seeded Ada: list → `POST /api/attempts` 201 → list shows `in_progress`; the Sittings tab's attendance shows her as In progress |
| 85 | _see git log_ | **Progress in the attendance payload.** Per row `answered` (saved responses for the attempt), `total_items` (the assessment's items), `last_activity_at` (latest of started, any response save, submitted); top-level `updated_at` (newest activity — a poller's change cursor) and `total_items`. `lib/api/sittingAttendance.ts`. | DB test: three items, Ada 2/3 with her last save as the activity and the cursor, Ben 0/3 with null; full suite 866 pass |
| 86 | _see git log_ | **Live view in the Sittings tab.** Progress column (bar + n/N), Last activity ("3 min ago"), an **idle** pill on an in-progress student with no activity for 10 min (`IDLE_AFTER_MS`), and polling every 5 s (`LIVE_INTERVAL_MS`) while the sitting is open and its attendance is expanded — paused while the tab is hidden, stopped once closed/expired; "Live · every 5s · updated Ns ago" next to the counts. Transport decision: polling now, SSE later, no WebSocket (the app is not deployed yet; ADR 0014's Fargate stack is unbuilt). | Hand-checked on the seed assessment: Ada 0/5 idle 10 min, Ben 1/5 3 min ago after one short-text save; the indicator ticks; one `GET …/attendance` per 5 s in the server log |
| 87 | _see git log_ | **Monitor page** `/dashboard/[id]/monitor/[sittingId]` (`MonitorView`): the code at projector size, open/closed/expired, counts, Close sitting, and one card per student — status, idle pill, progress bar + n/N, last activity or submitted time; green border once submitted, amber when idle. Same endpoint and 5 s visibility-aware polling as the tab; owner-only (404 for another teacher's or another assessment's sitting; signed-out → login with `next`). "Monitor" link on each open row in the Sittings tab. Shared helpers moved to `app/dashboard/[id]/attendanceView.ts`. | Hand-checked on the seed sitting: Ada Submitted 5/5 (green), Ben In progress 1/5 idle 13 min (amber), Live indicator; not-owner staff JWT → 404; signed-out → 307 to `/login?next=…`; full suite passes |
| 84 | `474a808` (merged `b53e455`) | **Client: "Your tests".** Signed-in entry screen lists the student's sittings with Join; code field stays. Built in the client worktree session against the contract below. | `swift test` (MySittings + SessionTokenClaims); hand-checked: list, row content, Resume. **Remaining manual rows** (need states the dev seed lacked, noted by the client session 2026-08-27): Join with no attempt, Done after submit, Refresh after the teacher closes, the account-reason empty state, staff-account 403, the code-field regression check — the first three unblocked by the seed in "Decided along the way" |
| 91 | _see git log_ | **Client events → teacher monitor.** `POST /api/attempts/:attemptId/events` (student session, `loadOwnAttempt`; `submitted` still accepted; server-stamped `at`; strict kind enum → 400), `attempt_events` table + migration 0021 (kind check constraint, cascade on attempt), `attendanceForSitting` rows gain `last_event` + `alert` (`activeAlert`: sticky kinds forever, `focus_loss` cleared by later `focus_regained`; event times never feed `last_activity_at`). Red alert pill in the Sittings tab's Status column and on monitor cards (red border while mid-test; submitted stays green), "Last event" line on cards. Contract below for the client. | 8 DB tests (`test/attempt-events-api.test.ts`): 201 + server stamp + detail round-trip, 400 unknown kind stores nothing, 404 other student, 403 staff, 201 on submitted, focus_loss→regained clears the alert, emergency_exit survives a regain, no-events row null. Role sweep classifies the route as student-plane. Full suite 878 pass; typecheck clean. UI not yet hand-checked (no client sends events yet — dev-seed rows or the client's AAC-2 wiring will exercise it) |
| 92 | _see git log_ | **Client: event wiring.** `APIClient.postEvent`; `AttemptEventReporter` (fire-and-forget — a failed post is logged as `[security] event <kind> not delivered` and dropped, never awaited, never blocking an exit path); `AssessmentLockdown` gains observation-only `onSessionEvent` + `onWatchdogExpired`. App target: lifecycle → `lockdown_*` events; watchdog expiry and the End-secure-session button → `emergency_exit` (`via: watchdog`/`button`, decision 3.1); quit mid-attempt → `quit` whether or not lockdown is still up (best-effort during teardown, closes both AAC-1 TODOs); `didResignActive`/`didBecomeActive` → `focus_loss`/`focus_regained` for the whole server attempt (decision 3.2), stopping at hand-in; the offline `--bundle` path stays silent. | `swift test` 215 pass (was 204): postEvent request shape/auth/refusal, reporter drops+logs failures, SessionEvent→wire mapping, wire names match the server contract, lockdown passthrough order, watchdog-callback-before-forced-end, deliberate end fires nothing; app target builds. End-to-end rows added to `client/MANUAL-CHECKS.md` ("Event reporting", 7 rows); **hand-run 2026-08-27 evening** — 6 of 7 ✅ with per-row evidence (dead-server row open), all nine AAC-1 lockdown rows ✅ in the same runs; findings + deferred items in "Hand-run findings" below |
| 93 | _see git log_ | **AAC-2a — the real lockdown session.** `SecureTest.entitlements` (AAC key only; sandbox keys stay synthesized from `ENABLE_*` build settings and merge at signing) + `CODE_SIGN_ENTITLEMENTS`/`DEVELOPMENT_TEAM` set by hand-editing the pbxproj — NOT Xcode's capability UI, whose 2026-08-27 auto-write dropped the package refs. **The client borrowed PoC-A's App ID** (`PRODUCT_BUNDLE_IDENTIFIER = net.psd401.securetest.PocA`, loud comment in the pbxproj) because James's portal role could not create the client's App ID or enable the restricted capability — **RESOLVED 2026-09-03:** an admin created `net.psd401.securetest.client` with AAC enabled, the identifier was flipped in both configurations, and the signed entitlements were re-verified (AAC key + all three sandbox keys). No mach-lookup exception (checklist B: try without first). `RealLockdownSession` in the app target — the only file touching `AutomaticAssessmentConfiguration`: 4 delegate callbacks → `SessionEvent` (AEErrors decoder ring in failure text), restrictive default config (accommodations mapping = AAC-2b). Selection per begin(): `SECURE_TEST_SIMULATE_LOCKDOWN` override → simulated; entitled binary (`SecTaskCopyValueForEntitlement`) → REAL, the Mac locks; else simulated cooperative. Choice logged. | Build succeeds with `-allowProvisioningUpdates`; `codesign -d --entitlements -` shows the AAC key AND all four sandbox keys on the built app; `swift test` 215 pass (Core untouched). **Real-session hand-run DONE 2026-08-27 night** — five real sessions on James's Mac: lock + button + watchdog + Cmd-Q + locked hand-in all released the Mac; Cmd-Tab/Mission Control/Dock/Spotlight suppressed; Cmd-Shift-3/4/5 beeped; Spotlight opens invisibly in the background (finding #15's visibility-gating, not an escape); **dictation ACTIVE — a macOS platform gap (`allowsDictation` is iOS-only), mitigation = Jamf profile, see Hand-run findings**; entitled-override sighting still open. Per-row evidence in MANUAL-CHECKS |
| 94 | _see git log_ | **AAC-2b — accommodations → session config.** `LockdownConfigurationPlan` in SecureTestCore is the tested half of the mapping: presence in `DeliveryBundle.accommodations` (the server already resolved the effective set; the value string never flips a knob) opens exactly three knobs — `spell_check`→`allowsSpellCheck`, `word_completion`→`allowsPredictiveKeyboard`, `closed_captioning`→`allowsAccessibilityLiveCaptions` (all ≤ macOS 26.1; deployment target 26.5, no availability gating). Everything else stays at the restrictive default on purpose: `autocorrectMode` none (no catalog id means autocorrect — OSPI spell check is squiggles, not silent correction), `allowsScreenshots` false (finding #13), `allowsKeyboardShortcuts` (= Text Replacement) false, `permissive_mode`/secondary apps deferred to its own slice (AT-app bundle inventory), `speech_to_text` = the Jamf dictation gap, `tts_*` = strategy A in-app. `RealLockdownSession(plan:)` applies the plan property-for-property — still the only AAC-touching file; AppDelegate stashes the plan from each loaded bundle before its begin, and `makeSession` logs `lockdown config plan: spellCheck=… predictiveKeyboard=… liveCaptions=…` for real AND simulated backings (decision 2026-08-28: rehearsals audit the same line). | `swift test` 223 pass (8 new in `LockdownConfigurationPlanTests`: restrictive empty map, each knob opens alone, presence-not-value, unmapped ids — incl. `speech_to_text`/`permissive_mode`/`tts_*` — stay restrictive, all three together, log line names every knob); app target builds. **Hand-run 2026-08-28 (two real sessions as Ben): the wiring verified — plan line all true, matched the bundle, real session began — but the observable-effect rows are blocked outside the slice**: spell-check squiggles absent locked AND unlocked (app-layer: the WKWebView never has continuous spell checking on — research spike 3.1), predictive text can never render (`allowsInlinePredictions` unset, defaults false — fix 3.2), Live Captions unobserved even outside the app (OS baseline unverified). Per-row evidence + the seeded essay probe item in `client/MANUAL-CHECKS.md` "Accommodations → session config (AAC-2b)" |

## Roster go-live — the data engineer's reply (slices 88–90)

The data engineer's reply (internal — see the ops repository) answered the request; these slices close our side before the first push.

| # | Commit | What | Verified |
|---|---|---|---|
| 88 | _see git log_ | **Contract reconciliation.** `manifest.files` accepts the DAG's **list** form as well as the map (`foldFilesList` in `lib/roster/extract.ts`; the file name identifies the table). `docs/roster-extract.md`: `ps_id` is the PowerSchool student number (what the DAG sends; an opaque, stable join key on our side), and a blank `teacher_email` after a separation imports as null with the stated consequence for "my sections". | `test/roster-extract-shapes.test.ts`: map validates, list validates identically, list refused on a foreign name / duplicate / missing table; blank `teacher_email` → null. Full suite 870 pass |
| 89 | — | **Scale check** at the counts the data engineer quoted (8,930 students / 4,387 sections / 4,528 teacher rows / 84,817 enrollments): synthetic extract through the real validator and importer against local Postgres. | validate 114 ms (heap 58 MB); first import 3.1 s; re-import (all upserts) 2.9 s. Lambda budget is 10 min / 1 GB — two orders of magnitude of headroom even if Aurora is 10× slower |
| 90 | _see git log_ | **Bucket policy for the cross-account producer.** CDK: `objectOwnership: BUCKET_OWNER_ENFORCED` stated explicitly; `WarehouseProducerPut` bucket-policy statement granting `s3:PutObject` on `roster/*` to the producer role ARNs (dev = the MWAA execution role, per-env at the time; now via context — see `design-tool/infra/cdk.context.json.example`). The importer Lambda was rebundled in the same deploy, so it carries slice 88's list-manifest support. | **Deployed to dev 2026-08-27 16:18 PT** (`cdk deploy --context env=dev`); verified with `get-bucket-ownership-controls` (BucketOwnerEnforced) and `get-bucket-policy` (the statement, that principal, `s3:PutObject`). Reply drafted (internal — see the ops repository) |

## Hand-run findings (2026-08-28 evening) — the peek/File→Open round

One binary (the post-PR-#4 merge build), James at the keyboard and browser
on a single Mac, this session driving launches/server/DB. Peek P4: all 7
rows ✅ including the load-bearing one — the request→render→deliver cycle
ran strictly inside a real locked session (stderr: `DID BEGIN` → peek
lines → `DID END`) with full content in the collected frame. File→Open:
10 of 12 rows ✅ (the race row unprovokable as documented; `--bundle`
regression not re-run). Follow-ups, ALL pending James's approval:

- **8.1 Dismissable sticky notice** — **BUILT 2026-08-28** (`fcdcea1`, × control `0c99de0`; hand-run rows in MANUAL-CHECKS). *Finding:* the "viewed at H:MM" banner
  should be dismissable by the student, not pinned for the attempt.
- **8.2 Resumed attempts and the monitor don't line up** — **DECIDED + BUILT 2026-08-28: rebind on join** (`cc8fa8f`; `bun test` 896 pass; no migration — the attempt keeps no history of its original sitting). *Finding:* an attempt keeps
  its ORIGINAL `test_session_id`, so a student who rejoins through a NEW
  sitting shows "not joined" on that sitting's monitor and can only be
  peeked from the old (possibly expired) sitting's page — hit live this
  round (Ben on ACC2BG vs 82X6S4). Decision needed: rebind the attempt on
  join, or teach attendance to show cross-sitting resumed attempts.
- **8.3 Real-framework measurement + a held exit path** — **BUILT 2026-08-28** (`3626f8b`, Core defers the physical `end()` until `didBegin`; `SECURE_TEST_SIMULATE_LOCKDOWN=slow` `d3dac27` reproduces the drop on any Mac). **PROVEN IN A REAL SESSION 2026-08-28** (hand-run, `client/MANUAL-CHECKS.md` "2026-08-28 workflow round" 8.3): Cmd-Q inside the STARTING window → deferred → `DID BEGIN` → physical `end()` from inside the delegate callback → real `DID END`, exit 0, no backstop; the framework does NOT drop the re-entrant `end()` (9.3 closed). *Finding:* an `end()` issued
  between `begin()` and `didBegin` is DROPPED by the real
  `AEAssessmentSession` — `didEnd` never came, teardown's 5 s grace
  expired, and the non-negotiable backstop exited the process (code 70),
  which released the Mac. The exit path held under a failure shape the
  simulation never produced. Proposed fix: when the exit is requested from
  `starting`, the Core machine defers the physical `end()` until
  `didBegin` arrives.
- **8.4 word_completion is STILL gated somewhere**: no inline prediction
  inside a real session with the AAC knob open AND
  `allowsInlinePredictions = true`. Next candidates: the
  `writingsuggestions` HTML attribute, field-level heuristics, the OS
  prediction model state. Investigation spike.
- **8.5 Offline path's stuck status labels** — **BUILT 2026-08-28** (`2a319b8` labels + standing notice `d077cb6`); **hand-run ✅ 2026-08-29** (all three rows; row 3 exposed 10.10, fixed the same night). *Finding:* "saving…" /
  "handing in…" never resolve on the deliberately-ignored offline saves
  and persist across a later open sheet; the page should say the offline
  truth instead.

## Workflow round (2026-08-28 night) — five branches, reviewed, merged

Built by a Workflow of six worktree-isolated agents (one per slice, `claude/*`
branch each) followed by six independent read-only reviewers, all `approve`,
merged `--no-ff` in this order, then three follow-ups James chose on review.
Every row is `swift test` / `bun test` verified; every client row still
needs its hand-run (rows in `client/MANUAL-CHECKS.md` "2026-08-28 workflow
round").

| Merge | What | Verified |
|---|---|---|
| `2e1a40f` (`bddb241`) | **Roster importer Lambda inside the VPC** — see the Queued entry above | `tsc`, `cdk synth`, `cdk diff` additions-only; deployed; first real import on Aurora succeeded |
| `adcbbff` (`cc8fa8f`) | **8.2 rebind on join.** `POST /api/attempts` with an existing IN-PROGRESS attempt on the same assessment but another sitting, where the new sitting admits the student: `test_session_id` moves to the new sitting; submitted attempts never move; scope still refuses | `bun test` 896 pass (5 new; 3 fail on the old code); typecheck clean |
| `88cfdd7` (`3626f8b`) | **8.3 deferred `end()`.** `AssessmentLockdown.end()` in `.starting` sets a flag and logs; `didBegin` issues exactly one physical `end()`; `failedToBegin` resolves the pending exit without one; watchdog / grace backstop / exit(70) untouched | `swift test` 251 (8 new, incl. the two backstop-still-fires cases; 17/17 new cases fail on old code); app builds |
| `11f4064` (`fcdcea1`) | **8.1 dismissable notice.** Core `PeekNotice` (show / dismiss / re-show on the next peek); AppKit strip with a dismiss control | `swift test` 248 (5 new); app builds |
| `1f7d72c` (`2a319b8`) | **8.5 offline labels.** Page gets `OFFLINE` up front; drawing save → "Offline mode: not saved to a server.", finish → "Finished. Offline mode: nothing was sent to a server."; server path byte-identical | `swift test` 250 (7 new via the JavaScriptCore harness); app builds |
| `0c99de0` | 8.1 follow-up: the control is an **×**, not the word | app builds |
| `d077cb6` | 8.5 follow-up: **standing "Offline mode: answers are not saved to a server." notice** under the heading (MC / short-text / essay have no label of their own) | `swift test` 268 (2 new) |
| `d3dac27` | 8.3 follow-up: **`SECURE_TEST_SIMULATE_LOCKDOWN=slow`** — `didBegin` 2 s late, an `end()` before it DROPPED like the real framework; the machine's deferral is proven end to end on the simulation | `swift test` 268 (3 new) |

Merged main: `swift test` 268 pass, app target builds, `bun test` 896 pass.
`claude/short-text-spellcheck` came back empty (3.3 was already on main) and
was deleted.

### Follow-ups from the round — decided 2026-08-28 (9.1/9.2 approved and built, 9.4 trimmed, 9.5 accepted)

- **9.1 First importer invocation times out while the 0-ACU cluster resumes** — **BUILT `8c267f7`** (`waitForDatabase` probes up to 6 × 10 s, logs `roster_sync_db_wait` per miss; 3 tests). **DEPLOYED 2026-08-28 19:40 PT** (with 9.4; diff = Lambda code + endpoint SubnetIds only). Cold-cluster proof: manifest re-put with the cluster at 0 ACU → ONE invocation, 44 s, `succeeded` with full counts, no ERROR (the connect held through the resume this time, so no `roster_sync_db_wait` line was needed — the probe is the backstop for the morning it doesn't). *Original:*
  Observed on the first real run: `ETIMEDOUT` at ~17 s, then S3's async
  retry 80 s later succeeded. Every 06:00 push will log one ERROR before the
  success unless the importer waits out the resume. Options: retry the
  connection inside the handler (one place, `lib/roster/syncHandler.ts`), or
  a longer `connect_timeout` on the postgres client, or `minCapacity` > 0
  (steady cost). Recommend the in-handler retry.
- **9.2 `PeekResponderTests.testPollFailureLogsOnTransitionOnlyAndRecovers`
  is flaky** — **FIXED `63d9f6b`** (test-only race: the Probe's arrays behind one lock, `drain` waits on `pollInFlight`; 10 × 7 pass, no crash). *Original:* — crashed once in five full runs (`Index out of range`,
  process-killing). A real test bug in the P2 poll tests, not in the code
  under test as far as observed.
- **9.3 8.3's remaining proof is a real session** — **CLOSED 2026-08-28, no change needed**: the real-session hand-run delivered `DID END` from the deferred `end()` issued inside `didBegin` (exit 0, no backstop); the synchronous shape stands. *Original:* the deferred `end()` is
  issued synchronously inside the `didBegin` delegate callback. If the
  framework drops a re-entrant `end()` too, hop to the next main-queue turn
  before calling it (tests 1 and 3 in the 8.3 suite lock in the synchronous
  shape and would change).
- **9.4 Secrets Manager endpoint spans both AZs** — **TRIMMED to one AZ in `8c267f7`** (James: ~$7/mo back; rides on 9.1's deploy). *Original:* (CDK default, ~$15/mo vs
  ~$7 single-AZ). The Aurora writer is single-AZ, so the second ENI buys no
  resilience the stack has elsewhere; James's call whether to trim.
- **9.5 8.2 audit gap** — **ACCEPTED for MVP (James, 2026-08-28)**; revisit when results/reporting lands. *Original:* an attempt no longer records the sitting it
  started in. Acceptable for MVP (decided with the rebind); a
  `attempt_sitting_history` table is the fix if it ever matters.

## Hand-run findings (2026-08-29) — the student-account round

Setup and evidence: `client/MANUAL-CHECKS.md` "2026-08-29 student-account run" and the 8.2 table. Three PowerSchool demo students seeded into the LOCAL dev roster only (not in the data engineer's extract); real Google sign-ins; sittings `NBVC8P` → `NP2HTQ` → `DBXQVU`. All proposals below are proposals — nothing built.

- **10.1 A submitted attempt joined through a new sitting renders, locks, and swallows answers (client)** — **BUILT 2026-08-29** (`JoinOutcome` in Core decides `.open` / `.alreadyHandedIn` from the join's `attempt.status`; both entry paths — list row and code — stay on the entry screen with "You already handed this test in.", re-read the list, no render, no `beginLockdown`, no reporter; `ResponseSpool.FlushResult.dropped` counts permanent refusals and the host logs `responses DROPPED: n …`; `swift test` 273 pass, 4 new). **Hand-run ✅ same night** (code path, `join declined` in stderr, no lockdown; the 10.2 row read "Done ✓"). *Original:* Server side is right: `POST /api/attempts` returns the submitted attempt unmoved and every save is refused 409. The client never reads `attempt.status` (`StartedAttempt` decodes it, `APIClient.swift:93`; `SessionEntryViewController.joinListedSitting` calls `onJoined` regardless), so it rendered the test, began a REAL `AEAssessmentSession`, spooled three answers, got 409 on each flush with no log line and no message, and posted `lockdown_begin`/`lockdown_end`/`emergency_exit` events onto a submitted attempt. *Proposal:* on join, `status == "submitted"` → show the handed-in state, no render, no lockdown (both the list path and the code path); log flush refusals. Client change, `swift test`-able.
- **10.2 "Your tests" resolves Done per sitting, not per assessment** — **BUILT 2026-08-29** (`lib/api/mySittings.ts`: attempt keyed by (sitting owner's overlay row, assessment) exactly as `POST /api/attempts`; a submitted attempt shows on every listed sitting of that assessment, an in-progress one only where it is bound — the 8.2 test still holds; new DB test; `bun test` 900 pass). *Original:* `lib/api/mySittings.ts:74` looks up the attempt by `test_session_id` among the listed sittings, so a test handed in through a now-closed sitting shows **Join** on the new one. *Proposal:* look up by (student, assessment) — the same key `POST /api/attempts` uses — and carry the status; 10.1's client guard is the backstop.
- **10.3 No route back to "Your tests" after an emergency end or a hand-in.** `showEntry()` runs once at launch (`AppDelegate.swift:113`); "End secure session" ends the session, not the attempt (AAC-1 decision 2.3), and the hand-in page says "You can close the app". On a shared Mac the student has to quit. *Proposal:* a "Back to your tests" control once the session is down (emergency end or handed in). James noticed it live.
- **10.4 Cmd-Q mid-attempt `quit` event was lost.** After an emergency end, Cmd-Q posted no `quit` (events for `d90e2ac3…`: `emergency_exit`, focus pairs, lockdown pairs; no POST after the last focus event). `applicationShouldTerminate` posts it best-effort by design ("a delayed exit would be worse than a lost event"). *Decision:* accept as designed, or give the post a short bounded wait when no lockdown is active (the hang risk was the lockdown teardown, not the POST).
- **10.5 Show the sitting code on each "Your tests" row** (James, 2026-08-29) — **BUILT 2026-08-29** with 10.2: `code` on the wire (contract below), the client's row detail leads with it (`NBVC8P · Algebra 1 · 3(A) — teacher`), optional on decode so an older server still lists; `swift test` 269 pass. *Original:* The row carries the section label / scope wording + teacher + closes-at; the code the teacher reads out is what students will match against. Not client-only: the `/api/me/sittings` row does not carry `code` today (`lib/api/mySittings.ts`, `MySittings.swift`), so it is one server field + one client label.
- **10.6 Copy: an out-of-scope join-by-code reads as "not open right now".** The server answers `404 session_unavailable` for both a nonexistent code and an open sitting the student is not in — deliberate non-disclosure — but the client copy points the student at "check it with your teacher" as if the sitting were closed. *Proposal:* "That code is not open for you right now" or similar; keep the 404.
- **10.7 A real AAC session on the dev Mac breaks DNS for the dev server on the same Mac.** Aurora run: from `begin()` to `DID END`, every query from the local Next server failed `getaddrinfo ENOTFOUND <cluster host>` (500 on saves, events, peek polls); localhost traffic was fine; resolution returned the moment the session ended. The client behaved correctly throughout (spool kept the answers, submit refused, hand-in succeeded after the session). Never seen on the local DB because it needs no DNS. Production is unaffected (the server is not on the student's Mac) — but any dev run against Aurora must expect it, and anything else that must resolve names alongside a locked client (a local proxy, a tunnel) will not. *Record in the AAC notes; no code.*
- **10.8 Attempt events are best-effort with no retry, so an outage loses them.** `lockdown_begin` for the Aurora attempt died with the 500 and never arrived; the monitor's history for that attempt starts at the emergency exit. Responses survive the same outage because the spool retries. *Decision:* accept (events are telemetry, not answers), or give `AttemptEventReporter` a small retry/queue for the lifecycle kinds only.
- **10.9 No real enrollment is current before 2026-09-02.** The extract carries next year's schedule: all 86,545 active enrollments start 09-02 (teachers' section assignments too). `enrollmentIsCurrent` is right to refuse them, so until the first day of school NO real student can be listed or admitted — the Aurora run needed a one-day backdate. Also: `current_date` is evaluated on Aurora in UTC, so the "current" boundary flips at 5 PM PT the evening before. *Record; consider making the year boundary visible on the teacher's section list ("starts Sep 2").*
- **10.10 Drawing answers are lost on the S3 (presigned) upload path** — **BUILT 2026-08-29** (`StorageProvider.head?` on the interface; S3 `HeadObject` with 404 → null, local-fs `stat`; `settlePendingUpload` in `lib/api/responseUploads.ts` marks a pending slot complete when the provider reports the object, called by the responses PUT before the status check; proxied path untouched; 3 new tests, `bun test` 903 pass). The spool's 409 rule is unchanged — with the server fix the code no longer occurs. **Hand-run ✅ same night** (sitting `5CXRZP`: the settle HEAD 500'd under 10.7 while locked and the spool kept the answer; after the session, PUT 200 → slot complete → response stored → submitted). *Original:* `markUploadComplete` is called only by the proxied `…/upload` route (`app/api/attempts/[attemptId]/responses/[itemId]/upload/route.ts:74`, the local-fs path). On the presigned path the client PUTs straight to S3 and nothing ever flips the slot from `pending`, so the response PUT is refused `409 upload_incomplete` (`responses/[itemId]/route.ts:89`); the spool treats 409 as permanent and drops the response; the page still says "Saved." (the client's own `handleDrawing` comment promises the opposite). Seen 2026-08-29 on the 8.5 row-3 run with `STORAGE_PROVIDER=s3`: object in S3, slot `pending`, attempt submitted with 0 responses. The 2026-08-28 drawing rows passed on local-fs, which never takes this path. *Proposal (server-only):* on a `drawing_upload` response whose slot is `pending`, ask the provider whether the object exists with the declared size (`StorageProvider.head`/`stat`, new on the interface; S3 `HeadObject`) and mark it complete before the status check — the client needs no change and the proxied path is untouched. Test: the presigned branch of `test/response-uploads-api.test.ts` with a stubbed provider. *Also:* the spool's "permanent" rule should not swallow `409 upload_incomplete` — with the server fix it stops occurring, but a retry-once on that code is cheap insurance.
- Also noted for **UX pass 1**: the client's "Your tests" row detail, now leading with the sitting code (10.5), truncates the teacher and loses "closes <time>" in 250 px — give the row a second line or more width; the dashboard header shows the Google `sub` instead of the staff email ("Signed in as 1055…786 · staff"); the seed assessment is named "5 items" but delivers 6.

## Queued (2026-08-27 evening) — not started, to keep the two terminals from tripping over each other

- ~~**AAC-2b follow-ups**~~ **ALL LANDED 2026-08-28** — 3.1 `WebContinuousSpellCheckingEnabled` (AppDelegate), 3.2 `allowsInlinePredictions = true` (AssessmentViewController), 3.3 short_text honours `spell_check` (`0c6ef5c`, with hand-run evidence). The word_completion gate hunt continues as 8.4. *Original:* (3.1) research spike + fix — enable continuous
  spell checking on the client's WKWebView (no public config property;
  candidates: the `WebContinuousSpellCheckingEnabled` default, the
  responder-chain toggle) so the essay's `spellcheck=true` can squiggle at
  all; (3.2) set `allowsInlinePredictions = true` on the web-view config
  (defaults false — inline predictions currently impossible; the AAC knob
  still enforces per-student inside a session); (3.3) design call: should
  short_text honour the `spell_check` grant like essay does, instead of
  hardcoding `spellcheck=false`? Then re-run the blocked MANUAL-CHECKS rows,
  plus Ada's all-false plan-line control and the Live Captions row once the
  OS baseline (captions working outside the app) is confirmed.

- ~~**Student-account sign-in run**~~ **DONE 2026-08-29** — all sign-in rows ✅ with two demo accounts, ADR 0017 #2 answered YES (Internal admits `edtools.psd401.net`), the 8.2 rows run the same night (2 of 3 ✅; "Submitted stays put" fails on the client — finding 10.1). Evidence: `client/MANUAL-CHECKS.md` "2026-08-29 student-account run". *Original:* (client MANUAL-CHECKS rows: `@edtools.psd401.net` sign-in, the ADR 0017 "Depends on" #2 outcome, relaunch persistence, then list + join). Prerequisites: only one SecureTest instance running (the two worktree builds share one Keychain entry); the test account's email added to the dev roster (e.g. into section 5001) so the "Your tests" list and a join can be exercised; a second student account for the A→B ephemeral row, else that row stays open. Run when the client terminal is idle.

- ~~**UX pass 1 — Phase 2 close-out, before the pilot**~~ **BUILT 2026-08-30 — ten slices, one commit each (`e75f010` … slice 10), on `main`.** Research + audit workflow → `docs/ux-pass-1-proposal.md` (decisions, 72 findings, per-slice log); the durable record is `docs/ux-pass-1.md` (tokens, glossary, states, pass-2 list); James's hand-run rows are `docs/design-tool-manual-checks.md` (20 rows, none run yet — rows 10 and 13 need the real client). Verified defect on the way in: the nested `@media { @theme }` had shipped ONLY the dark grayscale tokens, so no light theme had ever rendered. *Original:* (added 2026-08-28,
  James). Nothing in `plan.md` / `design-tool-plan.md` schedules a design
  pass; this is the first. Runs AFTER the remaining hand-run rows (8.5, 8.2, — all DONE 2026-08-29 —
  student-account sign-in) and BEFORE any pilot teacher signs in. Scope is
  the day-one teacher loop only: sign-in → dashboard → authoring + item
  editing → accommodations → sittings → monitor + peek. Structural work,
  not polish: navigation / information architecture, consistent shadcn +
  Tailwind components, empty / error / loading states, terminology a
  teacher recognises. Exit criterion: a teacher completes authoring →
  sitting → monitor without a walkthrough. Out of scope: results / release
  screens (Phase 3, unbuilt) and visual polish — those wait for **UX pass
  2**, after the pilot's first sittings, designed together with Phase 3.
  Method constraint: no headless browser here (ADR 0013), so screens are
  reviewed through James's Chrome or as a written component audit. Seed
  the scope with James's own authoring pain points — none specific yet
  (2026-08-28); the motivation is **a friendlier look**, so visual tone
  (colour, type, spacing, warmth — PSD brand palette) IS in pass 1's scope
  alongside the structural work; only per-screen polish waits for pass 2.
- ~~**Slice 91 — client events → teacher monitor.**~~ Built 2026-08-27; slice 92 wired the client; the combined hand-run is DONE (2026-08-27 evening, see the MANUAL-CHECKS evidence and "Hand-run findings" below).
- ~~**the data engineer's first snapshot**~~ **LANDED + IMPORTED 2026-08-28.** The DAG pushes daily: `roster/20260828T001140Z` (manual, 17:11 PT) and `roster/20260828T130051Z` (the 06:00 PT run); list-form manifest, `ssid` filled on 8,955/8,974 students. Local run against the TEST DB: succeeded, 8,974 / 4,454 / 4,615 / 85,205 upserted, 0 deactivated (run `0bca0591…`). The Lambda had failed on both pushes with `connect ETIMEDOUT` — it sat outside the VPC and the cluster SG has no CIDR ingress between migrations — fixed on the AI Studio pattern (`2e1a40f`: Lambda in new PRIVATE_ISOLATED subnets, S3 gateway + Secrets Manager interface endpoint, SG→SG 5432 rule; no NAT, cluster untouched), deployed to dev 19:12 PT (diff: additions + in-place Lambda update, no replacements). Re-put manifest → first invocation `ETIMEDOUT 10.0.1.101` while the 0-ACU cluster resumed, S3's retry 80 s later **succeeded on Aurora** with the same counts (`roster_sync_runs` row). See 9.1.
- ~~**IT: App ID for the client**~~ **DONE 2026-09-03** (raised 2026-08-27, AAC-2a). An admin created `net.psd401.securetest.client` with the restricted AAC capability enabled; `PRODUCT_BUNDLE_IDENTIFIER` flipped in both configurations and the build re-verified — profile `Mac Team Provisioning Profile: net.psd401.securetest.client`, signed entitlements show the AAC key plus all three sandbox keys, `application-identifier` = `<TEAM_ID>.net.psd401.securetest.client`. Both sandbox-container spools (old and new) held 0 pending rows, so the container switch orphaned nothing. Still open: the real-session hand-run (does the Mac lock), and the TCC rows reset with the new code identity — nothing to re-request, since monitoring uses `cacheDisplay` and not ScreenCaptureKit.
- ~~**Client lockdown rows**~~ DONE 2026-08-27 evening — all nine AAC-1 rows ✅ (the hangs row passed: the app exits, not hangs), plus six of seven slice-92 event rows, run against sitting 82X6S4 with Ben's minted JWT. Evidence per row in `client/MANUAL-CHECKS.md`. Only the kill-the-dev-server event row stays open (the server hosted the monitor being watched).
- **Xcode note:** on 2026-08-27 Xcode wrote `CODE_SIGN_ENTITLEMENTS` + a `SecureTest.entitlements` holding only the AAC key into this checkout and dropped the `SecureTestCore` package-reference sections from the pbxproj; reverted, not committed. Adding the AAC capability to the shipping client is a deliberate step (`docs/unblock-checklist.md` "Then wire the real client"), to be done on purpose with the sandbox keys intact.

## Hand-run findings (2026-08-27 evening) — decided with James

Eight runs, James at the keyboard, this session driving launches and
verifying stderr + `attempt_events` after each. Everything core passed;
these are the follow-ups.

- ~~**Queued, pre-MVP: alert pills overflow the monitor card margins.**~~
  FIXED 2026-08-27 (wrapping flex on the monitor card's status row and the
  Sittings-tab Status cell; pills stay intact and drop to the next line).
  CSS-only — **visual check pending**: eyeball both surfaces with a long
  pill (e.g. "Left the test window · N min ago") the next time the
  monitor/Sittings UI is hand-checked.
- **Deferred: quit-after-unlock events are lost** (7.1, accepted). A quit
  while the app is unlocked takes `.terminateNow` and the process dies
  before the fire-and-forget post leaves — observed 3 of 3 times; a quit
  while locked is delivered by the teardown grace window every time.
  Within the documented best-effort contract. Potential improvement if it
  ever matters: a bounded (~1 s) pre-exit head start for the post.
- **Deferred, design: a second pill for the current state** (7.2, James's
  proposal). Sticky alerts are honest history, but a student who quit and
  REJOINED shows only the old red pill while actively working. Idea: keep
  the sticky alert pill and add a second, calmer pill for the current
  state ("back in session") when a `lockdown_begin` postdates the alert.
  Not designed yet.
- **Deferred: File → Open for the offline bundle.** The sandbox broke the
  repo-relative `--bundle` argv path (documented with workaround in
  MANUAL-CHECKS); a real open-panel path would use the
  `files.user-selected` entitlement the app already has.
- **Dictation is a PLATFORM GAP, not an AAC-2b input** (reclassified after
  a pin attempt failed to compile, 2026-08-27 night): dictation was ACTIVE
  inside a real session on macOS 26.6.2, and `allowsDictation` is
  `API_UNAVAILABLE(macos)` in the framework headers — iOS has the flag,
  macOS does not. Nothing the client configures can close it. Mitigation:
  **Jamf configuration profile disabling dictation on the test fleet**,
  per-student exceptions where speech-to-text is an entitled accommodation
  — item 3 of the batched IT request (internal — see the ops repository;
  revised 2026-09-04; Remote Login is closed). AAC-2b's accommodations mapping covers the flags that
  DO exist on macOS (autocorrect/spell-check/predictive/keyboard-shortcuts
  at 15.0; accessibility keyboard/reader/live-captions and screenshots at
  26.1; secondary apps via `setConfiguration`).
- **Other real-session observations:** no re-lock mid-attempt (the
  emergency button ends the session, the attempt continues unlocked, and
  only quit-and-rejoin re-enters lockdown — decision 2.3's consequence,
  acceptable for MVP, a possible future "re-secure" affordance); the real
  framework confirms `end()` in ~2.7–3 s where the simulation is instant.
- **PoC-A's App ID stays active on purpose** (James, 2026-08-27): a
  separate AAC-entitled identity is the OS-release regression harness —
  run PoC-A against each new macOS on a canary Mac before the fleet
  updates, and rehearse risky session behavior without touching the
  production client's identity, profile, or TCC grants. **End state REACHED
  2026-09-03:** the client signs as itself (`net.psd401.securetest.client`)
  and PocA is PoC-only — its App ID stays active for exactly this purpose,
  so ongoing spikes and OS-release checks still run against it.
- **Watch items, note only:** one pill sighting needed a browser refresh
  (run 2; later runs arrived on the 5 s poll unaided — not reproduced);
  concurrent fire-and-forget posts can race server timestamps at the µs
  level (`lockdown_interrupted` landed 28 µs before its own
  `lockdown_begin` when the simulated session emitted both in one tick —
  harmless to `activeAlert`; serializing the reporter's posts is the fix
  if strict order ever matters).

## Teacher monitor v2 (slices 85–87) — decisions 2026-08-27

- Transport: polling the attendance endpoint from the page (A), with SSE (B) as the step up if latency or volume ever matter; WebSocket (C) rejected — it needs infra the deployment does not have and the data is one small query per teacher. A and B cost the database the same.
- Cadence 5 s; idle threshold 10 min (James, 19.3/19.4). Both are constants at the top of `SittingsPanel.tsx`.
- Signals are what the DB already has (attempts + per-item response saves); no client change. Anomaly signals (focus loss, paste) stay Phase 3.
- 87 (dedicated monitor page `/dashboard/[id]/monitor/[sittingId]`): same data, per-student cards, the code large for a projector — built 2026-08-27.

## Client contract for slice 91 (client events)

`POST /api/attempts/:attemptId/events` — student session cookie/bearer; the
attempt must be the caller's (404 otherwise, like the response routes; staff
403).

```json
{ "kind": "quit", "detail": { "anything": "optional jsonb bag" } }
```

- `kind` is a closed set: `quit`, `emergency_exit`, `focus_loss`,
  `focus_regained`, `lockdown_begin`, `lockdown_end`, `lockdown_failed`,
  `lockdown_interrupted`. Anything else → `400 invalid_body` — a drifting
  client should hear about it, not have events land as rows nothing displays.
- `201 { "ok": true, "event": { "id", "kind", "at" } }`. `at` is
  **server-stamped**; the client's clock is not part of the contract.
- A `submitted` attempt still accepts events (2.1 with James 2026-08-27):
  quit-shaped events are sent during teardown, and teardown races the submit.
- Fire-and-forget from the client's side: nothing downstream depends on the
  response body, and a failed post should never block an exit path.

Teacher-facing fold (same attendance payload the Sittings tab and monitor
poll): each row gains `last_event: { kind, at } | null` and
`alert: { kind, at } | null`. Alert semantics (2.2): sticky per kind —
`quit`, `emergency_exit`, `lockdown_failed`, `lockdown_interrupted` alert for
the attempt's lifetime; `focus_loss` is cleared by a later `focus_regained`.
`lockdown_begin` / `lockdown_end` / `focus_regained` are history only. Event
times do **not** feed `last_activity_at` — idle detection stays about test
progress, so a focus-loss cannot reset the idle pill.

## Client contract for slice 84 (as of slice 83)

`GET /api/me/sittings` — student session cookie/bearer, like `/api/attempts`.

```json
{ "sittings": [ {
    "test_session_id": "uuid",
    "code": "NBVC8P",
    "assessment_id": "uuid",
    "assessment_name": "Algebra quiz",
    "teacher_email": "teacher@psd401.net",
    "scope": "sections" | "section" | "students",
    "section_label": "Algebra 1 · 3(A)" | null,
    "expires_at": "2026-08-27T22:08:54.000Z",
    "created_at": "…",
    "attempt": null | { "id": "uuid", "status": "in_progress" | "submitted", "submitted_at": "…" | null }
} ] }
```

- Newest first. Only sittings the student could also join by code appear.
- Account problems are `200 { "sittings": [], "reason": "no_email" | "not_on_roster" | "identity_conflict" }` — show the reason; it is about the caller's own account.
- Join = the existing `POST /api/attempts { "test_session_id" }` → `{ attempt, resumed }` (201 new / 200 resumed), then the delivery bundle by `assessment_id` exactly as after `redeem`. A `submitted` attempt should render as done, not as Join.
- Staff sessions get 403 (the client's staff-account row already expects a 403 at join).

## Decided along the way

- Attendance joins expected-vs-joined loosely: an attempt whose student is no
  longer in today's scope is shown and flagged `in_scope: false`, not dropped —
  the teacher wants the whole room.
- Attendance is on-request (a Refresh button), not pushed. Monitor v2's
  WebSocket can replace the fetch later without changing the shape.
- Sitting creation requires a published assessment (decided 2026-08-27,
  James): a draft can change under a student mid-test, and publishing is the
  lock. Server-enforced (`409 not_published`), mirrored in the panel.
- Dev-DB seed for the client's slice-84 rows (2026-08-27): a second published, item-bearing assessment owned by James's sub with an open "all my sections" sitting, so Ada has one sitting with an attempt and one without; "Refresh after the teacher closes" is done by closing that sitting from the Sittings tab (or `POST /api/test-sessions/:id/close`) while the client is on screen.
- Dev-DB roster seed for hand-checks: copy `test/fixtures/roster/complete`,
  substitute the signed-in teacher's email for `teacher.one` (both rows —
  one is capitalised), recompute the manifest sha256s, then
  `DATABASE_URL=<dev> bun scripts/roster-import-local.ts <dir>`. Reversible
  with `truncate roster_*`.

## Open

- ~~7.1 Should sitting creation require the assessment to be published?~~ Yes (2026-08-27).
- ~~7.2 Seed the dev DB roster for the picker hand-check?~~ Done (2026-08-27), see above.
- ~~7.3 Attendance row buttons wrap under the code on narrow widths — cosmetic.~~ Fixed 2026-08-27: the row is an info group that wraps beside a fixed button group.
