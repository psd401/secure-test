# UX pass 2 — proposal (2026-08-31)

Inputs: the UX pass 1 hand-run findings **P2-1…P2-9**
(`docs/design-tool-manual-checks.md`, "Findings from the 2026-08-31 run")
and the parked student-run findings **10.3–10.9** (`docs/phase-7-slices.md`).
Decisions below are James's, 2026-08-31. Proposal 2026-08-31 morning; ALL EIGHT SLICES BUILT the same day (commits 7e0f309..d2 range on main) — design-tool slices 1-5 verified live in Chrome + full suite 922 pass, client slices 6-8 swift test 276 pass + Debug builds, with the slice 6/8 hand-run rows waiting in client/MANUAL-CHECKS.md.

## Decisions

| Finding | Decision |
|---|---|
| P2-5 Keep mine re-raised by identical re-imports | **Persist the decision**: remember the TIDE code the teacher declined so the same conflict is not re-raised until TIDE says something new |
| P2-6 one attempt per assessment, ever | **Keep for the pilot** + honest student-facing copy on a declined join; real retake design deferred — better with broader input |
| 10.4 Cmd-Q mid-attempt `quit` event lost | **Accepted as designed** (best-effort post; a delayed exit is worse than a lost event) |
| 10.7 DNS breaks beside a real AAC session | Record-only (already in the AAC notes) |
| 10.9 nothing current before 2026-09-02 | Record-only; no "starts Sep 2" label (moot at go-live) |

## Slices (design-tool first, then client)

1. **Sign-in surface** — P2-1 `prompt=select_account` on the authorize URL
   (`app/api/auth/start/route.ts`); P2-9 stop the sign-in card's error box
   clipping its second line (the `/login` card). Check: a second Google
   account gets a chooser (row 2 becomes testable); the full
   `student_account` sentence renders at 13".
2. **New assessment form** — P2-2 `noValidate` (or drop `required`) so
   `actions.ts:46`'s "Give the assessment a name." is what a teacher sees.
   Check: manual-checks row 5 passes as written.
3. **Editor** — P2-3 the Add-question stem defaults ("New question" as a
   placeholder or selected-on-focus, `AssessmentEditor.tsx:672`); P2-4
   `disabled={isLocked}` on the stem textarea and choice text inputs
   (`AssessmentEditor.tsx:1374-`). Check: typing right after Add question
   yields only what was typed; a published assessment accepts no keystrokes
   and never shows "Unsaved changes".
4. **Monitor** — P2-7 `alertIsCurrent` clears when ANY `lockdown_begin` or
   answer activity postdates the alert (match the comment's rule,
   `attendanceView.ts:109-117`) and the current-alert label stops flipping
   between kinds; P2-8 a Closed session keeps polling while any in-progress
   attempt remains. Check: manual-checks row 10's rejoin flips the row on
   rejoin alone; a student finishing after Close updates without Refresh.
5. **TIDE Keep mine persists** — P2-5. Store the declined TIDE code on the
   accommodation row (one nullable column, e.g. `kept_against_tide_code`;
   Drizzle migration), set it on "Keep mine", clear it when the teacher
   edits or TIDE's value changes; `pendingDiffs` skips rows whose current
   TIDE code equals the kept one. Check: identical re-import raises 0
   changes after Keep mine; a NEW TIDE value still raises.
6. **Client: a way home + honest join copy** — 10.3 "Back to your tests"
   once the session is down (emergency end or hand-in; covers the
   no-rejoin-after-emergency-end observation); 10.6 out-of-scope
   join-by-code copy ("That code is not open for you right now", keep the
   404); P2-6 pilot copy for a join declined on an already-submitted
   attempt (today: silent stderr + the entry screen). Check: on a shared
   Mac the next student reaches "Your tests" without Cmd-Q; a declined
   student is told what happened in student words.
7. **Client: lifecycle event retry** — 10.8, retry/queue for lifecycle
   kinds only (`AttemptEventReporter`); answers already spool. 10.4 stays
   accepted (no wait added). Check: with the server down for a minute,
   `lockdown_begin` still arrives after it returns.
8. **Client: Cmd-E investigation** — beeped in real AND simulated sessions
   2026-08-31 (worked 2026-08-26); the End secure session button is the
   working path. Timeboxed diagnosis (menu item validation / responder
   chain / focus in the WebKit view) before any fix. Check: Cmd-E ends the
   session from keyboard focus inside an answer field.

Out of scope (unchanged in the §6 ledger): retake design (P2-6 full),
toasts/Radix components, brand dark theme, search/filter, and the rest of
`docs/ux-pass-1.md` §6.

## Follow-ups found during the 2026-08-31 client re-check

