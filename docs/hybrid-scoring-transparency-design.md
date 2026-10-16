# Hybrid scoring — say what it does, and show which scores no one reviewed

Design note, 2026-10-15. Roadmap finding HC-1 (`docs/roadmap-2026-09.md`,
"Findings from the help-page capture") recorded a mislabelled select. Reading
the code for this note found the label is the smallest part: **an AI score
that Hybrid finalized on its own is shown to the teacher as one they
approved.** Nothing is built.

## Decisions (James, 2026-10-15)

Option **C** (B plus the injection rule), every recommendation accepted:
- **D-1** (1.1) An AI final no teacher reviewed reads **"AI, not reviewed"**.
- **D-2** (1.2) An auto-finalized score still reaches students (instant
  feedback, Docs release, gradebook) as today: choosing Hybrid is the
  teacher's choice to let confident scores count.
- **D-3** (1.3) A third queue list, "Finalized by AI — not reviewed (n)",
  with Approve (marks it reviewed) and Change.
- **D-4** (1.4) "Score with AI anyway" on a flagged answer always writes a
  proposed score, whatever the method.
- **D-5** (1.5) Confidence stays on queue proposal cards only.
- **D-6** (4.1, 2026-10-16) An AI score approved by someone other than the
  viewer reads "AI, approved" (no name); "approved by you" only to the
  approver.
- **D-7** (4.2) Select label "Hybrid (AI finalizes confident scores)"; the
  hint under it carries the rest.
- **D-8** (4.3) The results CSV gains an `ai_not_reviewed` column.
- **D-9** (5.1, 2026-10-16) The matrix marks an unreviewed AI cell with
  `•` and a title.
- **D-10** (5.2) The queue's third list sits last, after Needs manual scoring.
- **D-11** (5.3) The existing approve route also marks a final AI score
  reviewed, in place.
- **D-12** (5.4) The scoring queue takes `?section=` like the results page.

## What the code does today

- **The rule** (`design-tool/lib/scoring/aiScoreResponse.ts:172–174`): `ai`
  always writes a `proposed` score; `hybrid` writes `final` when the model's
  self-reported confidence is ≥ `HYBRID_AUTO_FINALIZE_CONFIDENCE` (0.85,
  `lib/ai/essayScorer/scoreCore.ts:10`, one global value), otherwise
  `proposed`. Pinned by `test/essay-scorer.test.ts:425–463`.
- **What is stored**: both write `method: "ai"` (the CHECK allows only
  `auto | ai | human`, `db/schema.ts:1284–1287`) and `rationale.confidence`.
  The approve route sets `reviewed_by_sub`
  (`app/api/scores/[scoreId]/approve/route.ts:76`); an auto-finalized row
  leaves it null. **No UI or report reads `reviewed_by_sub`** — so the one
  field that tells the two apart is never shown.
