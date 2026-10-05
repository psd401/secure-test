# Release essays to Google Docs — design note

Roadmap row GD. Side: design-tool only (no client change, no release).
Asked by James, 2026-10-05: let a teacher release a student's essay from
the secure environment into a Google Doc the student can revise and share
for peer review.

## Decisions (James, 2026-10-05)

- **D-1 Purpose.** Revision drafts and peer review. The student gets
  **editor** access to their own Doc. Peers are added by hand, by the
  teacher or the student, in Drive; the app does not pair or share with
  peers in v1.
- **D-2 Contents are a checkbox menu.** Prompt, sources, essay, score,
  teacher feedback, AI feedback. The essay is always included; the rest
  default off.
- **D-3 Teacher ownership is fine for v1 and beyond.** The Doc is
  created in the sender's Drive. **Optional ownership transfer** to the
  student is a checkbox on the send. James confirmed 2026-10-05 that
  staff accounts can share with and transfer ownership to
  `edtools.psd401.net` accounts, and that a shortcut to the file stays
  in the teacher's folder after a transfer.
- **D-4 Per section and per student.** Per section is the common path.
  Folders in the sender's Drive: `secure-test / <assessment title> /
  <section>`.
- **D-5 Re-send = skip or new.** The send dialog offers "skip students
  who already have a Doc" (default) or "create a new Doc". Title:
  `<student name> – <assessment> – 2026-10-05 14:30` (Pacific time, the
  send's time).
- **D-6 Safeguarding gate.** An essay with an alert that is not
  acknowledged (`safeguarding_alerts.acknowledged_at` is null) is
  skipped and named in the send result. Once the teacher reviews and
  acknowledges it, the next send includes it.
- **D-7 The student's name is in the Doc** (title and heading). No
  anonymous mode.
- **D-8 Essays only.** Short text, tables, drawings and choices are out
  of scope.
- **D-9 Co-teachers with edit access can send.** Their Docs land in
  their own Drive under the same folder path.
- **D-10 One Doc per student per assessment.** Every essay on the
  assessment goes in that student's one Doc, in question order, each
  under its own heading. No question number in the title (D-5's format
  stands).
- **D-11 Drive's share email stays ON** (R-6 accepted).
- **D-12 The teacher chooses whether drafts go.** A dialog checkbox
  "Include students who have not handed in" (default off). A draft's Doc
  says "Draft — not handed in as of <send time>" under its heading.
- **D-13 Approved scores only** (R-3 accepted): a final score's content,
  never an unapproved AI proposal.

## Recommendations (proposed here, for James to confirm — §Questions)

- **R-1 No stored Google token.** Each send runs Google's incremental
  authorization for `https://www.googleapis.com/auth/drive.file` with
  `login_hint` = the teacher, and WITHOUT `include_granted_scopes`
  (finding GD-P1: it folds in every earlier grant). Google
  remembers the grant, so after the first consent it is a redirect with
  no prompt. The one-hour access token lives in an encrypted, httpOnly,
  short-lived cookie scoped to the send route, and nothing persists in
  the database. No refresh token, no key to manage, nothing to revoke.
  `drive.file` reaches only files and folders this app created. The
  OAuth client is internal to the Workspace, so Google's app
  verification does not apply.
- **R-2 Snapshot, one way.** Handed-in attempts by default; drafts only
  when the teacher ticks D-12's box. The Doc is a snapshot at the send;
  later changes in Secure Test do not follow it, and edits in the Doc
  never come back. (Superseded in part by D-12.)
- **R-3 Score and feedback come from the FINAL score only.** This is the
  print page's rule (rubric-upload D-6). A pending AI proposal is never
  released. "Teacher feedback" is `rationale.note`. "AI feedback" is the
  per-criterion rationale and the overall rationale on a final score
  that was AI-proposed and then approved. If there is no final score, the
  score and feedback sections are left out, and the result says so.
- **R-4 Superseded by D-10** (one Doc per student per assessment).
- **R-5 The Doc is built from HTML.** Drive's multipart upload with
  `mimeType: application/vnd.google-apps.document` converts HTML to a
  Doc. That avoids the Docs API and a second scope. Headings, the
  prompt, sources as labelled blocks, the essay with its line breaks
  kept, the score and feedback as a short table. KaTeX in prompts and
  sources: plain-text fallback (the work packet's `stemExcerpt` rule,
  WP-1 aside) — a Doc cannot run KaTeX.
- **R-6 Drive's own share email is ON.** `sendNotificationEmail=true` on
  the student's permission tells the student a Doc is waiting, with no
  SES dependency (see §Questions 3.2).

## Data model (migration, next free number)

- `google_doc_folders` — `owner_sub`, `kind` (`root` | `assessment` |
  `section`), `assessment_id` (null for root), `section_key` (null
  unless section), `drive_folder_id`, `created_at`. Unique on (owner_sub,
  kind, assessment_id, section_key). The app looks folders up by stored
  id, so a teacher renaming or moving one does not matter. A folder that
  answers 404 or is trashed is created again and the row updated.
- `google_doc_releases` — `attempt_id`, `sender_sub`,
  `drive_file_id`, `title`, `contents` (jsonb: which boxes were ticked),
  `was_draft`, `ownership_transferred_at`, `created_at`. Many per
  attempt —
  "create new" adds a row; "skip" checks for any row by this sender.
- Event kind `released_to_google_docs` on the attempt's timeline
  (staff-only, like `gradebook_sent`): "Released to Google Docs <time> ·
  by <teacher>".
