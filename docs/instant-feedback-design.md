# Instant feedback at hand-in (roadmap row IF)

Design note, 2026-10-02. Trigger: open-beta teacher feedback — "the
ability to turn on instant feedback for deterministically scored items
when students hand in their tests." Decisions marked **D-n**; James's
answers of 2026-10-02 are recorded as decided, the rest are
recommendations. **§Progress says what is built** (nothing yet).

## Relation to the roadmap

- **Builds on D-6 (auto-score on submit)**: `POST
  /api/attempts/[attemptId]/submit` already runs `runAutoScoringPass`
  before it answers, so the deterministic scores exist when the client
  hears back.
- **ADR 0016 holds**: the delivery bundle still carries no key. Feedback
  is a separate, post-submit server response; correct answers leave the
  server only after hand-in, and only when the teacher chose that level.
- **Touches pass back (U-7)**: a passed-back student who saw right / wrong
  could fix exactly those answers. D-3 below.
- **Touches Change score (U-10) and E11** (rescoring after a key change,
  undecided): what a student saw can go stale. D-5 below.
- **Distinct from `rubric.student_visibility.with_feedback`** (row R),
  which governs the family-facing print page for essays. This note is
  about auto-scored items in the client.
- **Both sides: a client release.** Older clients ignore the new field.

## What exists that this stands on

- Auto-scored types: MC single / multi, short text (numeric equivalence,
  `exact_form`), match, order, hotspot, table cells. Essays, drawings and
  keyless items are not auto-scored.
- The client's hand-in (`AssessmentViewController.handleSubmit`): flush →
  `client.submit` → spool cleared → `onHandedIn` → the host ends the AAC
  session and returns to Your tests.
- Assessment settings: `time_limit`, allow flags, `student_layout`; a
  Published assessment locks its settings except status-only PATCHes.

## Design

### The setting (D-1)

`assessments.student_feedback`: `off` (default) | `score` | `right_wrong`
| `answers`. Settings tab, a select with one line under each:

- **Score only** — "You scored 14 of 18 on the questions scored right
  away. Your teacher will score 2 more."
- **Right / wrong** — score + a per-question ✓ / ✗ / "scored by your
  teacher" list, with the student's own answer shown.
- **Correct answers** — right / wrong + the key for each missed item
  (MC choice text, short-text key, match pairs, order, table cells).

**D-1 (James): all three levels in v1.** Changeable while Published (a
status-only-style PATCH, like archive) because a teacher may want to
turn answers on after the last period.

### Delivery (D-2)

- The submit response gains `feedback` when the setting is not `off`:
  `{ level, earned, max_auto, pending_count, items?: [{ item_id, number,
  result: "correct" | "partial" | "incorrect" | "pending", earned, max,
  your_answer, correct_answer? }] }` — built from the FINAL scores just
  written; `correct_answer` only at `answers`.
- The client shows it **after `DID END`**, on a feedback page in the
  normal (unlocked) window with a Done button back to Your tests — not
  inside the lockdown (the session must end promptly; a slow render must
  never hold a Mac in lockdown).
- Answers render with the same KaTeX / image rules as the test.
- Read-aloud follows the student's TTS accommodation.
- **D-6 (James, 9.2): not shown on a teacher's Hand in / Hand in
  everyone or a time-out hand-in** — the student is not at the screen for
  it, and with no "See my results" (9.1) it is never shown later.

### Interactions (D-3 … D-5)

- **D-3 (James): pass back turns feedback off for that student, for now.**
  An attempt with `pass_back_count > 0` gets no feedback on re-hand-in.
- **D-4 (James, 9.3): the teacher releases answers.** At the `answers`
  level a second setting chooses **"Show correct answers: at hand-in |
  after I release them"** (default: after I release them). Until the
  teacher presses **Release answers** (Settings tab and the results page;
  a status-only PATCH, allowed while Published; stamps
  `assessments.answers_released_at`), a hand-in shows right / wrong plus
  "Correct answers will be available after every class has taken the
  test." `score` and `right_wrong` always show at hand-in.