- **How the teacher sees an auto-finalized score:**
  - Per-student page: "AI, approved by you" (`METHOD_WORD`,
    `app/dashboard/[id]/results/[attemptId]/page.tsx:67–71`) — **false**.
  - Work packet: "AI score (accepted)" (`lib/reporting/workPacket.ts:256–265`)
    — implies acceptance.
  - Results matrix: a plain `points/max`, same as every final.
  - Change dialog: "Now 3 of 4 · AI".
  - Scoring queue: the card simply disappears (the queue drops responses
    with a final; `rescore-ai` returns `{status: "final"}` but the queue
    ignores the body and refetches) — no message.
  - Confidence is shown only on a pending proposal card, raw ("confidence
    0.72"); never for a finalized one.
- **Where the methods are described:**
  - Editor select (`AssessmentEditor.tsx:394–399`): "AI (proposes a score,
    teacher approves)", **"Hybrid (AI + human review)"** — the HC-1 label.
    The only hint under it is about the rubric.
  - `public/help.html:414` — the one accurate description ("with Hybrid, a
    confident AI score becomes final on its own and the rest wait for you").
  - `docs/pilot-quick-start.md:227–230` — "Nothing reaches the student
    until you approve it." False for Hybrid.
  - `public/roadmap.html:350` — "AI proposes scores … for the teacher to
    accept or change", no Hybrid caveat.
- **Prompt injection**: "Score with AI anyway" (`force: true`) on an answer
  flagged as trying to manipulate the scorer still auto-finalizes under
  Hybrid at ≥ 0.85 — no review, on exactly the answer most likely to have
  inflated its own confidence.
- **Students and gradebook**: an auto-finalized score is final everywhere —
  instant feedback (score level), Google Docs release (approved scores
  only reads `final`), the gradebook send, the CSV.

## Options

**A. Words only (the original HC-1 proposal).** Relabel the select, add a
hint, fix the quick start and the roadmap page. Leaves the per-student page
and the packet saying "approved by you". Not enough on its own.

**B. Words + tell the truth where a score is shown (recommended).**
- Select: "Hybrid (AI finalizes confident scores; you review the rest)";
  hint under it when Hybrid is chosen: "AI scores it is confident about
  count at once. You can still change any score."
- A display rule, one helper used everywhere a final AI score is labelled:
  `reviewed_by_sub` set → "AI, approved by you"; null → **"AI, not
  reviewed"**. Per-student page, Change dialog ("· AI, not reviewed"),
  work packet heading ("AI score (not reviewed)" / "AI score (approved)").
- Results matrix: a small marker on a final cell whose AI score was never
  reviewed (e.g. a dot with the title "AI score, not reviewed"), and a
  count above the matrix: "N AI scores were finalized without review —
  Review them" linking to the queue.
- Queue: a third list, "Finalized by AI — not reviewed (n)", read-only
  cards with **Approve** (sets `reviewed_by_sub`, no new row) and
  **Change** (the existing change-score path). Approve keeps the score and
  marks it reviewed.
- Copy: quick start + roadmap page + help page wording aligned.
- Data: no migration — `reviewed_by_sub` already distinguishes the rows.
  Rows written before this change read as "not reviewed" when the scorer
  finalized them, which is true.

**C. B + close the injection gap.** "Score with AI anyway" always writes a
`proposed` score, whatever the method — a teacher who overrides the
withholding reviews that one answer. One condition in
`aiScoreResponse.ts`; recorded with the existing `recordAiForced`.

**D. Make the threshold a teacher setting.** Not recommended now: the 0.85
gate is uncalibrated self-reported confidence (`docs/scoring-model-eval-design.md`
has the corpus tooling to calibrate it), and a per-item number invites a
false sense of precision. Revisit after a corpus run.

## Recommendation

**C** (B plus the injection rule), in three slices:

1. **Truthful labels** — the shared helper (`lib/scoring/methodLabel.ts`),
   per-student page, Change dialog, work packet, select label + hint;
   tests for each string (none exist today for the select or
   "approved by you"). XS–S.
2. **Unreviewed list** — matrix marker + count, the queue's third list,
   Approve-a-final (a small route or the existing approve route accepting a
   `final` row with null `reviewed_by_sub`). S.
3. **Injection rule + copy** — forced scoring always proposes; quick start,
   roadmap page, help page. XS.

Design tool only; no client release; no migration.

## Progress

- **Slice 1 BUILT 2026-10-16, not committed, not deployed.**
  `lib/scoring/methodLabel.ts` (`isAiUnreviewed`, `finalMethodWord`) on the
  per-student page's final line and "Earlier scores" (`supersededScores`
  now carries `reviewed_by_sub`); the Change dialog's `nowLine` reads
  "· AI, not reviewed" / "· AI, approved"; the work packet heads a final AI
  row "AI score (not reviewed)" / "AI score (approved)"; the editor's Hybrid
  label + `HYBRID_HINT` when Hybrid is chosen; `ResultsRow.ai_unreviewed_count`
  and the CSV's last column `ai_not_reviewed` (appended after `unscored` so
  earlier columns keep their positions). Tests: `test/hybrid-labels.test.ts`,
  `nowLine`, `packetScoreHeading`, the golden CSV + a count case in
  `test/results.test.ts`. "scored by you" on a co-teacher's human score is
  unchanged (out of scope). Not hand-run.

- **Slice 2 BUILT 2026-10-16, not committed, not deployed.**
  `ResultsCell.ai_unreviewed` (only when true); the matrix cell reads
  `3/4 •` with "AI score, not reviewed (counted)"; a line above the matrix
  ("N AI scores were finalized without review — Review them", the link at
  edit level only) over the rows the section filter shows.
  `POST /api/scores/[scoreId]/approve` on a final `ai` row sets
  `reviewed_by_sub` in place (200, no new row; a second press returns the
  row). The review-queue route returns `unreviewed` (each card + `final`),
  takes `?section=` (labels from `buildResults`, so the queue and the matrix
  agree) and returns `sections`; `lib/scoring/sectionFilter.ts` holds the
  rule both pages use. The queue page: a Section select kept in the address
  bar, the "Finalized by AI — not reviewed (n)" list last with Approve and
  Change (`ChangeScoreControl`), no confidence on those cards. Tests:
  `test/review-queue.test.ts` (5 cases), `test/results.test.ts`,
  `test/hybrid-labels.test.ts`. Readings: the queue now reads results once
  more per load (the price of one section rule); approving a final writes
  no timeline event, like approving a proposal. Not hand-run.

## Open questions — answered 2026-10-15 (see Decisions)

- 1.1 Wording: "AI, not reviewed" vs "AI, finalized automatically"?
- 1.2 Should an auto-finalized score reach students (instant feedback,
  Docs release) before anyone reviews it — keep as is, or hold it from
  student-facing views until approved?
- 1.3 Third queue list, or only the matrix count + filter?
- 1.4 Injection rule (option C) — agreed?
- 1.5 Show confidence on finalized scores (per-student page), or keep it
  queue-only?
