# Rescore with the current key (roadmap E11)

Status: scoped 2026-10-08, nothing built.

## Trigger

Open-beta teacher, 2026-10-08: a multiple-choice key was wrong when
students handed in. The teacher fixed the key afterwards, but the
students' scores stayed wrong, and there was no way to regrade.

How it works today:

- A key-only edit on a Published item is allowed
  (`isAnswerKeyOnlyPatch`, item PATCH route). It changes the key for
  hand-ins from then on.
- Auto-scored items are scored at hand-in (`runAutoScoringPass`, from
  the submit route and `handInAttempt`). The score is written as
  `final`.
- The pass skips any response that already has a final
  (`lib/scoring/runAutoScoring.ts`), so a key change never reaches work
  already handed in. `POST /api/attempts/[id]/score` re-runs the same
  pass, but no button calls it, and it would skip those responses
  anyway.
- The only fix today is **Change** on each affected cell (U-10,
  `docs/change-score-design.md`): one change per student per question.

## Decisions (James, 2026-10-08)

- **D-1** A "Rescore with the current key" button for the whole
  test, **active only when the current keys would change at least one
  handed-in score** (James, 6.2). Rescoring never happens on its own
  when a key changes, because one accidental key edit would silently
  change grades.
- **D-4** The button lives on the **Results** page — where a teacher
  notices wrong scores — and the editor points to it after a key edit
  (James asked 6.1; the first draft had an editor-only per-item button).
- **D-2** A teacher's own number stays. Only finals with
  `method = auto` are rescored. A score the teacher changed or entered
  (`human`), and an approved AI score, are left alone and counted as
  "kept".
- **D-3** A rescored student's gradebook grade is flagged. The Send to
  gradebook dialog says how many scores in each section changed since
  that section's last send, and the rescore result tells the teacher to
  send again.

## Design

### What a rescore does (per auto-scored item)

"Active only when a key changed" is computed, not tracked: scores do not
record the key they were scored against, so the page runs the same pure
plan as the rescore over every auto-scored item and counts the responses
whose score would differ. A key edited and then edited back shows
nothing, which is the point. `buildResults` already loads every
response and item for the page, and `scoreResponse` is pure, so this is
an in-memory pass with no extra query.

For every response to an auto-scored item on a **handed-in** attempt (in-progress
attempts are scored at their own hand-in, against the current key
already):

| Current state of the response | Rescore |
|---|---|
| Final `auto`, new score differs | Supersede it, write a new `final` `auto` row |
| Final `auto`, new score equal | Nothing (counted "unchanged") |
| Final `human` / `ai` (D-2) | Nothing (counted "kept") |
| No final, now scorable (was keyless) | Write a `final` `auto` row, as at hand-in |
| No final, still unscorable | Nothing (counted "unscorable") |

- The same pattern as Change score (`lib/api/changeScore.ts`): in one
  transaction per response, flip `status = 'final'` → `superseded`
  with `RETURNING` (the flip is the read, so a concurrent Change cannot
  leave two finals), insert the new row with
  `rationale.changed_from = {score_id, points, method, scorer}` and
  `rationale.rescored = true`, and write a `score_changed` attempt event
  with `detail.source = "rescore"`. No migration: the event kind exists
  and `detail` is jsonb.
- A response whose final changed between the dry run and the confirm
  (the teacher pressed Change in another tab) is skipped, not
  overwritten — the flip's `WHERE method = 'auto'` sees to it.
- `supersededScores.ts` reports the cause as `"rescored"` when the
  replacing row carries `rationale.rescored`. "Earlier scores" on the
  per-student page reads "Rescored with the updated key · 0 → 1 of 1".
  The timeline line is "Rescored with the updated key <time> · 0 → 1".
- Scoring uses the same `scoreResponse` as hand-in, so every
  auto-scorable type works (MC single / multi, short text with numeric
  equivalence, match, order, hotspot, table, fill in the blank), not
  only MC.

### Route

`POST /api/assessments/[id]/rescore`, level `edit`.
Body `{ dry_run: boolean }`.

- `dry_run: true` returns the counts and writes nothing:
  `{ changed, unchanged, kept, newly_scored, unscorable, students_changed,
  questions: [{ item_id, label, changed, kept }] }` (only questions with
  a change).
- `dry_run: false` does the writes and returns the same counts plus
  `sections_sent_before: [label]` — sections with a live
  gradebook push that contain a changed student.
- 409 `nothing_to_rescore` when no score would change (the button was
  stale); 404 outside the caller's access.
- Log line `assessment_rescored {assessment_id, changed, kept,
  questions}` at info.

### Results page

In the toolbar beside Print student work / Send to gradebook, at edit
level:

- "Rescore with current key (12)" — the count is students whose score
  would change. **Disabled with "(0)" and the title "Every handed-in
  answer matches the current keys"** when nothing would change; hidden
  while no attempt is handed in.
- Press → dry run → a dialog listing the questions: "Q3 — 12 students
  change · Q7 — 2 students change. 3 scores you set yourself stay as
  they are." → **Rescore** / Cancel.
- After the write the page reloads with the new scores and a line:
  "Rescored 12 students · <time>". When `sections_sent_before` is not
  empty it adds: "Period 2 and Period 4 were already sent to
  PowerSchool — send them again to update." with the Send to gradebook
  button beside it.
- The section filter does not narrow the rescore: a key is the same for
  every section.

### Editor

After a key-only save on a Published auto-scored item with handed-in
responses, the card shows "Students who handed in were scored with the
old key. Rescore from Results." with a link. No button in the editor:
one place to rescore, and that place shows the counts.

The teacher's original slip (fix typed but not saved) is covered by
the button being computed from the SAVED key: an unsaved fix shows
"(0)" on Results, and the editor already marks the card unsaved.

### Gradebook flag (D-3)

`loadSendDialogSections` compares each section's current totals with
`gradebook_push_scores` (what each attempt last sent) and returns
`changed_since_send: number`. The dialog's "Already sent on …" line
gains "· 12 scores changed since then". Any change counts, not only a
rescore — Change score and pass back have the same gap today. This is
a read the Send-again path already does (D-7 skips unchanged rows); it
moves into the dialog.

### What does not change

- **Students who saw instant feedback** saw the old score at hand-in.
  That screen is shown once and is not re-shown. Released answers show
  the key on the next view, which is now the corrected one. Recorded as
  a reading; nothing to build.
- **Class insights** reports already generated keep their old numbers
  (they are stored). A new report reads the rescored finals.
- **Answers released / feedback text** are untouched.

## Slices

1. **Server** — `lib/scoring/rescore.ts` (pure plan over every
   auto-scored item + transactional apply), the plan's count on
   `buildResults`, the route, the `"rescored"` cause in
   `supersededScores.ts`, timeline wording, tests (each table row
   above, the concurrent-Change skip, a key edited and reverted counts
   0, `nothing_to_rescore`, access 404 for a view-level caller).
2. **UI** — the Results button + dialog + result line, the editor's
   pointer after a key save, the Send dialog's `changed_since_send`.
3. **Rows + docs** — hand-run rows in
   `docs/design-tool-manual-checks.md`, the help page (topic on scoring:
   "Fixed a key after students handed in?") + FAQ, quick start,
   `/roadmap.html` entry.

Design-tool only. No client release, no migration.

## Progress

- 2026-10-08 — scoped; D-1…D-4 decided (6.1 / 6.2 answered by James:
  a test-level button on Results, active only when a key change would
  change a score).