- **Consequence of D-4 + 9.1 = no "See my results" (James, 9.1):** a
  student who handed in BEFORE the release never sees the answers in the
  app — release affects later hand-ins only. The teacher reviews the
  answers in class or prints them (the work packet with the key page). The
  hint copy therefore reads "Your teacher will go over the correct
  answers." rather than promising they will appear. If teachers want
  released answers to reach earlier students, that is the "See my
  results" follow-up (9.1 reopened later).
- **D-5 feedback is a snapshot.** What the student saw is recorded as a
  `feedback_shown` attempt event (`detail`: level, earned, max). A later
  Change score or rescoring does not notify the student (v1); the
  per-student page's timeline shows what was shown, so a teacher can
  explain a difference.

### Mixed tests

`pending_count` counts essays, drawings, keyless and `ai` / `hybrid`
items; the score line always says how many the teacher still scores.
Partial-credit items (multi-select, match, table) show "partly right"
with points.

## Success looks like

- A teacher turns it on in one control; students see their result within
  seconds of hand-in, outside the lockdown.
- No key reaches a student before the teacher's chosen moment (test: the
  submit response for `score` / `right_wrong` carries no `correct_answer`;
  for `answers` + `on_release` before Release, neither).
- The score the student sees equals the results matrix's auto-scored
  total at that moment (test).
- Older clients keep working (they ignore `feedback`).

## Slices

1. Server: `student_feedback` + `answers_release` (`at_hand_in` |
   `on_release`) + `answers_released_at` (one migration), release PATCH,
   feedback builder (pure, tested), submit response, `feedback_shown`
   event kind (Opus 5 / medium).
2. Teacher UI: Settings select + answers-release choice + Release answers
   (Settings tab + results page) + help text; timeline line (Sonnet 5 /
   medium).
3. Client: decode, feedback page after `DID END`, Done → Your tests,
   VoiceOver + contrast sets (Opus 5 / medium) → client release.
4. Rows: teacher rows + client rows (one real AAC session for the
   after-`DID END` ordering).

## Open questions

Decided 2026-10-02 (James): 9.1 → no "See my results" in v1 (feedback is
seen once, at hand-in); 9.2 → D-6 (no feedback after teacher / time-out
hand-ins); 9.3 → D-4 (teacher release).

- None open. **9.4 accepted for now (James, 2026-10-02):** answers
  released after some students handed in reach only later hand-ins in the
  app; earlier students get them from the teacher. "See my results" is
  the follow-up if teachers ask for more.

## Progress

**Slice 1 (server) BUILT 2026-10-03** — not committed, not deployed. No
teacher UI (slice 2), no client (slice 3), no hand-run rows.

- **Migration 0054** (`instant_feedback`): `assessments.student_feedback`
  (`off` default | `score` | `right_wrong` | `answers`, CHECK),
  `assessments.answers_release` (`on_release` default | `at_hand_in`, CHECK),
  `assessments.answers_released_at timestamptz null`, attempt event kind
  `feedback_shown` (CHECK widened). Applied to dev, test and `_demo`; Aurora
  picks it up at the next deploy's boot (DS-1).
- **`feedback_shown` is server-written only**: it rides
  `STAFF_ONLY_ATTEMPT_EVENT_KINDS` (the "not client-postable" list) although
  it is not a staff action — a client that could post one could plant "saw
  14 of 18". Detail `{ level, earned, max_auto, answers_shown }`. Monitor
  label "Saw instant feedback"; the per-student timeline reads "Saw instant
  feedback 2:07 PM · 14 of 18 (answers shown)"; the print report's integrity
  line skips it (not an integrity event).
- **Settings API**: both settings on the assessment GET (row columns), on
  create (defaults) and PATCH (Zod enums, unknown value = 400). **Published
  lock**: a second door beside the unlock, `isFeedbackSettingsOnlyPatch`
  (`lib/api/requireDraft.ts`) — same changed-field rule as the unlock (C9:
  the editor sends every field), status must stay `published`, at least one
  of the two settings must actually change; any other changed field still
  409s. `answers_released_at` is NOT on the PATCH body.