- **Google sign-in stickiness (slice 9, BUILT + hand-run COMPLETE
  2026-08-31 — every MANUAL-CHECKS row closed):** gate row PASSED (Google
  serves the page to the Safari-shaped UA), credentials demanded on every
  sign-in, sign-in traverses Google → ClassLink SSO + MFA inside the sheet
  (the no-hostname-allowlist choice was load-bearing), staff MFA completes,
  no passkeys tied to PSD Google accounts (passkey risk moot), Cmd-Q
  mid-sheet fixed (`AuthSheetWindow`), Web-Content-crash path proven, and
  sign-in failures deliberately return silently to the sign-in prompt
  (James's decision — details in MANUAL-CHECKS). a lingering Google web session survives
  `prompt=select_account`, `prompt=login`, app relaunches, and is NOT
  visible in Safari — it lives in the AuthenticationServices daemon's store,
  outside the API's reach. James's decision stands (demand credentials every
  time). Built as planned: sign-in presents in our own `WKWebView` on a
  `WKWebsiteDataStore.nonPersistent()` per attempt
  (`client/SecureTest/WebViewAuthPresenter.swift`, replacing
  `GoogleAuthPresenter`), the reverse-scheme redirect intercepted in the
  navigation delegate; `prompt=login` stays and the authorize log line now
  shows its value. Consequences accepted: the UA is Safari-shaped to avoid
  Google's embedded-webview block ("disallowed_useragent" — the
  MANUAL-CHECKS gate row; Google could tighten detection on their side, and
  the revert is one commit); cross-app SSO is gone by design, so staff on
  their own Macs retype credentials too; passkeys have no platform
  authenticator inside a WKWebView (fallback factor expected). Hand-run
  table: `client/MANUAL-CHECKS.md` "Sign-in re-run (UX pass 2 slice 9)".
  Dev workaround until the hand-run passes: the minted `SECURE_TEST_TOKEN`
  launch.
  **Follow-on (James, 2026-08-31, during the hand-run): fresh sign-in
  forced every launch.** The session JWT no longer persists at all — the
  app's token store went from the Keychain to `InMemoryTokenStore`
  (`KeychainTokenStore` deleted; a legacy Keychain row from older builds is
  purged at startup). Accepted: a crash mid-test costs a full re-auth
  before Resume (1.1); staff use the design tool, not the client, so their
  per-launch sign-in doesn't matter (1.2); the verified
  relaunch-stays-signed-in row is deliberately inverted (1.3). `--token` /
  `SECURE_TEST_TOKEN` dev seeding is unaffected — it re-seeds per launch.
- **Raw LaTeX in editor/AI-proposal inputs (James, 2026-08-31, first
  live Bedrock generation)** — **BUILT 2026-09-01** (the gap was narrower
  than filed: stem + MC choice inputs have had the debounced `MathPreview`
  since slices 11–12; what lacked it was the AI proposal card — stem,
  correct answer, choices — and the regular short-text Correct answer.
  All four now render live; hand-run = manual-checks row 21). *Original:*
  the Generate-with-AI proposal and the
  editor's question/choice inputs show KaTeX source —
  `$\frac{2}{3}$ cup` — which staff unfamiliar with the notation can't
  read; only the preview renders it. For a future UX pass: a rendered
  view alongside (or instead of) the raw inputs — e.g. render-on-blur,
  a live side-by-side, or KaTeX chips in read-only contexts like the
  proposal card. No slice yet; recorded so it isn't lost.
- **SittingsPanel intermittent hydration stall — MEASURED 2026-09-02, not Securly, not the app:**
  the page's React tree does not hydrate while the document is hidden (a
  background tab, or a window Chrome treats as occluded), and the panel's
  mount effect — hence its first fetch — runs only after hydration. On the
  origin (rev 8) with Claude driving a background tab: document load
  complete at 220 ms, all 15 JS chunks from cache by 185 ms, then 32 s with
  `visibilityState: "hidden"`, zero API requests, 11 skeletons, no console
  message, `__next_f` empty, a tab click doing nothing; the instant a
  screenshot painted the tab, `/api/roster/sections` and
  `/api/test-sessions` fired (32.5 s) and the form was up 2 s later. With
  the page painted from the start the same two fetches fired at 305 ms and
  359 ms. Server exonerated separately: ALB TargetResponseTime max 0.18 s
  across the slow window, and the two gate endpoints answer in 40–170 ms.
  This reproduces the original symptom line for line (no fetch, no error,
  intermittent, unaffected by reloads). **CLOSED 2026-09-02:** James confirms the Chrome window was covered when
  it stalled; with the tab uncovered and active on its own screen, the same
  page's fetches fired at 452 / 563 ms and the form was up by 2.3 s with
  nothing from the automation painting it. Not an app bug; no change. The
  15 s fetch timeouts added on 2026-08-31 stay as a belt-and-braces.
  Original note: the Test sessions tab can
  sit at "Loading test sessions" indefinitely — no API fetch fires, no
  console error, across reloads AND a dev-server restart, then works other
  times. Suspect the Securly extension's DOM injection (it already causes
  the hydration-mismatch overlay). Unblocked via POST /api/test-sessions
  from the console. Needs a look with extensions disabled before it's
  called an app bug.
  - **Code audit 2026-08-31 (read-only):** the load state machine is sound —
    mount effect → `loadAll()` → sections fetch → sittings fetch, every
    reject lands in `loadState "error"` with the SM-04 retry alert; effect
    deps are stable. The ONE app-side path that reproduces the exact
    symptom (stuck "loading", no error, network tab empty-looking) is a
    fetch that never settles — `loadAll`'s fetches have **no timeout**, and
    an extension-intercepted request can hang indefinitely. That is also
    exactly what Securly-style interception does, so the two theories are
    one theory.
  - **PROPOSAL (small):** pass `AbortSignal.timeout(15_000)` to the three
    first-load fetches in SittingsPanel (`/api/roster/sections`,
    `/api/test-sessions`, `/api/roster/students`) so a hung request
    becomes the existing error state + "Try again" instead of a permanent
    stall; plus one `console.info("sittings: loadAll start")` breadcrumb
    so the next live stall answers "did the effect even run" in one look.
    Does not close the Securly question (still wants one repro with
    extensions off) but converts the failure from dead-end to recoverable
    either way.
