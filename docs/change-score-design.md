# Change a final score — correct in place, keep the old one as a record

Design note, 2026-09-28. Found while running the gradebook dialog rows
(`docs/design-tool-manual-checks.md` row 311): the manual score route
refuses a second final (`final_exists`) and nothing in the UI changes a
score once it is final — a teacher who spots a wrong score, or disagrees
with an auto / AI score, has no path but delete-attempt. Once scores reach
a gradebook (`docs/gradebook-push-design.md`) a correction must be possible
and must flow through the next send as an update (D-7 there).

## Decisions (James, 2026-09-28)

- **D-1** Correct in place (option A): a "Change score" action supersedes
  the current final and writes a new `final` human score — the pass-back
  pattern (`superseded` status, `docs/pass-back-design.md` D-2), not a
  return to the queue. *Rejected B: "Unscore" back to the queue — two
  steps, and the response reads "awaiting scoring" in between, so a send
  in that window holds the student back while the gradebook keeps the old
  number.*
- **D-2** Any final, whatever its method (auto, AI, human). An auto-scored
  multiple-choice cell has the same dead end today.
- **D-3** On the per-student results page AND the review queue card.

## What is built on

- `scores` is append-only: several rows per response, `final` enforced only
  by the score route's `final_exists` check (no unique index); `superseded`
  exists in the CHECK; `lib/scoring/supersededScores.ts` is the only reader
  of it and feeds the per-student page's "Earlier scores" section.
- Every other reader (matrix, CSV, print, work packet, queue, gradebook
  send) keys on `final`, so a new final is picked up everywhere with no
  change; the gradebook re-send reports it as "1 updated".
- `POST /api/responses/[responseId]/score` (`ManualScoreBody`: `points`,
  `max_points` = the item's max, optional `criterion_scores`, `note`).

## Design

- **Route**: `POST /api/responses/[responseId]/change-score` (edit level,
  the same access as scoring; 404 posture). Body = `ManualScoreBody` plus
  optional `reason` (≤ 500 chars). One transaction: the current `final`
  row → `superseded`; insert a new `final` `human` row with
  `rationale.note = reason`, `rationale.changed_from = { score_id, points,
  method }`; 409 `no_final` when the response has no final (use the score
  route); 409 `superseded_attempt` never — a passed-back attempt's
  responses have no final, so `no_final` covers it. Attempt event
  `score_changed` `{ response_id, item_id, from, to }` so the timeline shows
  it ("Score changed by teacher <time> · Q3 2 → 3").
- **Per-student page**: beside each final score, a "Change" control →
  dialog with the current points, a points input (0…max, same step rule as
  the queue), optional reason, **Save**. Reloads like the sibling controls.
  The "Earlier scores" heading becomes "Earlier scores" with a per-row
  cause ("before pass back" / "changed by teacher") — one column, no new
  reader: the cause is read off the new final's `rationale.changed_from`
  where present, else pass back.
- **Queue card**: a "Change score" link on a card whose response is final
  (the queue lists needs-manual and proposals today, so this is the
  per-attempt "scored" list the queue already renders for completed rows,
  if any — otherwise the card only on the per-student page and the queue
  half is a follow-up; the build slice reads the queue first and says
  which).
- **Gradebook**: nothing. The next send updates the row (D-7); the print
  report and CSV read the new final.

## Slices

| # | Slice | Side | Size | Model |
|---|---|---|---|---|
| 0 | This note + roadmap pointer | docs | XS | — |
| 1 | Route + transaction + event + timeline line + tests | design tool | S | Opus 5 / medium |
| 2 | Per-student page control + dialog; queue card link; Earlier-scores cause | design tool | S | Sonnet 5 / medium |
| 3 | Rows in `docs/design-tool-manual-checks.md` | docs | XS | Sonnet 5 / low |

**Migration 0047** (`attempt_events.kind` is a DB CHECK, so `score_changed` needs it — the note's first draft said none). Rides the held deploy with gradebook 0046.

## Open questions

- 4.1 Reason required or optional? — **optional** (James, 2026-09-28).
- 4.2 Should a change re-run the AI feedback (`with_feedback`) for the
  family print page? (Assumed no — the teacher's number stands, the AI
  rationale is superseded with the row.) — **no** (James, 2026-09-28).

## Progress

- 2026-09-28 — note written, D-1…D-3 decided; nothing built.
- 2026-09-28 — **slice 1 BUILT**: `POST /api/responses/[responseId]/change-score`
  (`ChangeScoreBody` = manual body + optional `reason` ≤ 500; the score
  route's max / rubric-bounds checks moved into the shared
  `checkManualScore` so the two routes cannot drift), `lib/api/changeScore.ts`
  (one transaction: the UPDATE `WHERE status = 'final' … RETURNING` IS the
  read — a racing second change flips nothing and answers `no_final`; the
  new row is `human`, `rationale.changed_from = { score_id, points, method,
  scorer }`, `note` = the reason; event `score_changed { response_id,
  item_id, from, to, max }`), **migration 0047** adds the kind to the
  CHECK (dev + test applied; staff-only — clients cannot post it),
  `supersededScores.ts` rows carry `cause: pass_back | changed` +
  `replaced_by`, timeline / print-integrity line "Score changed by teacher
  <time> · 2 → 3 of 4" (no Q number — the timeline has no item numbering;
  slice 2 may map `item_id`). Readings: a passed-back attempt still in
  progress answers 400 `attempt_not_submitted` from the shared chain, not
  `no_final`. Design-tool 2378 tests, typecheck clean.
- 2026-09-28 — **slice 2 BUILT**: `components/app/ChangeScoreControl.tsx`
  + `ChangeScoreAndReload` (a "Change" control beside every final score on
  the per-student page, any method; dialog "Now 2 of 4 · auto | AI | you",
  points input with the queue's step rule or the rubric's criterion
  pickers prefilled from the final's picks, optional Reason ≤ 500, Save →
  reload), `lib/scoring/changeScoreDialog.ts` (pure: `canChange`,
  `nowLine`, `pointsStep`, `parsePoints`, `changeScoreErrorMessage`,
  `causeLine`), "Earlier scores" (heading no longer says "before pass
  back") with a cause per row — "set aside by pass back" / "changed by
  teacher to N — <note>". **D-3's queue half is a FOLLOW-UP:** the queue
  lists only needs-manual + proposals (no scored list), so there is no card
  to put the link on. The timeline keeps "2 → 3 of 4" without a Q number
  (`buildTimeline` takes events only). Like Pass back, the control is not
  level-gated on the page — a view-level viewer gets "You cannot change
  this score." from the route. Design-tool 2386 tests, typecheck clean.