- **Release = `POST /api/assessments/[id]/release-answers`** (choice: a
  dedicated POST, not a PATCH field — the stamp is a server instant, and
  keeping it off the PATCH body means neither the settings PATCH nor the lock
  exception has to reason about it). `edit` level (404 below it), allowed
  while Published, 409 `not_answers_level` unless the setting is `answers`
  (a release at a lower level would silently pre-release the key if the
  teacher later raised it), idempotent (`already_released: true`, original
  stamp kept, `IS NULL` guard on the update). No un-release.
- **Bundle**: `student_feedback` / `answers_release` added to
  `ItemBundleSchema` (teacher bundle; `StudentFeedbackSchema` /
  `AnswersReleaseSchema` in `packages/schema`), emitted only when not the
  default (byte-stable older bundles, as `student_layout`); import reads
  absent as the defaults. The stamp never travels — export, share-accept and
  duplicate (which rides export → import) all start unreleased. The delivery
  bundle is untouched (ADR 0016).
- **Builder** `lib/feedback/buildFeedback.ts` (pure) + `attemptFeedback.ts`
  (DB load of items / responses / FINAL scores, the event write). Output as
  D-2 plus `answers_note` (the exact copy above) at `answers` before
  release. Choices / deviations:
  - **A skipped KEYED auto item counts as `incorrect`, 0 of its max, inside
    `max_auto`** — deviation from "sum over items with a final score":
    otherwise a skipped MC question would be counted as "scored by your
    teacher", which is untrue. Consequence: `earned` always equals the
    results matrix's `total_points` at hand-in (tested); `max_auto` equals
    `scored_max_points` only when every auto item was answered (tested on
    such an attempt) and is larger by the skipped items' max otherwise.
  - `pending` = every non-`auto` method (essay, drawing, `human` / `ai` /
    `hybrid`, keyless table), a keyless auto item, and an answered auto item
    with no final (e.g. a scoring failure). Pending items carry `earned` /
    `max` null and never a key.
  - `correct_answer` only on **missed** items (`incorrect` / `partial`), per
    the note's "the key for each missed item"; never on correct or pending
    ones.
  - Text: lines joined with `\n`; MC = choice text, match = `left → right`
    in authoring order, order = `1. label`, table = `Row, Column: value` for
    the keyed cells (a blank row label reads `Row N`, an empty cell
    `(blank)`), hotspot = `Region N` by the region's position (regions have
    no labels), drawing = `[drawing]`, essay = its text, unanswered = `null`.
    Image refs become their alt text or `[image]`; no asset id survives.
    `answerView.ts` was not reused: it carries ✓ / ✗ and raw region ids, and
    has no table text.
  - Unknown level value → null (show nothing).
- **Submit route**: after `runAutoScoringPass`, when `pass_back_count === 0`
  (D-3) and the level is not `off`, the response gains `feedback` and one
  `feedback_shown` row is written; a failure is logged and never fails the
  hand-in. No existing response field changed. Teacher Hand in / Hand in
  everyone / time-out go through other routes and never build it (D-6).
  **Retry choice**: an idempotent retry (`already_submitted: true`) re-sends
  `feedback` only when a `feedback_shown` row already exists for the attempt
  (and `pass_back_count` is 0), rebuilt from the current finals, with no
  second event — the first answer may have been lost on the wire; a
  teacher-handed-in attempt has no such row, so D-6 holds on that path.
  Practice attempts get feedback (a teacher previewing what students see).
- Tests: `test/instant-feedback-builder.test.ts` (16, pure — every level
  and release state, every auto type's result + text, partial, pending,
  skipped items, no `correct_answer` / `asset:` in the JSON where none is
  allowed), `test/instant-feedback-api.test.ts` (19, test DB — submit per
  level, event once + retry, results-matrix equality, pass back, teacher
  hand-in, release access / level guard / idempotency, Published PATCH,
  export + duplicate), a `feedback_shown` timeline case. Design-tool 2770
  pass, typecheck clean; schema 126 pass.
- Not done here: the Settings select + Release buttons + help text (slice
  2), the client page after `DID END` (slice 3), rows (slice 4).

**Slice 2 (teacher UI) BUILT 2026-10-03** — one commit, not deployed, no
migration. Rows 415–423 in `docs/design-tool-manual-checks.md`, NOT RUN. The
timeline line already existed from slice 1 (`lib/reporting/timeline.ts`) —
nothing added.

