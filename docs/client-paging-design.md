# Per-question paging in the student client

Design page, 2026-09-02. Decisions marked **D-n** are James's (all five
accepted the same day); **§Progress says what is built** — slices 1–3 all
landed 2026-09-02, the hand-runs wait on the deploy. Source:
`docs/plan.md` Phase 2 (added 2026-09-01 with the E5 slice
2 decision) — the client is one scrolling document, accepted for the MVP; a
stimulus marked `own_page` renders inline until paging exists, and the flag
already rides the delivery bundle.

## What exists that this stands on

- **The page is one document.** `AssessmentPage.swift` builds every item
  into `#items` in bundle order: a `section.stimulus` before a set's first
  member, `div.item` (`.in-set` for members) per question, then the
  hand-in block (`buildFinish`). Nothing is paged, nothing is hidden.
- **The original intent is recorded** (`docs/stimulus-design.md`, "Delivery
  and layout"): `inline` — the stimulus pinned above its group, the group
  scrolls beneath; `own_page` — the stimulus is a page of its own and each
  item page repeats a collapsed reference to it; a question with no set is
  a set of one. The editor already offers "On its own page"; print already
  breaks the page there.
- **The page cannot persist anything** (`PageShell.swift`): a no-origin
  document, no `localStorage`, no cookies. Where the student is in the
  test lives in JS memory and is gone on relaunch.
- **The client never learns which questions already have a saved answer.**
  No field prefills from saved responses (E3 slice 3 confirmed the
  convention); the spool re-sends what was posted. So an "answered" mark
  can only come from posts made in this page's lifetime — or from the
  server, which knows the attempt's responses when it builds the bundle.
- **Nothing measures layout at build time.** The drawing canvas has fixed
  pixel dimensions and maps pointer positions at pointer time
  (`getBoundingClientRect` in `positionOf`), KaTeX renders without layout,
  and the peek captures whatever the view shows — hidden pages are safe.
- **Tests run the renderer in JavaScriptCore** (`RendererHarness`): a DOM
  shim with `createElement` / `appendChild` / `textContent` / attributes
  and handler properties; no `window.scrollTo`, no focus. Anything the
  paging code calls on `window` or `document` beyond that must be guarded.
- **The teacher-side settings tab** already carries per-assessment
  behaviour the client obeys (`allow_clipboard`, `time_limit_seconds`,
  accommodations); `allow_clipboard` is the pattern for a flag that rides
  the delivery bundle and is emitted only when set, so older bundles stay
  byte-stable and an older client falls to the safe default.

## Proposed shape

**A per-assessment setting, default off (D-1).** `assessments.student_layout
text not null default 'scroll' check in ('scroll', 'paged')` — migration
0027. The Settings tab gains *How students move through the test*: "One
scrolling page" / "One question at a time". `POST` / `PATCH
/api/assessments` validate it; the teacher export carries it beside
`allowed_accommodations` (import keeps it; older bundles read `scroll`).
The delivery bundle emits `layout: "paged"` only when set — absent means
scroll, so a client that predates the field renders as today. In `scroll`
mode the DOM the renderer builds is **byte-identical to today's**; every
existing renderer test keeps meaning what it means.

**What a page is (D-2).**

- A question with no set: one page.
- An `inline` set: **one page** — the stimulus at the top, its questions
  beneath, scrolling within the page (the original intent).
- An `own_page` set: the stimulus is a page of its own ("Passage for
  questions 4–6"), then **each member question is its own page** with a
  collapsed *Show the passage* disclosure above the question that expands
  the same stimulus in place (the original intent's "collapsed reference").
  The E12 writing area, when a set carries one, lives on the stimulus page
  and inside the disclosure — the same element, moved, not duplicated, so
  there is one `textarea` and one post path.
- A last page, *Review and hand in*: the question count, a numbered list
  of every question as jump links, and the existing hand-in block.

**Navigation (D-3).** A bar fixed to the bottom of the viewport: *Previous*,
a centred label ("Question 3 of 12", "Passage for questions 4–6", "Review
and hand in"), *Next*; under it a strip of numbered page buttons for
jumping (a passage page shows "P"). Buttons are real `<button>`s
(keyboard, VoiceOver); a page change scrolls to the top and moves focus to
the page's label, which is `aria-live="polite"` so the change is
announced. Cmd-arrow shortcuts are not added — AAC and the host own the
keyboard, and buttons are enough.

**Answered marks (D-4).** Not in the first cut. The page only knows what it
posted this session, and a student who relaunches mid-test would see every
question as unanswered on the review page — a mislead worse than no mark.
The honest version needs the server: the delivery route knows the
attempt's responses and emits `answered_item_ids`. **Built the same day as
the follow-up — see Progress.**

**Everything else is unchanged.** Responses post as they do today (the
page's lifetime is the same); the spool, hand-in, offline bundle, peek,
lockdown and the monitor are untouched; the print view already breaks at
`own_page`. The teacher preview stays one scrolling page — it is a
no-script document (ADR 0009) and is for reading the test, not driving it.

**Out of scope, v1.** Answered marks (above); resuming at the page the
student left (no storage in the page; a relaunch starts at page 1); a
timer on the bar (`time_limit_seconds` is not enforced by the client
today, and this slice does not start); forcing the order (Previous is
always available); the monitor showing the current question.

## Slices

1. **Design tool** — migration 0027 + `student_layout` on the row, API
   validation (create / patch), Settings tab control with the two labels,
   teacher export / import, delivery bundle `layout` emitted only when
   `paged`. Tests: assessments API accepts / rejects values, export round
   trip, delivery-api emits the field only when set, older bundle imports
   as scroll. Size S.
2. **Client** — `DeliveryBundle.layout` (absent / unknown → scroll);
   renderer: in `paged` mode wrap each page in `section.page`, one visible
   at a time (`hidden` attribute), the nav bar, the jump strip, the
   `own_page` disclosure, the review page, scroll-to-top and focus guarded
   for the harness; CSS. Tests (`RendererPagingTests`): scroll mode's tree
   is unchanged; paged mode builds N pages with the right membership for
   inline and own_page sets; only one page visible at a time; Previous /
   Next / jump move it and update the label; the disclosure holds the
   stimulus; the E12 writing area posts from inside the disclosure; the
   review page lists every question and carries the hand-in block; the
   fixture (which has an `own_page` set) drives most of it. `swift test`,
   `xcodebuild`. Size M. **Rides the same client rebuild as E12 and E3.**
3. **Hand-run rows** — design-tool rows (the setting, the bundle field) and
   client rows in `client/MANUAL-CHECKS.md` (one question at a time, the
   passage page and its disclosure, jumping, the review page, hand-in,
   offline bundle). Migration 0027 joins 0026 in the deploy's
   `migrate-aurora` step.

## Progress

**Slice 1 BUILT 2026-09-02 (local).** `assessments.student_layout` (text,
default `scroll`, CHECK scroll | paged) — **migration 0027**
(`0027_client_paging_student_layout.sql`, applied to dev and test DBs; joins
0026 in the deploy's `migrate-aurora` step). `StudentLayoutSchema` in
`packages/schema`; `ItemBundleSchema.student_layout?` and
`DeliveryBundleSchema.layout?`, both emitted only as `"paged"` so older
bundles stay byte-stable and absence reads as scroll. Create / patch
bodies validate it (default scroll on create); the Settings tab gains
*How students move through the test* (One scrolling page / One question
at a time) saved with the other metadata; export carries it when paged,
import reads it (absent → scroll); the delivery route emits `layout:
"paged"` only when set. Tests: assessments-api (default, create / patch
paged, `sideways` refused on both), delivery-api (absent by default,
present once the row says paged, parses), import-api (paged round-trips,
absent reads scroll, export emits only when paged), schema delivery test.
Full design-tool suite 1098 pass; schema 104; typecheck clean.

**Slice 2 BUILT 2026-09-02 (local).** The client.

- `DeliveryBundle.layout` (`scroll` | `paged`; absent or unknown → scroll).
- `AssessmentPage.swift`: `PAGED` is true only for an explicit `"paged"`.
  The scroll path builds the tree it always did (the item block factored
  into `itemBlock`, same output). `buildPaged`: `section.page` per page
  with a focusable `.page-label`; a standalone question = one page; an
  inline set = one page (stimulus on top, members beneath); an own_page
  set = a passage page then a page per member with a `<details
  class="passage-ref">` "Show the passage"; the passage block is **one
  element** seated on its page at build and moved into the open member's
  disclosure (and back) by `show(n)`, so an E12 writing area stays one
  textarea with one post path. A review page lists **every page but
  itself** — the questions and any passage page — as jump buttons above
  the hand-in block (the design said "every question"; the passage joined
  the list because a student reviewing wants to reach it too). The bar:
  Previous / `aria-live` label / Next, a strip of page buttons (question
  numbers, `2–3` for an inline set, `P` for a passage, `Review`),
  `aria-current` on the open one; `show` hides the rest with the `hidden`
  attribute, scrolls to the top and focuses the label (both guarded for
  the harness). CSS for pages, bar, strip, disclosure.
- Test harness: the DOM shim's `appendChild` now MOVES a node that already
  has a parent (real DOM semantics; `parentNode` tracked, fragments
  emptied) — the passage travel depends on it.
- Tests: `RendererPagingTests` (scroll and unknown values build no pages
  and no bar; paged builds 11 pages for the fixture in the right kinds and
  labels; only the first visible, bar state and strip; Next / Previous /
  jump; the passage travels and is never in two places; an inline set is
  one page with its stimulus on top; the review page lists ten and carries
  the one hand-in block; the E12 area still posts from inside the
  disclosure and exists once), `DeliveryBundleTests` (layout defaults to
  scroll, only `paged` pages). `swift test`: 324 pass; `xcodebuild … build`
  succeeds. Rows in `client/MANUAL-CHECKS.md` ("Client paging").

**Slice 3 WRITTEN 2026-09-02.** Hand-run rows 54–55 in
`docs/design-tool-manual-checks.md` (the setting survives reload, Publish /
Unpublish, export / import, an older file reads as scrolling; the bundle's
`layout` field) and the client rows in `client/MANUAL-CHECKS.md` ("Client
paging"). **Not run**: they need the deploy with the client rebuild.

**Hand-run 2026-09-03 (origin, rev 9): row 54 ✅** — the Settings choice
survives a reload, Publish / Unpublish work with the field in the PATCH,
export carries `paged` and a scrolling export has no key. Rows 55–56 and
the client rows wait on a student.

**Client hand-run 2026-09-03 (origin, rev 9, one student):** the passage
page first, the bar and strip, the disclosure, inline-set pages, the review
page and hand-in all as designed; a quit and relaunch rejoined the attempt
and the strip showed the server-fed checks (rows in `client/MANUAL-CHECKS.md`).

**P-1 DECIDED 2026-09-03 (James) — high-priority build, next:** the marks
were right but the fields under them were EMPTY, and the student read a
green check over an empty field as a lost answer and re-answered. The
"no prefill on resume" limit is not acceptable once marks exist. Build:
the delivery route sends the attempt's saved responses (their own
answers, not keys — ADR 0016 untouched) and each field type restores its
value on load; the client's answered set stays as is. Scope to write up
before the slice: which fields (all eight answerable types; drawing shows
its saved image as read-only or a "saved" state), and the E12 inline
outline already prefills from the bundle.

**What could still fail** (before the hand-run, none of it was verified): the bar and
the page flow are proven in the JavaScriptCore harness, not in WebKit
under lockdown — the `hidden` attribute, `<details>`, fixed positioning
under the host's window and focus movement are the WebKit-only parts; a
student who relaunches lands on page 1 (no storage in the page); the
review page has no answered marks (D-4).

**Follow-up BUILT 2026-09-02 (local): answered marks, server-fed.** The
D-4 follow-up, one slice.

- `DeliveryBundleSchema.answered_item_ids?` — the ids of THIS attempt's
  questions that hold a saved answer; per-student state, never a key.
  `buildDeliveryBundle` reads `responses` for the attempt, keeps only this
  assessment's items (an E12 outline written in place is keyed by another
  assessment's question and does not count), emits in item order and only
  when non-empty — a fresh attempt's bundle is unchanged.
- Client: `DeliveryBundle.answeredItemIds` (default `[]`). The page keeps
  `ANSWERED`, seeded from the bundle and marked by every `post()` and by a
  drawing the host reports saved. In paged mode the strip button reads
  "3 ✓" with class `answered` (green), `partial` (amber) for an inline
  set with some of its questions answered, `unanswered` otherwise, and its
  `aria-label` says so ("Question 3 of 9, answered", "Questions 2–3 of 9,
  1 of 2 answered"); the review page's count reads "k of N answered. Go
  back to any question, or hand in." and each jump reads "Question 4 ·
  not answered". Scroll mode never consults the field — its tree is still
  byte-identical.
- Marks are never cleared: "answered" means a response row exists, and
  the page has no delete path (clearing every checkbox posts nothing, by
  the standing rule).
- Tests: delivery-api (absent on a fresh attempt; exactly this attempt's
  answered questions in item order; another student's attempt on the same
  assessment does not leak in; parses), schema test, `DeliveryBundleTests`
  (default empty), `RendererAnsweredMarksTests` (seeded marks on strip /
  list / count with the passage unmarked; posting marks; a drawing marks
  only once saved; an inline set says "1 of 2"; scroll mode ignores the
  field). `swift test` 330 pass; `xcodebuild … build` succeeds; design-tool
  suite green. Row 56 + a client row added.

## Decisions (James, 2026-09-02 — all recommendations accepted)

- **D-1 a per-assessment setting, default scroll.** Versus paging always.
  Recommended: the setting — no behaviour change for anything published
  today, a short quiz can stay one page, and an older client falls to the
  safe default by construction.
- **D-2 what a page is.** As above: standalone = one page; inline set =
  one page with the stimulus on top; own_page set = a passage page then
  one page per question with the passage collapsed above it; a review
  page last. Recommended as stated (it is the original intent).
- **D-3 navigation.** Previous / label / Next plus a numbered jump strip,
  bottom-fixed, focus and announcement on change. Recommended as stated.
- **D-4 no answered marks in v1**, with the server-fed `answered_item_ids`
  as the recorded follow-up. Recommended: yes.
- **D-5 slice order.** Design tool first (S), client second (M), rows
  third; the client slice rides the pending rebuild. Recommended: yes.
