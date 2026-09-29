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

No migration. Rides the held deploy with gradebook 0046.

## Open questions

- 4.1 Reason required or optional? (Assumed optional.)
- 4.2 Should a change re-run the AI feedback (`with_feedback`) for the
  family print page? (Assumed no — the teacher's number stands, the AI
  rationale is superseded with the row.)

## Progress

- 2026-09-28 — note written, D-1…D-3 decided; nothing built.