- **Settings tab**: `components/app/InstantFeedbackSettings.tsx`, below the
  Save row. Choice: it **saves on change** (its own PATCH, "Saved <time>" via
  `StatusLine`) rather than riding the tab's Save button, because the tab's
  Save sends `name` / `description` / `time_limit_seconds` / the layout, which
  are locked while Published; the control sends ONLY
  `{ student_feedback, answers_release }` (`feedbackSettingsBody`), so
  `isFeedbackSettingsOnlyPatch` has nothing else to compare. It is not gated
  by `isLocked`. A failed save reverts the select and shows the error. The
  "Show correct answers" select appears only at `answers`; the "feedback shows
  only when students hand in themselves, not after a teacher hand-in /
  Hand in everyone / time-out / pass back" note shows at every level but Off.
- **Release answers**: `components/app/ReleaseAnswersControl.tsx` (button +
  AlertDialog confirm with the note's exact copy + POST `release-answers`;
  replaced by "Answers released <date time>" once stamped; no un-release),
  used on the Settings tab and, through `results/ReleaseAnswersAndReload`
  (full reload, like `SendToGradebookAndReload`), on the results page toolbar.
  Button rule `canReleaseAnswers` = `answers` + `on_release` + not stamped;
  the released line shows at `answers` once stamped. On the results page the
  button is edit-level (`levelSatisfies(access.level, "edit")`); the quiet
  line is shown to any viewer. Choice: on the Settings tab the button is not
  disabled-with-explanation at other levels — it is simply absent (the release
  select it belongs to is absent too).
- **Wording and rules** in `lib/feedback/settingsUi.ts` (client-safe, no
  drizzle import). `AssessmentView` gained the two settings + the release
  stamp (ISO), fed from `app/dashboard/[id]/page.tsx`.
- **Help**: `public/help.html` topic 8 ("Score and give feedback") gained
  "Instant feedback when students hand in" (no screenshot);
  `docs/pilot-quick-start.md` building list item 6.
- Tests: `test/instant-feedback-ui.test.tsx` (14: wording, button / line
  rules, the PATCH body against `isFeedbackSettingsOnlyPatch`, static markup
  of both controls). The click paths (PATCH on change, confirm + POST) are
  hand-run rows.
- Not done: the client feedback page (slice 3), the two-account rows 422–423,
  a screenshot for the help topic.

**Slice 3 (client) BUILT 2026-10-03** — one commit, not released, no
`MARKETING_VERSION` bump (the release is its own step). No server change.
17 rows in `client/MANUAL-CHECKS.md` "Instant feedback page (IF slice 3)",
NOT RUN. `swift test` 877 (847 + 30 new), Debug and Release `xcodebuild`
green.

- **Decode** (`SecureTestCore/InstantFeedback.swift`): `APIClient.submit` now
  returns `InstantFeedback?` (`@discardableResult`); its throw paths are
  unchanged and a feedback object it cannot read is nil, never a failed
  hand-in. Rules: unknown `level`, or a missing / non-numeric / boolean
  `earned` / `max_auto` / `pending_count` → nil (old behaviour exactly).
  **Choice: an item with an unknown `result` word, or without a usable
  `number`, is DROPPED** rather than shown as "Scored by your teacher" — a
  future server's new word must not become a claim this build cannot back;
  the score line stays the server's own total. A `pending` row never carries
  points or a key, whatever the wire says.
- **Presentation** (`InstantFeedbackPresentation`, pure): score line "You
  scored 14 of 18 on the questions scored right away." (D-1); a test with
  nothing scored right away says "None of the questions on this test are
  scored right away." + "Your teacher will score all N questions." /
  "…the question.". **Deviation from D-1's example copy: the pending line
  carries the noun** — "Your teacher will score 1 more question." / "2 more
  questions." — so the plural rule has something to apply to. Row headings
  "Question N — Right / Partly right (1 of 2) / Not right / Scored by your
  teacher" (points on a partial only); "Your answer: …" ("(no answer)" when
  null); "Correct answer: …" only when the server sent one. Points print
  whole, else up to two decimals.
