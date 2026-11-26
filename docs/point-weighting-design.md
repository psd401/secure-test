# Point weighting — design note (2026-11-17, decided 2026-11-18)

Status: decisions made (James, 2026-11-18; see "Decisions"). Slices 1–4 built 2026-11-25 (see "Progress"); not merged or deployed.

## Goal

- A teacher sets how many points each question is worth.
- Partial-credit items scale their parts proportionally (James, 2026-11-17): a table worth 6 with 4 keyed cells gives 1.5 per cell.
- Every total that already sums `max_points` (results, CSV, gradebook, insights, student feedback) follows without its own change.

## Non-goals

- Per-part weights (cell 1 worth 2, cell 2 worth 1).
- Section or category weighting, percent-of-grade weighting.
- Showing points to students during the test (D4: never during the test).
- Per-criterion weights inside a rubric (a rubric item scales as a whole).

## Data model

- New column `items.points doublePrecision NULL`, CHECK `points IS NULL OR (points > 0 AND points <= 100)`.
- `NULL` = today's natural maximum. No backfill. Every existing item, score and test keeps its numbers.
- Why nullable, not a stored copy of today's max: a table's natural max moves when a cell key is added. `NULL` keeps following it, as it does now.
- Migration: next number after `0072_competency_assignments.sql` (`design-tool/db/migrations/`), via `bun run db:generate`. Additive, no lock concern.
- Schema: `db/schema.ts` `items` table.

## One function for the maximum

Today the item maximum is computed in three places, which must agree:

- `itemMaxPoints` — `design-tool/lib/scoring/results.ts:182`
- `checkManualScore` expectedMax — `design-tool/lib/api/reviewActions.ts:149`
- review-queue `max_points` — `design-tool/app/api/assessments/[id]/review-queue/route.ts:303`

Plan:

