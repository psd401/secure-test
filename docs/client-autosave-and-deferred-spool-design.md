# Text autosave + deferred spool — design note (drafted 2026-09-16, for client v1.3.4, post-pilot)

**Status:** DECIDED 2026-09-16 (James: D-1 table cells in this slice,
D-2 30 s ceiling, offline autosave posts), nothing built. Roadmap row CS-2's client follow-up
(`docs/roadmap-2026-09.md`). Ships as **v1.3.4** together with the M-1
client half already on `main` (`dd8f32d`). Not before the pilot's first
week has run on v1.3.3.

## Problem

Two ways a student's typed words are lost today, both measured:

1. **Text posts only on leaving the field.** An essay or short-text answer
   reaches the server on the textarea's `change` event (blur, page turn,
   Finish — `AssessmentPage.swift`, `area.onchange`). A student who writes
   for 40 minutes without clicking elsewhere has NOTHING saved: a crash, a
   force-quit, Wi-Fi loss with a later crash, or a Mac going to sleep past
   the session all lose everything since the last blur. Drawings do not
   have this problem — they auto-save five seconds after the pen stops
   (`docs/drawing-tools-design.md` D-8) — text does. Side effects the pilot
   will see: the Monitor reads "0 of 1 answered" and, after ten minutes,
   **Idle**, for every student mid-essay (quick-start "looks wrong" bullets;
   CS-1).
2. **A refused write is gone.** The spool treats every 4xx except 408 / 429
   as permanent and deletes the row (`ResponseSpool.isPermanent`). Row CS's
   409 `sitting_closed` is one of them: the flush the client sends on its
   way home after Close was refused in the 2026-09-16 real-session run and
   the words were lost. The server now grants a 10 s write grace
   (`SITTING_CLOSE_GRACE_SECONDS`), which covers a Mac that is awake and
   online; a flush that lands later (asleep at Close, slow network, offline)
   is still dropped, even though the SAME attempt resumes through the next
   sitting and the write would then be accepted.

## Decisions (James, 2026-09-16 — every recommendation accepted)

- **D-1 Which fields auto-save.** Essay and short-text (including the E12
  inline outline and a table's cells — every free-text input that today
  posts on `change`). Choice-type items already post on click. **DECIDED:
  essay + short_text + inline outline + table cells, all in this slice.**
