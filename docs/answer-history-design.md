# Answer history — earlier versions of a student's text answer

Design note, 2026-10-06. Roadmap row U-19.

**Trigger.** A beta teacher asked whether they could see a student's
"version history": the student had emptied his essay by accident. The
answer was no. A `responses` row holds one value per (attempt, item); every
autosave overwrites it (`onConflictDoUpdate` in
`app/api/attempts/[attemptId]/responses/[itemId]/route.ts`) and "Clear
answer" deletes it. Read-only Aurora showed the essay saved as empty at
7:42:56 PT and handed in 53 s later. The only way back was a manual Aurora
point-in-time restore (one-day backup window, ~20 min, whole database).

## Decisions (James, 2026-10-06)

- **D-1** Keep a history in the app, not an automated point-in-time
  restore. *Rejected: automating PITR — one-day window, ~20 min per
  request, restores the whole database, needs restore permissions in the
  app. Rejected: email — student writing leaves the app (the safeguarding
  email carries no student text for the same reason).*
- **D-2** Capture rule: the PREVIOUS value of a text answer is copied into
  history at most once a minute per answer, and ALWAYS when the new value is
  much shorter (under half the old length, empty included) or the answer is
  withdrawn. "That's enough" — not every save.
- **D-3** Retention: 30 days after hand-in, by the nightly sweep. In-progress
  attempts keep theirs. Deleting the attempt deletes them (FK cascade).
- **D-4** Who sees it: edit level and above on the assessment.
- **D-5** History holds text safeguarding never screened (only the
  handed-in answer is screened). Accepted: the teacher may see it.
- **D-6** Aurora backup retention stays at 1 day.
- **D-7** Slices: (1) capture + view / copy, (2) restore (with pass back).

## Scope

Text answers only: `essay`, `short_text`, `table` (length = the sum of the
cell lengths). Choice / match / order / hotspot answers are one click to
redo; drawings would need the superseded files kept
(`pruneSupersededUploads` deletes them today) — later, if asked.

## Design

### Slice 1 — capture + view (server + teacher page; no client release)

- **Table `response_revisions`** (migration 0058): `id`, `attempt_id`
  (FK → attempts, cascade), `item_id` (FK → items, cascade), `response`
  jsonb (the value as it was), `saved_at` (that value's `updated_at` — when
  the student last saved it, the time the teacher reads), `captured_at`,
  `reason` (`interval` | `shrink` | `withdrawn`, CHECK). Index on
  (attempt_id, item_id, captured_at).
- **Capture** in the student PUT and DELETE, `lib/api/answerHistory.ts`:
  read the current row; if its value differs from the new one, insert the
  old value when (a) the new length is under half the old length, or (b) the
  newest revision for this answer was captured 60 s or more ago (or there is
  none). DELETE of a non-empty text answer always captures (`withdrawn`).
  Same transaction as the write. A blank old value is never captured.
- **View** on the per-student results page, under each text answer that has
  history: a collapsed "Earlier versions (n)" list, newest first, each with
  the time it was saved, the word count (cells for a table), why it was kept
  ("before a large deletion", "before the answer was cleared", or nothing
  for the once-a-minute copy), the text, and a Copy button. Only at edit
  level (D-4); an admin reading through the All-teachers view sees it too
  (admin is above edit). The Monitor's student rows already link here.
- **Sweep**: `sweepAnswerHistory` in `lib/retention/sweep.ts` — delete
  revisions whose attempt was handed in more than 30 days ago; called from
  the roster-sync Lambda beside the other sweeps, best-effort.

### Slice 2 — restore (designed now, built after slice 1 is checked)

- "Restore this version" beside each revision, edit level. Route
  `POST /api/responses/[responseId]/restore` with the revision id.
- Allowed only when no client can overwrite it: the attempt is handed in,
  or no open sitting holds it. Refused 409 `session_open` otherwise.
- The current value is captured first (reason `restored`), then the
  revision's value written. On a handed-in attempt the response's scores are
  superseded (pass-back pattern) and the dialog offers Pass back so the
  student can keep working; on resume the prefill (P-1) shows the restored
  text. Timeline event `answer_restored`.
- Open for slice 2: re-run auto-scoring for a restored short text on a
  handed-in attempt, or leave it unscored for the teacher?

## Size

Worst case one revision a minute per text answer while typing: ~60 rows per
essay-hour, a few MB per class session at essay sizes. Swept at 30 days.

## Slices

| # | Slice | Side | Size |
|---|---|---|---|
| 0 | This note + roadmap row | docs | XS |
| 1 | Migration 0058, capture, per-student view, sweep, tests, rows | design tool | S |
| 2 | Restore + pass back | design tool | S |

## Progress

- 2026-10-06: note written, D-1…D-7 decided.
- 2026-10-06: **slice 1 BUILT, not deployed.** Migration 0058
  `response_revisions` (the CHECK already allows `restored`, so slice 2
  needs no migration), `lib/api/answerHistory.ts` (`captureReason` pure,
  `captureBeforeWrite` inside the PUT / DELETE transaction,
  `listAnswerHistory`), "Earlier versions (n)" on the per-student page at edit
  level with Copy (`components/app/CopyTextButton.tsx`,
  `lib/reporting/answerHistoryView.ts`), `sweepAnswerHistory` in the nightly
  roster sync (log line `answer_history_sweep`). Tests: `test/answer-history.test.ts`
  + four route tests in `test/attempt-ingest-api.test.ts`; design-tool 2915
  pass, typecheck clean. Row 475 ✅ on local `_demo`; 476–480 NOT RUN.
