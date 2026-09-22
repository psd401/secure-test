# UX pass 3 — research: authoring effort vs Google Forms

Research note, 2026-09-22 (James: "teachers are familiar with Google Forms —
can the design tool be more like that experience, maintaining capability
while minimizing effort?"). This page is the measurement and the friction
list; the decisions and the slices come later, after two weeks of pilot
feedback (roadmap 2026-09-22 sequencing). Nothing here is built.

## Method

One task, authored twice by the same driver (Claude in Chrome, so wall-clock
is automation-paced and not comparable — **actions are the measure**): a
ten-question multiple-choice quiz, four choices each, one correct answer
worth one point, ready for students. Secure-Test on the origin (rev 47) as
the assessment owner; Google Forms from the "Blank Quiz" template in the
same Google account. Both artefacts were removed afterwards (the Secure-Test
draft deleted; the Form is in the account's Drive, untouched — delete it
when done). Counting rules: a pointer click is one action; a typed field is
one field; a keyboard chord (Cmd-A, Return, Tab) is one key. Scrolls are
noted, not counted.

## Measurements

| | Secure-Test | Google Forms |
|---|---|---|
| Create + name | 3 clicks, 1 field | 1 click (template), 1 click + Cmd-A + 1 field (title) |
| One question, optimal path | **8 clicks** (Add question · Choice A · Choice B · Add choice · Choice C · Add choice · Choice D · Save question) + **2 Cmd-A** + 1 radio click when the answer is not A + 5 fields | **5 clicks** (Option 1 · Answer key · the correct option · Done · Add question) + **3 Return** + 5 fields |
| Ten questions | 80 clicks + 20 Cmd-A + 7 radio clicks = **107 pointer/key actions**, 50 fields, 10 explicit saves | 50 clicks + 30 Return = **80 actions**, 50 fields, 0 saves (autosave) |
| Make it ready | Publish + confirm = 2 clicks | Points: one Settings visit to set the default point value (4 clicks) — BUT it applies only to questions created afterwards, so the questions that already existed need the Answer key visit again (4 clicks each) |
| Total for the task | **~112 actions, 51 fields** | **~90 actions + the points fix, 51 fields** |
| Where the answer is set | radio beside the choice, inline, default = A | a separate "Answer key" view per question, default = none |
| Where focus lands after "Add question" | the new card's stem, auto-scrolled, text selected | the new card's question field |
| Default text | **real values** ("New question", "Choice A", "Choice B") — click-then-type appends | placeholders ("Untitled Question", "Option 1") — type replaces |
| Adding a choice | a button per choice (two clicks per extra choice: Add choice, then the field) | Return in an option field creates the next one |
| Save model | per-question "Save question" (disabled until valid); "Saved 9:43 AM" stamp | continuous autosave ("Saving… / All changes saved in Drive") |
| Reordering | Move up / down buttons per card | drag handle |
| Where the add control lives | a bar ABOVE the list — grows away from the newest card; the page auto-scrolls back to the new card, so the round trip is scroll-up, click, auto-scroll-down | a floating rail beside the current card |

Wall-clock, for the record only: Secure-Test ≈ 6 minutes, Forms ≈ 25
minutes — the Forms figure is automation friction (its contenteditable
option fields dropped or failed to commit text three times and needed
re-entry), not a teacher's experience, and must not be read as a result.

## Findings (Secure-Test)

Numbered for the pass-3 decision table; sizes are guesses.

- **UX3-1 Default text is content, not placeholder** (XS, high value).
  "New question" / "Choice A" / "Choice B" are real values. A teacher who
  clicks into the field before typing gets "New questionWhich planet…".
  The stem is pre-selected on creation, so keyboard-first typing works;
  Choice A / B never are. Placeholders (empty value + `placeholder=`) fix
  it, and readiness already treats an empty choice as incomplete.
- **UX3-2 Two extra choices cost four clicks** (S). MC cards start with
  two choices; a four-choice question needs Add choice + click into the
  field twice. Forms' Return-to-add-the-next-option is the convention to
  adopt: Return in a choice field adds the next choice and focuses it;
  start MC cards with four choices (the roster of real assessments is
  four-choice MC almost without exception — check the import corpus).
- **UX3-3 "Save question" is the single largest difference** (M, the
  design decision of the pass). Forms autosaves every keystroke; the tool
  saves per question on a button that is disabled until the question is
  valid. The Accommodations tab already autosaves through `lib/autosave.ts`
  (C-6), so the pattern exists. The trade-off to decide: a half-typed
  question that autosaves is a Draft the readiness check can still flag;
  the Publish gate is where validity belongs, not the field. Keep the
  "Saved 9:43 AM" stamp as the autosave indicator.
- **UX3-4 The Add control is at the top of a list that grows downward**
  (S). After saving question 9 the teacher scrolls to the top to add
  question 10 and the page scrolls them back down. Forms keeps the rail
  beside the active card. A sticky "Add question" at the bottom of the
  list (or the rail pattern) removes ten scroll round-trips per ten
  questions.
- **UX3-5 Tab order puts four toolbar buttons between the stem and the
  first choice** (XS). Keyboard authors Tab six times to reach Choice A.
  Either move Image… / Math… / B / I out of the Tab order (`tabindex=-1`,
  reachable by pointer and by a shortcut) or place them after the choices.
- **UX3-6 Correct answer defaults to A** (keep). Inline radios beat Forms'
  separate Answer key view: seven of ten questions cost one click, three
  cost none. Do not copy Forms here.
- **UX3-7 Choice text appended to real defaults survives readiness**
  (XS, follows UX3-1). "Choice AMercury" is a valid choice to the check.
  Placeholders make the case impossible.
- **UX3-8 The card count of toolbars.** Every choice carries Image… / B /
  I / Math…; a ten-question MC page shows sixty small buttons. Forms shows
  one "Add image" affordance per option on hover. Worth a hover-reveal or
  a single per-card toolbar (M, visual pass territory).

## What Forms does that the tool should not copy

- **No publish lock.** Forms edits live; students would see a question
  change mid-test. The lock stays; the friction to address is the
  "Unpublish to edit" round trip, not the lock itself.
- **Points default 0 on the quiz template**, set per question or via a
  Settings default that only applies forward — the tool's one point per
  item by default is better.
- **Answer key as a separate view** — see UX3-6.
- **Sittings, rosters, accommodations, rubrics, KaTeX, item sets** have no
  Forms equivalent; the pass is "feels like Forms until you need what Forms
  cannot do", not parity.

## Signals from the pilot week (logs, 2026-09-14 → 2026-09-22)

CloudWatch Logs Insights on the app log group, read-only:

| Event | Count | Reading |
|---|---|---|
| `client_errors_received` (client `errors.log` drains) | 26 batches, 33 lines — 17 batches on 2026-09-17 (pilot day 1, 08:30–13:56 PT), 6 lines in one batch 2026-09-14, the rest hand-run days | the per-line kinds live in `client_error_events`, not the log — see the pending pull |
| `request_error` (server 500) | 5, none after 2026-09-15 20:43 UTC — three "destination stream closed early" (fixed by O-1, now `request_aborted` WARN) and two row-67 debug throws | no pilot-facing server error |
| `feedback_publish_failed` | 0 | every teacher feedback that was sent reached SNS |
| `essay_score_failed` | 0 since the R-5 fix | — |

**The Aurora rows (James ran the read-only pull, 2026-09-22):**

- **`feedback`: 0 rows since 2026-09-15.** Nobody has pressed Send
  feedback during the pilot. Either nothing was worth reporting or the
  header button is not where a teacher looks when something goes wrong —
  ask in person (reading **L-4**).
- **`client_error_events` since 2026-09-15**, by kind (v1.3.3 rows are the
  pilot's; the 2026-09-21 v1.3.4 rows are our own hand-run day):

| Day (PT) | Version | Kind | n | What it is |
|---|---|---|---|---|
| 09-15 | 1.3.1 | `join_failed` | 1 | `session_unavailable` (404) |
| 09-16 | 1.3.3 | `signin_failed` | 1 | `cancelled` |
| **09-17 (pilot day 1)** | 1.3.3 | `signin_failed` | **12** | `cancelled` — the sheet's Cancel button, Cmd-Q mid-sign-in, or a second Join while a sheet is up (`WebViewAuthPresenter`); NOT the silent -999 failure |
| 09-17 | 1.3.3 | `join_failed` | 4 | 3 × `session_unavailable` (a code for a sitting that is closed, expired or not theirs — the oracle-proof answer) + 1 × `malformed_code` |
| 09-17 | 1.3.3 | `event_not_delivered` | 1 | one attempt event exhausted its retries |
| 09-17, 09-21 | 1.3.3 / 1.3.4 | `signin_failed` | 2 | `NSURLErrorDomain -999` on the SSO ACS post — SI-1 |
| **09-18** | 1.3.3 | **`lockdown_unrecoverable`** | **1** | `exit(70)` at 11:27 PT: the teardown backstop fired — `end()` was called with the lockdown active and no confirmation came within the grace period, so the process exited (AppDelegate `onUnrecoverable`). Two `signin_failed cancelled` follow at 11:29 on the same day |
| 09-18 | 1.3.3 | `signin_failed` | 2 | `cancelled` |
| 09-21 | 1.3.4 | `event_not_delivered` / `sittings_failed` / `crash` | 4 / 1 / 1 | our hand-run (offline rows; the SIGABRT at 16:30 PT was deliberate — James, 2026-09-22) |

Readings for the friction list (proposals only):

- **L-1 Twelve sign-in cancels on pilot day 1.** Students back out of the
  Google / ClassLink / MFA sheet. The entry card gives no hint afterwards
  (the SI-1 proposal covers only the -999 case). Ask the pilot teachers
  what students saw; consider "Sign-in cancelled — press Sign in with
  Google to try again" under the button, and count cancels per attempt
  in the client log so a loop is visible.
- **L-2 One unrecoverable lockdown on a pilot Mac — resolved to a
  timeline (second pull, 2026-09-22).** The row's context names an attempt
  on the pilot assessment's 2026-09-17 sitting (opened 12:06 PT, expiry
  13:01). That attempt's events: `lockdown_begin` 12:21:09 → one answer
  saved, last write 12:52 → `focus_loss` 12:57 → `teacher_hand_in`
  13:01:01 → `sitting_closed {via: peek}` 13:01:54 → **no `lockdown_end`,
  ever.** The `lockdown_unrecoverable` line carries no `occurred_at` by
  design (`CrashReporter.line`: the drain stamps its own time), so the
  "2026-09-18 11:27" is the moment the student next signed in, not the
  exit. Reading: at ~13:02 on pilot day 1 the client saw the sitting
  closed, called `end()`, and `DID END` did not arrive within the
  teardown grace — **5 seconds** (`Timings.grace`) — so the backstop
  fired `exit(70)`. The process exit ended the AAC session (the Mac
  unlocked), the student's answer was already handed in by the teacher
  a minute earlier, nothing was lost, and nobody saw more than the app
  quitting. The 2026-09-16 real-session close measured `lockdown_end`
  3 s after `sitting_closed` on the test device; a slower pilot Mac
  plausibly needs more than 5. Proposals (client, v1.3.5 candidates):
  raise the teardown grace toward the page-load gate's 20 s (an extra
  wait on a locked screen is cheaper than a vanished app); stamp
  `occurred_at` on the unrecoverable line (it is written from the
  backstop queue, not a signal handler, so a clock read is safe) and add
  the macOS version to the context; count the fleet's `lockdown_end`
  latencies from `attempt_events` before choosing the number.
- **L-3 Three `session_unavailable` joins on day 1.** Students typing a
  code before the teacher opened the sitting, or a wrong code. The client
  copy for that code is deliberately vague (oracle-proofing); "Your tests"
  lists open sittings without a code — ask whether teachers had students
  type codes at all.
- **L-4 Feedback unused** — above.

The one-off runner has no read-only SQL mode; adding one is a small slice
if this pull becomes routine.

## Proposed next steps (not decided)

1. James gathers the pilot teachers' friction in person (two weeks).
2. Fold the `feedback` + `client_error_events` pull into this page.
3. Decision table for UX3-1…UX3-8 (adopt / reject / later), then a slice
   plan: UX3-1 + UX3-2 + UX3-5 as one XS/S slice; UX3-3 autosave as the
   M slice with its own design page; UX3-4 and UX3-8 with the visual pass
   (the `frontend-design` skill) once the interaction decisions are made.
4. Client side: the accessibility audit (VoiceOver rows first), not a
   visual redesign.