- Attempt delete cascades the release rows. The Docs stay in Drive; they
  are the teacher's and the student's from then on.

## Slices

0. **This note + the proof** (no app code). A scratchpad script with a
   `drive.file` token proves the chain on one test Doc: create a folder,
   upload HTML as a Doc, share writer to a demo student, transfer
   ownership, confirm the app can still read the file afterward. That
   last check decides whether "skip existing" can rely on the stored
   file id or must ignore files it can no longer see.
1. **Google Cloud setup (James, console).** Enable the Drive API on the
   OAuth project; add `drive.file` to the consent screen's scopes;
   register `https://<origin>/api/google/drive/callback` (and the
   localhost one) on the web client. No new secret.
2. **Authorization routes.** `GET /api/google/drive/start?next=…` and
   `/callback`: PKCE + state like `app/api/auth/start`, a token cookie
   ≤ 1 h, `safeNextPath` back to the results page with the dialog
   reopened. Tests: state mismatch, a missing scope in the grant
   (teacher unticked it) → plain error, cookie lifetime.
3. **Send backend.** `lib/googleDocs/` — `buildDocHtml` (pure: contents
   flags + attempt data → HTML; tested on fixtures), `ensureFolders`,
   `sendRelease` (sequential, retries 429 / `rateLimitExceeded` with
   backoff). `POST /api/assessments/[id]/google-docs` at **edit** level
   (`authorize*` from `lib/api/access.ts`): body `{ section | attempt_id,
   contents, mode: skip | new, transfer_ownership }`. The result lists
   each student as sent / skipped (existing, not handed in, no essay,
   unacknowledged alert) / failed with a reason. Body also carries
   `include_drafts`. An alert on one essay holds back that student's
   whole Doc (one Doc per student, D-10). A missing or expired
   token cookie → 401 `drive_auth_needed`, and the UI starts slice 2's
   flow. Migration + event kind here.
4. **Teacher UI.** "Send to Google Docs" beside Print student work on
   the results toolbar (section picker, as the gradebook send) and on the
   per-student page (that one attempt). Dialog: content checkboxes,
   skip / new, "Give students ownership", Send. A result list after,
   and "Released to Google Docs · <date>" on rows that have one.
5. **Ownership transfer.** `permissions.create` with `role: owner`,
   `transferOwnership: true` after the writer share. Behind the
   checkbox; a failed transfer leaves the Doc shared as editor and is
   reported as "shared; ownership not transferred".
6. **Rows** in `docs/design-tool-manual-checks.md` on the origin with a
   demo student: first send (consent), second send (no prompt), skip,
   new, alert gate before and after acknowledge, co-teacher send into
   their own Drive, transfer + shortcut left in the folder, contents
   checkboxes each on, a rubric-less essay, a two-essay assessment in
   one Doc, a draft with and without the box ticked.

## Risks

- **The prompt leaves the secure environment.** With "Prompt" or
  "Sources" ticked, students can copy and share them. That is the
  teacher's call per send; the dialog's help line says so for an
  assessment that is still Published.
- **Drive quota.** About 4 Drive calls per student (upload, share,
  maybe transfer, plus folders once). A section of 35 is ~140 calls in
  sequence — a few seconds per student at worst, well inside per-user
  quotas. The route answers when done (no job queue in v1); if a large
  send runs past the ALB timeout this becomes a background job.
- **A teacher unticks the Drive permission** on Google's consent screen.
  Google's granular consent allows it; slice 2 checks the granted scopes
  and says what is missing.

## Questions

None open. 3.1–3.5 answered 2026-10-05 → D-10…D-13 (3.5 fell away with
D-10).

## Progress

- 2026-10-05 — note written; D-1…D-13 decided; nothing built.
- 2026-10-05 — **slice 0 proof PASSED** (scratchpad script, James's staff
  account → a demo student, local redirect URI). Consent granted
  `drive.file` with no refresh token; a folder and an HTML upload
  converted to a Google Doc; writer share with Drive's email; ownership
  transfer to the student succeeded directly (no pending-owner step).
  After the transfer the teacher's app still reads the file through
  `drive.file`: the student is the owner, the file's parent is still the
  teacher's folder (the folder listing shows the Doc itself, not a
  shortcut), `canEdit` and `canShare` true, `canTrash` false. So "skip
  existing" can trust the stored file id, and a transferred Doc stays
  reachable. **Finding GD-P1:** with `include_granted_scopes=true` the
  token came back carrying every scope this user had granted to this
  OAuth client before, including `gmail.send`. R-1 changes: request
  `drive.file` WITHOUT `include_granted_scopes`, and check that the
  granted scope list is exactly what was asked for.
- 2026-10-05 — **slice 2 BUILT** (`lib/googleDocs/driveAuth.ts`,
  `GET /api/google/drive/start` + `/callback`): drive.file alone without
  `include_granted_scopes`, a granted list other than exactly drive.file
  refused (`scope_mismatch`), the consenting Google account must equal the
  session's email (`about.get`, `wrong_account`), the one-hour token in an
  encrypted (`dir` / A256GCM) httpOnly cookie bound to the session's sub on
  path `/api/assessments`, act-as refused 403, every outcome a redirect to
  `next?gdrive=<outcome>`. 17 tests. **Checked against real Google on local
  dev the same day:** the callback carried `scope=…/auth/drive.file` only
  and landed on `/dashboard?gdrive=ok`.
