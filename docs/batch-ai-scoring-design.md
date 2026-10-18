# Score a section's essays with AI in one press (U-24)

Design note, 2026-10-18. Trigger: an open-beta teacher asked whether she has
to open the scoring queue and press **Score with AI** on every essay, or can
send a whole section at once. Today she has to press it on each essay.
Decisions D-1…D-5 below. Nothing is built.

## What exists

- **Per-essay button** — "Score with AI" / "Re-run AI" on the queue's
  needs-manual and proposal cards (`app/dashboard/[id]/scoring/ScoringQueue.tsx`,
  `offersAiScoring`; R-4, 2026-09-14). It posts to
  `POST /api/responses/[responseId]/rescore-ai`, which **always** adds
  another proposal (re-run semantics) and returns 409 `injection_flagged`
  unless forced.
- **Per-attempt route with no caller** — `POST /api/attempts/[attemptId]/score-ai`
  (slice 38). Requires `edit` (`authorizeAttempt`) and a submitted attempt.
  Scores every AI / hybrid essay in that attempt **one after another**.
  An essay that already has any score row (proposed or final, research rows
  excluded) is **skipped**, and an essay with a prompt-injection alert is
  **withheld** (D-4 of `docs/safeguarding-alerts-design.md`). Returns
  counts: `scored_proposed`, `scored_final`, `already_scored`, `withheld`,
  `blocked`, `provider_errors`, `skipped_*`. No UI has ever called it.
- **Shared scorer** — `lib/scoring/aiScoreResponse.ts`. `ai` → proposal;
  `hybrid` → final at high confidence ("AI, not reviewed",
  `docs/hybrid-scoring-transparency-design.md` D-1), else proposal; never
  final on a flagged answer (D-13 there).
- **Section scoping** — Results takes `?section=`; the queue takes
  `?section=` too (hybrid transparency D-12).
- **Precedent for a section action** — "Hand in all in progress (n)" on
  Results under the section filter (`components/app/HandInInProgressControl.tsx`,
  U-14): a count in the label, a confirm dialog, a reload.
- **Limits** — the ALB idle timeout is 120 s (`infra/lib/app-service.ts:392`).
  Send to Google Docs runs 3 at a time (`lib/googleDocs/release.ts`). Measured
  cost: 1.38¢ per essay score (2026-10-03 cost work), so ≈ 40¢ for a section
  of 30.

## Proposal

**"Score essays with AI (n)"** under the section filter, beside Hand in all
in progress. *n* = handed-in AI / hybrid essays in the shown section with no
score row and no prompt-injection alert.

**The browser runs the batch, not the server.** It calls the existing
per-attempt `score-ai` route once per student with an unscored essay, at
most **3 at a time**. It shows "Scoring 12 of 28…" while it runs, then a
summary, then reloads.

Why the browser:

- Each request covers one student, usually one or two essays, so it stays
  well under the 120 s timeout. A single server request for a whole section
  (30 essays, one after another) would not.
- Progress and a partial result come for free. A failed student does not
  stop the rest.
- No job table, no worker, no migration. The server change is small (the
  count on the page, maybe nothing else).
- The cost: closing the tab stops the batch. Whatever finished is saved, and
  pressing the button again picks up the rest, because the route skips
  essays already scored.

**Summary copy** (one line each, only the non-zero ones):

- "24 essays scored — 18 waiting for your review in the scoring queue,
  6 finalized by AI (Hybrid)."
- "2 held back: they look like they try to instruct the AI. Read them in
  the scoring queue."
- "1 stopped by the AI safety filter — score it by hand."
- "1 couldn't be scored (the AI service didn't answer). Press the button
  again to retry."
- "3 have no rubric or are empty."

**Rules carried over unchanged:** `edit` level only (co-teachers at edit
included); handed-in work only; essays already proposed or final are
skipped (re-running one stays the per-essay Re-run AI); flagged answers are
never sent (only the per-essay "Score with AI anyway" sends one).

## Slices

1. **Count + button** (design tool). Server: the eligible count per section
   on the Results page (one query, reusing the queue's eligibility rule).
   Client: `ScoreSectionWithAiControl` — confirm dialog (count, "about 40¢
   in AI cost" not shown — D-4; disabled without a section — D-2), pool of 3 over `score-ai`, progress,
   summary, reload. A pure function for the label and the summary, tested
   like `handInInProgressLabel`.
2. **Rows** in `docs/design-tool-manual-checks.md`: a mixed section (AI,
   hybrid, an empty essay, a flagged essay, one already proposed); the count
   matches; the summary matches; press again → (0); a co-teacher at edit;
   view level sees no button; Bedrock run on the origin with timing.
3. **Docs**: help topic 8 (scoring queue) + FAQ "Do I have to score each
   essay with AI one at a time?", quick start, `/roadmap.html` milestone.

No migration, no client release.

## Decisions (James, 2026-10-18)

- **D-1** (1.1) The button sits on **Results, under the section filter**,
  beside Hand in all in progress. Not on the queue.
- **D-2** (1.2) **A section is required.** With no section chosen the
  button is disabled with the title "Choose a section first" — one press
  scores one class.
- **D-3** (1.3) **No automatic AI scoring on hand-in.** The button only;
  revisit if teachers ask for it after using the button.
- **D-4** (1.4) **No cost in the confirm dialog.**
- **D-5** (1.5) **3 students at a time.** Before the first full-class run on
  the origin, check the account's Bedrock request quota for the essay
  scorer's model (slice 2's timing row records it).

## Progress

- **Slice 1 BUILT 2026-10-18** (`18fcfec`): `lib/scoring/aiBatch.ts`
  (`aiBatchCounts`), `components/app/ScoreEssaysWithAiControl.tsx`, the
  Results page wiring. Not merged, not deployed.
- **Slice 2 RUN 2026-10-18 on local dev (`_demo`, mock scorer, mock
  screener):** rows 627–637 ✅ in `docs/design-tool-manual-checks.md`
  (637 with the demo co-teacher, not a second real account); row 638 (the
  origin with Bedrock, a full class, the quota check) NOT RUN. Fix U24-F1
  (the button is now the dialog's trigger, so focus returns to it) went in
  with the rows; reading U24-R1 ("held back" counts answers flagged before
  the press) needs no change.
- **Slice 3 WRITTEN 2026-10-18:** help topic 8 gains a step (Results →
  Section → Score essays with AI), "Looks wrong but isn't" gains "Do I have
  to press Score with AI on every essay?", the quick start's Scoring queue
  bullet gains one sentence, `/roadmap.html` gains a 2026-10-18 milestone
  (re-date it if the deploy lands later). Both pages' "Last updated" read
  2026-10-18. No picture re-captured: `results.png` predates the button
  (topic 9's picture, still accurate for what it shows).