- **Ordering (D-2, D-6)**: `onHandedIn` carries the feedback; the host
  (`AppDelegate`) keeps it in `pendingFeedback` and shows it only from the
  `.idle` transition (`DID END`, or the grace teardown) with
  `attemptHandedIn` set — never inside the lockdown, and the hand-in never
  waits on it. A hand-in with no session up (nothing to end, so no `.idle`)
  shows it on the next main-queue turn. Every non-hand-in end (teacher Hand
  in → `sitting_closed`, time-out, Cmd-E / Cmd-Q, refusal) goes through the
  existing paths and never sets it; `showEntry()` / `showAssessment()` clear
  it. **Reading: a student who presses the in-page "Back to your tests" in
  the second between "Handed in." and `DID END` leaves the attempt screen
  first and does not see the page** (accepted; the server's `feedback_shown`
  row is written at hand-in regardless, as D-5 has it).
- **Page** (`SecureTestCore/InstantFeedbackPage.swift`): loaded into the
  attempt's OWN web view (`AssessmentViewController.showFeedback`) rather
  than a new screen — the bundle's accommodations (contrast, optional font,
  zoom through `PageShell`'s root attributes), the student's pinch / ⌘=
  magnification, the CSP (no network) and the `home` channel (→
  `onBackToTests` → `showEntry()`) all come for free. Markup is built in
  Swift with every server string HTML-escaped, then the page runs the test's
  own `$…$` math pass over the text nodes; `\n` is kept by `white-space:
  pre-line`. **Refactor to share the math rule: `mathSegments`,
  `stripTexAnnotations`, `mathFragment` and `renderMathIn` moved verbatim
  out of `rendererScript` into `AssessmentPage.mathPassFunctions`, which the
  renderer splices in at the old spot** — one copy for both pages, so C-2 /
  M-1 / ME-3 cannot drift (the 847 existing tests pass unchanged). Answers
  get the authored-text rule; a short-text answer shows as typed (the
  field's own text — the `\mathrm{…}` formula preview is not reproduced),
  and `**bold**` / `_italic_` are not applied.
- **Accessibility**: `h1`, `p`, `ol role="list"` (WebKit drops list
  semantics under `list-style: none`), one `li` per question with the result
  as words; the ✓ / ✗ / ◐ / … marks are `aria-hidden`. Every colour is a
  token (a test pins no literal hex), so all eight contrast sets apply.
  Buttons carry `tabindex="0"` (HS-1 / ME-1, Keyboard navigation OFF).
  **Choice: focus starts on the heading (`tabindex="-1"`), not on Done**, so
  VoiceOver reads the results before the way out; Return and Escape are Done
  from anywhere on the page (Return on the Read aloud button is that
  button's own activation), guarded to post once.
- **Read aloud — choice: a page-level "Read aloud" / "Stop reading" button**
  over the existing `tts` channel, shown for any read-aloud grant
  (`TextToSpeechScope.isEnabled`, the same check `handleSpeech` applies
  against the attempt's bundle). It sends the page as segments (text nodes,
  formulas as TeX, a full stop between blocks, marks and buttons skipped).
  The test's per-block Speak controls and word highlight were not carried
  over — `word` callbacks are accepted and ignored.
- Tests (`InstantFeedbackTests`, 30): decode per level, older server / empty
  body / bad shapes, unknown result + missing number, pending without
  points, the submit call's return; presentation copy and plurals; page
  order, no list at `score`, key lines only where sent, escaping, `tabindex`,
  Read aloud gating, contrast / zoom attributes + CSP, token-only styles,
  the shared math pass; the page script in JavaScriptCore against a small
  DOM stub (focus on the heading, Done / Return / Escape post `home` once,
  Return on Read aloud does not, the spoken segments decode as a
  `SpeechCommand` and read in order without the marks or buttons).
- Not done / only a hand-run can prove: the page actually appearing after a
  REAL `DID END` and never inside the lock; WebKit rendering of KaTeX and
  the contrast sets on this page; VoiceOver's reading order; Return /
  Escape reaching the page in a real window (the host makes the web view
  first responder); the client release (psd-sign + `gh release create`).
