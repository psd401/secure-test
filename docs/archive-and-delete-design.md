# Delete draft, archive assessments and test sessions

Design note, 2026-09-09. Roadmap `docs/roadmap-2026-09.md` ("Finding from
the 2026-09-09 hand-run": no way to delete an assessment from the UI), widened
the same day by James: teachers should be able to delete drafts at any time,
and archive test sessions — and assessments — so the lists stop growing.
Design tool only; nothing in the client or the shared schema moves.
Decisions marked **D-n** are James's and are listed at the end; **§Progress
says what is built** (slices 0–4, 2026-09-09; rows unrun).

## What exists that this stands on

- **`DELETE /api/assessments/[id]`** (`app/api/assessments/[id]/route.ts`):
  owner-only; `requireDraft` 409s on a Published row (C10), so "Unpublish,
  then delete" is the only path. The row is hard-deleted and every child
  cascades: items, item sets, overrides, shares, `test_sessions`, and
  **`attempts` → `responses` → `response_uploads` rows** (the S3 objects are
  not touched). Nothing in the UI calls it — every hand-run cleanup so far
  has run it from the browser console.
- **Unpublish is allowed with attempts present.** The publish lock's unlock
  path (`PATCH {status: "draft"}`, C9) checks nothing about attempts. So
  today "Unpublish, then delete" silently destroys student work. That is the
  gap **D-1** closes.
- **Attempts are unique per (assessment, student)** and `POST /api/attempts`
  resumes the existing one; the delete-attempt slice
  (`docs/reporting-design.md`, `DELETE /api/attempts/[attemptId]`) is the
  per-student removal path with its own audit row. Deleting an assessment is
  the bulk version of that and must not be quieter than it.
- **`test_sessions`** carry `status IN ('open','closed')` and `expires_at`;
  redemption and the student's "Your tests" list (`lib/api/mySittings.ts`)
  admit only open, unexpired sittings. The Test sessions tab
  (`app/dashboard/[id]/SittingsPanel.tsx`) lists every sitting of the
  assessment newest first, open and closed alike, with Close only on open
  rows. The Assessments home (`app/dashboard/page.tsx`, a server component)
  lists every assessment the teacher owns newest-updated first, and an "Open
  now" strip of open sittings above it.
- **Sitting creation** (`POST /api/test-sessions`) 409s `not_published` on a
  draft; that is the only assessment-state check it makes.
- **`attempts.test_session_id` is `ON DELETE SET NULL`** — deleting a
  sitting was already designed not to delete a student's work. Archiving
  does even less: nothing is deleted.

## Design

### Delete draft (D-1, D-4)

- The route gains one more guard after `requireDraft`: if any `attempts` row
  references the assessment, **409 `has_attempts`** with the count. A draft
  that has never been sat deletes as today. The error is deliberate, not a
  warning the dialog could bypass — student work leaves the system only
  through the delete-attempt path, one attempt at a time, each with its
  audit row.
- **Where:** a "Delete draft" action on the editor's **Settings tab** and a
  row action on the **Assessments list** (D-4). Both are disabled with a
  note when the row is Published ("Unpublish to delete") or has attempts
  ("N attempts — archive instead"). The list page already knows the status;
  it gains an attempt count per assessment on the same query as the question
  count.
- **Confirm dialog** names the assessment and its question count; on 204
  the editor routes to the list, the list re-renders. Errors show inline in
  the dialog (`has_attempts` reads as the note above, in case the state
  moved under the page).

### Archive (D-2, D-3)

- **Storage:** `archived_at timestamptz` nullable on both `assessments` and
  `test_sessions`, **migration 0031**. Null = live. A timestamp rather than
  a boolean so the list can say "Archived 12 Sep" and a later retention
  sweep has something to sort on. No status change — a Published assessment
  stays Published while archived, so unarchiving restores it exactly.
- **Assessment archive:** `PATCH /api/assessments/[id] {archived: true|false}`
  becomes the **second status-only PATCH beside the unlock** — accepted on a
  Published row because it is not an edit (the lock exists so a delivered
  bundle cannot change under a student; archiving changes no content).
  Owner-only. **409 `session_open`** while any sitting of the assessment is
  open and unexpired — close the sittings first, the same rule the
  delete-attempt route applies. Sitting creation adds **409 `archived`**
  beside `not_published`, so nothing new can start on an archived
  assessment; existing closed sittings, attempts, results, the review queue
  and the print report are untouched and still reachable from the editor.
- **Sitting archive:** new `PATCH /api/test-sessions/[sessionId]
  {archived: true|false}`, owner-only, **409 `session_open`** on an open,
  unexpired sitting (an expired-but-unclosed one counts as closed here, as
  everywhere else). Attendance and the monitor's history keep working on an
  archived sitting.
- **Lists (D-4):** archived rows are hidden by default. The Assessments
  home takes `?archived=1` (a server component — no client state) and shows
  a "Show archived (n)" link / "Hide archived" with the count; archived rows
  carry an "Archived <date>" badge, no Start-session / Results shortcuts,
  and an Unarchive action. The Test sessions tab gets the same toggle as
  local state, and Archive on closed rows / Unarchive on archived ones. The
  editor header shows an Archived badge and hides Start session; the
  Settings tab carries Archive / Unarchive beside Delete draft.
- **Not in scope:** deleting a Published assessment or one with attempts
  (archive is the answer); bulk archive; a retention sweep of archived rows
  (the timestamp is there for it; the period is James's call, same as the
  event-table sweep in `docs/observability-design.md`).

## Slices

| # | What | Size / agent |
|---|---|---|
| 0 | This note; the roadmap row points here | docs |
| 1 | Delete draft: `has_attempts` guard + test; Settings-tab action + list row action + confirm dialog; editor test for the disabled states | XS — Sonnet 5 / medium |
| 2 | Archive, server: migration 0031; `{archived}` on the assessment PATCH (bypasses the lock, `session_open` guard); `PATCH /api/test-sessions/[sessionId]`; list routes and pages exclude archived by default; sitting creation 409 `archived`; tests for every guard | S — Opus 5 / medium |
| 3 | Archive, UI: Assessments list rows + `?archived=1` toggle; Test sessions tab rows + toggle; editor header badge, Start session hidden, Settings-tab Archive / Unarchive | S — Sonnet 5 / medium |
| 4 | Hand-run rows in `docs/design-tool-manual-checks.md`; deploy with S-f-1 + `APP_COMMIT`, then `migrate-aurora.sh` for 0031 | rows — Sonnet 5 |

## Decisions

- **D-1** Delete refuses when attempts exist (409 `has_attempts`; the dialog
  says "N attempts — archive instead"). Not a warning. — James, 2026-09-09
- **D-2** Archive is a real `archived_at` column and an explicit teacher
  action, not an auto-hide of old closed sittings. — James, 2026-09-09
- **D-3** Assessments archive too, now, same column and pattern; it is how
  a Published assessment leaves the list without losing attempts. — James,
  2026-09-09
- **D-4** Delete draft lives on both the Settings tab and the Assessments
  list. — James, 2026-09-09

## Progress

- **Slice 0 — 2026-09-09, `505fd9e`.** This note; the roadmap row points here.
- **Slice 1 — 2026-09-09, `0b81b24`.** `DELETE /api/assessments/[id]` answers
  409 `has_attempts` (with the count) after `requireDraft`; "Delete draft"
  on the Settings tab and a "Delete" row action on the Assessments list
  (`DeleteDraftButton.tsx`, page reload on 204 — no app router, the
  dashboard tree is rendered headless by `reporting-views.test.tsx`), both
  disabled with a note when Published or with attempts. 1392 tests.
- **Slice 2 — 2026-09-09, `f24802f`.** Migration **0031** `archived_at` on
  both tables (dev + test applied; Aurora after the deploy); `{archived}` on
  the assessment PATCH runs before the publish lock, status-only (400 with
  any other key), 409 `session_open`; new `PATCH /api/test-sessions/[sessionId]`;
  sitting creation 409 `archived`; both GET lists hide archived unless
  `?archived=1` (then only archived). Idempotent without re-stamping.
  1407 tests.
- **Slice 3 — 2026-09-09, `6e8a4bc`.** Assessments home `?archived=1` +
  Show / Hide archived link + badge + `ArchiveAssessmentButton.tsx`; the
  Test sessions tab fetches both lists, toggle beside Refresh, Archive on
  closed rows / Unarchive on archived ones, create form replaced by a note
  on an archived assessment; editor Archived badge + Settings-tab
  Archive / Unarchive outside the publish lock. 1410 tests.
- **Slice 4 — 2026-09-09.** Rows 109–121 in
  `docs/design-tool-manual-checks.md`, NOT run; they need the next deploy +
  `migrate-aurora.sh` (0031). Pattern held: Sonnet 5 for slices 1 + 3,
  Opus 5 for slice 2, each diff reviewed and `bun test` + typecheck re-run
  in the main session before its commit; one fix on agent output (slice 1's
  `useRouter` try/catch replaced by the page-reload pattern
  `DeleteAttemptAndReturn` already uses).
- **DEPLOYED 2026-09-09 ~21:30 PT** with S-f-1 + `APP_COMMIT`: rev 18, `/api/health` `{ ok, commit: bc2a1ce… }`, Aurora at 0031 (`migrate-aurora.sh`, 32 rows). Rows 109–121 still unrun.