- Add `naturalMaxPoints(item)` (today's rule: rubric max, keyed cells, keyed blanks, graph objects, else 1).
- `itemMaxPoints(item)` = `item.points ?? naturalMaxPoints(item)`, rubric items included (D1).
- The other two call `itemMaxPoints`. This removes a drift risk that exists today.

## How each type scales

Scale in one place: `scoreResponse` in `design-tool/lib/scoring/auto.ts` (lines ~460–575) keeps computing natural `{points, max}`, then a final step returns `points × (weight / natural)`, `max_points = weight`. Callers (`runAutoScoringPass`, `planRescore`, `lib/preview/interactive/score.ts`) get weighted scores with no change.

| Type | Natural max | Weighted |
|---|---|---|
| MC single/multi, short text (auto), match, order, hotspot | 1, all or nothing | 0 or `points` |
| Table | 1 per keyed cell | `points / keyed cells` per cell |
| Fill in the blank | 1 per keyed blank | `points / keyed blanks` per blank |
| Graph, per object | 1 per key object | `points / key objects` per object |
| Graph, all or nothing | 1 | 0 or `points` |
| Human, no rubric (drawing upload, essay without rubric, human table/blank) | as today | teacher enters 0..`points` |
| Essay, AI short answer (rubric) | rubric max | rubric total × `points / rubric max` (below) |

### Rubric items (D1: teachers can scale them)

A rubric item scales as a whole: an essay with an 8-point rubric set to 4 points scores `rubric total × 4/8`.

- **Criterion scores stay in rubric points.** `criterion_scores`, the AI scorer's output, `validateAgainstRubric` and the printed rubric table are unchanged. Only the item's final `points` / `max_points` are scaled.
- **One helper**, `scaleRubricTotal(total, rubric, item)`, applied wherever a rubric final is written:
  - AI scoring: `lib/scoring/aiScoreResponse.ts`
  - human rubric scoring: `app/api/responses/[responseId]/score/route.ts`
  - change score and AI approval: `lib/api/changeScore.ts`, `lib/api/reviewActions.ts`
- **Display:** where a rubric's levels are shown beside the total (`lib/reporting/rubricScoreView.ts`, the attempt page, released feedback), show both: "Rubric 6 / 8 → 3 / 4 points".
- **AI-vs-human comparisons** (`lib/reporting/runComparison.ts`, `lib/scoring/corpus.ts`): compare in rubric points (criterion scores), not scaled finals, so a points change between two runs can't fake a disagreement. Check each when building.
- **Competency pass rule** reads criterion points only, and D6 blocks `points` on competency assessments, so it cannot be affected.

## Rounding

- Teacher value: up to 2 decimals, > 0, ≤ 100.
- Stored score: `round(points × weight / natural, 2)`. Full credit is always exactly `weight`, so the `points <= max_points` DB check holds.
- Example: 1 of 3 cells on a 1-point table = 0.33.
- Totals sum stored values; `percent` is already rounded in `buildResults`.
- The client already formats decimals (`InstantFeedback.swift` `points()`: "1.5", "0.33"). No client change.
- Manual entry step: two copies use 1 or 0.5 — `pointsStep` (`lib/scoring/changeScoreDialog.ts:47`) and an inline `max > 1 ? 1 : 0.5` in `app/dashboard/[id]/scoring/ScoringQueue.tsx:1037`. Change both to 0.01 or 0.5 when `max` is not a whole number (or have the queue call `pointsStep`).
- Rescale (D2): `round(points × new / old, 2)`, computed from the score's stored fraction of its old max each time, and full credit stays exactly the new max — so repeated points changes cannot drift.

## Authoring UI

- Field "Points" next to Scoring method in `app/dashboard/[id]/AssessmentEditor.tsx` (~line 2075). Number input, placeholder = natural max.
- Hint under it for partial-credit types: "Worth 6 · 1.5 per keyed cell". Updates as keys change.
- Rubric items: the same field; the hint reads "Rubric is out of 8 · scaled to 4". Hidden on competency assessments (D6).
- Outline rail (`OutlineRail.tsx`): each row gets a "· 2 pts" suffix; the rail header shows the test total. Same `itemMaxPoints` rule, run on `ItemView`.
- Item create/update body: `lib/api/items.ts` (`CreateItemBody` / update body) accepts `points`.

## Changing points after students are scored

- Auto finals: `planRescore` (`lib/scoring/rescore.ts:154`) already compares `max_points`. A points change makes every auto final on that item "changed", so the existing **Rescore with current key** button (`components/app/RescoreControl.tsx`, route `app/api/assessments/[id]/rescore/route.ts`) turns on and fixes them. No new path.
- After a points save on an item with scores, show a notice that points to Rescore.
- Gap: non-auto finals (human, AI, approved) are "kept" by rescore. Their `max_points` would then differ from the item max, and the row total would mix old and new maxima.
- Decided (D2): in `applyRescore`, rescale non-auto finals on a points-changed item proportionally (`points × new/old`), keeping method, scorer and `reviewed_by_sub`, with `rationale.rescaled_from`. Teacher judgment (the fraction) is kept. This now includes rubric items (D1); their criterion scores are untouched.

## Published tests

- Decided (D7): points editable while published, like keys and standards. They never reach the delivery bundle, so nothing mid-test changes.
- `points` is its own column, so `isAnswerKeyOnlyPatch` (`lib/api/requireDraft.ts:61`) should pass it the same way it passes `standards`. Confirm with a test.
- Update the lock banner (`AssessmentEditor.tsx:1451`): "Answer keys, points and standards can still be changed".

## Bundles (ADR 0016)

- `ItemBundleSchema`: add optional `points` in `packages/schema/src/items.ts` (~line 62). Emit only when set (`lib/api/exportBundle.ts:92` pattern), so old bundles stay byte-stable. Import (`lib/api/importBundle.ts`) clamps or drops an out-of-range value and counts it, like `scoring_methods_dropped`.
- `DeliveryBundleSchema`: no change. Points are not a key, but the client does not show them during the test. Students see points only after hand-in, through instant feedback, which reads finals.

## Results, reports, insights

These read `final.max_points` or `itemMaxPoints`. They follow with no logic change:

- `buildResults` and `resultsToCsv` (`lib/scoring/results.ts`)
- analytics (`lib/reporting/analytics.ts`), print and work packet
- `buildFeedback` (`lib/feedback/buildFeedback.ts:321`)
- class insights evidence pack (`lib/insights/evidencePack.ts:305, 709`)

Wording that assumes 1 point per part goes stale once points are set; grep for "1 point each" before shipping. Known so far:

- `lib/reporting/fillBlankView.ts:102, 106` — hand-scored blanks "(1 point each)"; becomes the per-blank share.
- the insights prompt (`lib/insights/`), if it describes items as 1 point each.

## PowerSchool

- The assignment max is the results row `max_points` (`lib/gradebook/mapping.ts:149`). It is set only on **create** (`sendPowerSchool.ts:341`, `buildAssignmentCreateBody`).
- Gap: a Send again after a points change writes new scores against the old PowerSchool max. The same gap exists today when a key adds table cells.
- Decided (D3): on a Send again, compare the max and add a note: "This test is now worth N points; update the assignment in PowerTeacher Pro". No automatic update.

## Competency assessments

- Decided (D6): refuse `points` on items in a competency assessment (`competency_pass_min_points IS NOT NULL`). The API rejects it and the editor hides the field.
- The pass rule reads rubric criterion points only, so it is unaffected either way.

## Tests to add

- `scoring-auto.test.ts`: each type at weight 1, 4 and 6; 1/3 rounding; full credit = exactly `weight`; `points NULL` = today's numbers.
- `results.test.ts`: totals and CSV with mixed weights.
- `review-queue.test.ts`, `change-score.test.ts`: `max_points_mismatch` uses the weighted max; the queue reports it.
- `rescore.test.ts`: a points change marks auto finals changed; human, AI and rubric finals rescale proportionally.
- `items-api.test.ts`: range checks (D5); competency item refuses `points` (D6); published PATCH with only `points` passes the lock.
- Rubric scaling: AI and human rubric finals scaled; criterion scores unchanged; comparisons use rubric points.
- Bundle round-trip with and without `points`; `packages/schema/test/delivery.test.ts` unchanged.
- `gradebook-send.test.ts`: max-changed note on Send again.

## Slices

1. **Model + scoring** — column, migration, `naturalMaxPoints`/`itemMaxPoints`, the three max sites merged, scaling in `scoreResponse` and `scaleRubricTotal`, API field (D5 range, D6 refusal), rounding, tests. No UI; `NULL` everywhere means no visible change.
2. **Editor** — Points field, hint, outline suffix and total, published-lock pass, banner copy, manual-entry step.
3. **After-score changes** — rescore notice, non-auto rescale in `applyRescore`, PowerSchool max note.
4. **Bundle** — `ItemBundleSchema.points`, export/import, round-trip test. Small; could ride with slice 2.

## Decisions (James, 2026-11-18)

- **D1** Rubric items: teachers can scale them (whole rubric, proportionally).
- **D2** Points change on an item with human or AI finals: rescale them proportionally.
- **D3** PowerSchool after a points change: a note to the teacher only.
- **D4** Points are never shown to students during the test. No delivery or client change.
- **D5** Allowed values: more than 0, at most 100, up to 2 decimals.
- **D6** Points are blocked on competency assessments.
- **D7** Points stay editable while a test is published, like answer keys and standards.

## Progress

- **2026-11-25, slice 1 + 4** (PR #235): column + migration 0073, `applyWeight` in `scoreResponse`, one max rule (`entryMaxPoints` for hand entry), rubric totals scaled on write (`scaleEntry`), AI-vs-human comparison on the rubric scale, API field (D5/D6/D7), teacher bundle carries `points` (so Duplicate / Share keep it). Review fix: the interactive preview scores on the weight; `points` is required on max-point inputs.
- **2026-11-25, slice 2** (PR #236): Points field + hint, outline per-question points and total, published-lock door, `pointsStep` "any" above 1, "an equal share each" copy, help topic 2. The max rules moved to client-safe `lib/scoring/maxPoints.ts`.
- **2026-11-25, slice 3** (stacked on #236): `planRescore` rescales any non-auto final whose `max_points` is not the question's current maximum (`rescaled`, kept fraction, `rationale.rescaled_from`, method / scorer / reviewer kept, event `source: "rescale"`); the Rescore dialog names them; approve puts a stale AI proposal on the current points; the editor pointer fires on a points change; PowerSchool Send again notes a changed maximum against `last_result.assignment_max_points` (recorded at create; pushes created earlier have none and get no note); help "Fixed an answer key or changed points".
- **Rescale scope (measured 2026-11-25; kept as built):** the rescale fires on ANY non-auto final whose `max_points` is not the question's current maximum, not only after a points change, because nothing records why a maximum moved. Production before B1, two read-only aggregate queries (James): 0 of 251 questions with finals on mixed maxima, and 0 of 1091 teacher-set / AI finals off the question's current natural maximum (rubric, table, fill-in-the-blank rebuilt from config; 0 graph finals). So the rescale touches nothing from before B1. Later drift needs an unpublish: the publish lock refuses a rubric or table edit on a published test (`isAnswerKeyOnlyPatch` compares `config` apart from the key fields). If it happens, rescaling keeps the question's total on one scale; the alternative (leave the old maximum) is the mixed-scale totals D2 exists to prevent. A rescaled rubric total no longer equals its criterion sum, the same as any weighted rubric item (D1).
- **Open:** none in the design. (The rubric display shipped in #240 as "Rubric 5 of 8, scaled to 2.5 of 4 points", in words because a screen reader reads an arrow aloud.) Still to check by hand: a teacher's weighted test on production, and weighted instant feedback at the next client release's hand-run.
- **2026-11-25, D6 the other way round:** `PUT /api/assessments/:id/competency` (no UI; Assessment staff) answers 409 `items_have_points` with the question numbers while any question has a weight, and changes nothing. Clearing the weights lets it through. Both sides decide under the assessment's row lock (`lib/api/competencyLock.ts`): the conversion, and the item POST / PATCH when they write a weight, so a conversion and a concurrent weighted save cannot both commit (#245 review; tested by holding a conversion open while a weighted save waits).
- **2026-11-25, import warning:** a bundle weight outside D5 still imports at the natural maximum, and is now counted: the import preview warns "N questions' points aren't between 0 and 100 with at most two decimals. They will be worth the usual points for the type; set them again in the editor." (`points_dropped`), and `POST /api/assessments/import` reports `points_dropped`. Duplicate and Share never hit it (their weights come from the database, already valid).