- **D-2 Cadence.** Idle-debounced like drawings, **but with a ceiling**: post
  5 s after the last keystroke, and in any case no later than 30 s after the
  first unsaved keystroke, so a student who never pauses is still saved
  twice a minute. A text post is one small JSON PUT (the drawing rule "every
  save is a full upload" does not apply), so the ceiling is cheap: 30
  students × 2 posts/min is nothing next to the 5 s peek poll. **DECIDED:
  5 s idle / 30 s ceiling.**
- **D-3 Unchanged post path.** The autosave calls the same `post(item.id,
  …)` the `change` handler calls, so the host's enqueue → flush → spool
  path, the answered-mark, the offline relabel and the withdraw path are
  untouched. An autosave whose text equals the last posted text is skipped
  (no-op saves would move "last activity" without a change). `change` still
  posts at once (blur beats the timer). **Recommend as stated.**
- **D-4 Answered mark.** Today any essay post marks the item answered, even
  empty text. Keep that: an autosave of a non-empty field marks answered;
  an autosave that empties the field (student deleted everything) posts the
  empty response as today and leaves the mark as `change` would. No new
  rule. **Recommend no change.** (Match's "answered only when every pair is
  set" stays match-only.)
- **D-5 Deferred spool entry.** `ResponseSpool` gains a third outcome
  beside sent / dropped: **deferred**. A 409 `sitting_closed` keeps its row
  (marked `deferred_at`), does not block the queue, and is retried at the
  next flush that follows a JOIN (the join route rebinds an in-progress
  attempt to the new sitting, so the retry passes). If the retry gets
  `attempt_submitted` (the teacher handed in meanwhile) or `time_expired`,
  the row is dropped as today — the teacher's hand-in captured the state
  they saw. A newer write to the same item replaces the deferred one (the
  spool is keyed on attempt + item, `ON CONFLICT` upsert, already true).
  **Recommend as stated.**
- **D-6 How long a deferred row lives.** The existing 24 h stale purge
  (`ResponseSpool.staleAfter`, hygiene slice) applies unchanged: a deferred
  row older than a day is purged at launch. A teacher who reopens the
  sitting the next morning is inside the window; a week later is not, and
  by then the teacher has handed in. **Recommend 24 h, no new constant.**
- **D-7 Row CS landing unchanged.** The client still ends the secure
  session on the first `sitting_closed` (poll or write) and shows the D-4
  sheet; the deferred entry is silent. "Your answers are saved." stays
  true for everything the server accepted, and now also for the deferred
  words once the student resumes. No new copy. **Recommend as stated.**

## Mechanism

**Page JS (`AssessmentPage.swift`).** A small `textAutosave(area, send)`
helper: `input` → mark dirty, (re)start the 5 s idle timer, start the 30 s
ceiling timer if not running; either timer → `flushNow()` = if dirty and
text ≠ last posted → `send()`; `change` → cancel timers + `send()` (as
today). The helper registers a flush hook like the drawings' so
`__secureTestFlushInput` (page turn / Finish / the CS return-home) flushes
text as well as blurring — blur already triggers `change`, so this is
belt-and-braces for a field that is dirty but not focused (a Cmd-Tab away
mid-timer). Offline mode (DECIDED): autosave posts as online; the host
relabels each post as ignored, as it does the `change` post today.

**Spool (`ResponseSpool.swift`).** `pending_responses` gains
`deferred_at INTEGER NULL` (migration in `open()`, additive). `flush`:
on 409 `sitting_closed` → `UPDATE … SET deferred_at = now` and `continue`
(not `remove`); `FlushResult` gains `deferred: Int`; `pending()` excludes
deferred rows unless `includeDeferred: true`. A new `flushDeferred(using:)`
(or a flag on `flush`) is what the host calls once after a join. `purge`
treats a deferred row like any other for the 24 h rule. `isPermanent`
unchanged for every other 4xx.

**Host (`AssessmentViewController` / `AppDelegate`).** After a successful
join / resume (the delivery bundle received), call the deferred flush once
before rendering the page — so the restored field (P-1 prefill) shows the
deferred text rather than the server's older copy. On `sitting_closed` the
controller already suppresses `responses_dropped`; `deferred > 0` logs one
line (`N answer(s) deferred until the next session`) and reports nothing.
Nothing changes in the return-home path.

**Server.** Nothing. (The 10 s grace stays; it covers the common case
without a client update.)

## Slices

1. **Autosave** (Opus, one commit): the JS helper wired to essay,
   short_text, inline outline (+ table cells if trivial); JSC-harness tests
   in `RendererMathPassTests`' style — timer fires after idle, ceiling
   fires under continuous input, no-op when unchanged, `change` cancels,
   flush hook posts a dirty field. `swift test`, both builds.
2. **Deferred spool** (Opus, one commit): `deferred_at`, flush semantics,
   `flushDeferred`, the host's post-join call, `FlushResult.deferred`;
   `ResponseSpoolTests` — 409 sitting_closed keeps the row, later write
   replaces it, `attempt_submitted` on retry drops it, purge after 24 h,
   `pending()` hides it. `swift test`, both builds.
3. **Rows + release** (Sonnet): `client/MANUAL-CHECKS.md` rows (below),
   `MARKETING_VERSION` 1.3.4, psd-sign 0.6.0, `gh release create` (James),
   next-day AutoPkg delivery, then the rows on the student device.

## Rows (to write in slice 3)

Autosave: type in an essay and stop → the Monitor shows the answer within
~5 s (no blur); type continuously for a minute → at least one save lands
(the ceiling); force-quit the app mid-essay (Debug: `SECURE_TEST_DEBUG_CRASH`)
→ Resume shows the text up to the last save (≤ 30 s lost); the word counter
and the answered mark behave as before; an unchanged field posts nothing
(server log). Deferred: Close the sitting while a student is mid-essay with
the Mac's network OFF → the sheet appears (the poll's 409 / next poll after
network returns) and the last words are NOT on the teacher page; open a new
session → Resume shows them and they appear on the teacher page (the
deferred flush); hand in from the Monitor before the student resumes → the
later resume drops the deferred row silently and the teacher's copy stands.
CS-1 / quick-start: the "Idle mid-essay" bullet can be retired once
autosave is on the fleet.

## Open questions

None — all three resolved 2026-09-16 (table cells in this slice; 30 s
ceiling; offline autosave posts).

## Progress

- 2026-09-16: drafted and decided the same day (James). Nothing built.
  Build after the pilot's first week on v1.3.3; slices 1 + 2 can run in
  parallel (disjoint files: page JS vs spool + host).
