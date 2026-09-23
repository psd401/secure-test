# Gradebook push — "Send to gradebook" into PowerTeacher Pro or Schoology (roadmap batch 6 / reporting R3)

Design note, 2026-09-22. Follows `docs/gradebook-integration-research.md`
(the survey, and IT's reply the same day — internal, see the ops
repository). Decisions marked **D-n** are James's and are listed at the
end; **§Progress says what is built** (nothing yet).

## What this is

A teacher opens an assessment's results and presses **Send to gradebook**.
They pick one destination — **PowerSchool** (PowerTeacher Pro) or
**Schoology** — one section, a category, and the assignment name; the tool
creates the assignment in that gradebook and writes one score per handed-in,
fully scored attempt. Pressing it again on the same section updates the same
assignment (new scores, corrected scores) rather than creating a second one.

Nothing is required of PowerSchool or Schoology as vendors. What has to be
in place is district-side and small: a PSD-written PowerSchool plugin
(IT writes and installs it) and three DCID columns in the nightly roster
extract.

## What exists that this stands on

- **Results are already a per-attempt, per-student table.**
  `buildResults` (`lib/scoring/results.ts`) returns `ResultsRow`s for the
  SUBMITTED attempts of an assessment with `student.student_number`,
  `student.section` (a resolved label), `total_points`, `max_points`
  (D-R1 constant), `percent` (null while `unscored_count > 0`), and
  `sitting_open`. Students are resolved through the OWNER's `students`
  overlay (`roster_ps_id` = the PowerSchool student number), the section
  through the sitting's `section_ps_id` or the current enrollment.
- **The roster carries PowerSchool ids, but not DCIDs.** `roster_students.ps_id`
  is the student number, `roster_sections.ps_id` is `SECTIONS.ID`,
  `roster_section_teachers.teacher_ps_id` is the per-school `TEACHERS.ID`,
  `roster_sections.term_id` is `TERMS.ID`. PowerTeacher Pro's API keys on
  `STUDENTS.DCID`, `SECTIONS.DCID` and the teacher's `USERS.DCID` — none
  present. The extract contract (`docs/roster-extract.md`) says columns
  beyond the listed ones are ignored, so new columns are additive and need
  no `format_version` bump.
- **Who may act on an assessment is settled** (`docs/access-model-design.md`):
  `authorizeAssessment(id, "edit")` is the owner or a co-teacher;
  `assessmentOwner()` gives the owner's email; `roster_section_teachers`
  (with `is_active` and the date window, see `lib/roster/coTeachers.ts`)
  says who currently teaches a section. An act-as session carries
  `actor_sub` for audit.
- **Scores**: one `final` per response; `superseded` after a pass back;
  `runAutoScoringPass` fills auto items on submit. A row's `unscored_count`
  is the count of responses with no final.
- **Secrets reach the task from Secrets Manager** (`app-env` JSON →
  ECS-injected env, `infra/lib/app-service.ts`); new keys are one line
  there plus a `.env.local.example` line. Providers follow the
  `mock | <live>` pattern (`PDF_EXTRACTOR_PROVIDER`, `NOTIFY_PROVIDER`).
- **Audit**: `attempt_events` holds staff-only kinds (`teacher_hand_in`,
  `deadline_extended`, `passed_back`) shown on the per-student timeline.

## What IT established (2026-09-22)

- PowerTeacher Pro's `/ws/xte/` REST endpoints are reachable by a plugin
  with `<oauth/>` and a field-level `<access_request>` (ASSIGNMENT,
  ASSIGNMENTSECTION, ASSIGNMENTCATEGORYASSOC, ASSIGNMENTSCORE,
  ASSIGNMENTSCORECOMMENT full; TEACHERCATEGORY, DISTRICTTEACHERCATEGORY,
  SECTIONS/STUDENTS/USERS/TERMS view). Token:
  `POST /oauth/access_token/` client-credentials with Basic auth; Bearer on
  every call. IT writes and installs the plugin.
- Every call passes the acting teacher's `users_dcid`; PowerSchool does not
  restrict a plugin by user. **The tool is the authorization layer.**
- Write path: `GET /ws/xte/teacher_category?users_dcid&year_id` →
  `POST /ws/xte/section/assignment/?users_dcid` (body: assignment with one
  `_assignmentsections[]` entry: `sectionsdcid`, `name`, `duedate`,
  `scoretype: POINTS`, `scoreentrypoints`, `totalpointvalue`, `weight`,
  `iscountedinfinalgrade`, `publishoption`, `_assignmentcategoryassociations[{teachercategoryid, isprimary}]`)
  → 201 with `assignmentsectionid` → `PUT /ws/xte/score?users_dcid&status=A&term_id`
  with `assignment_scores[]` of `{_assignmentsection.assignmentsectionid, studentsdcid, actualscoreentered, actualscorekind: REAL_SCORE, scoretype: POINTS, scorepoints}`;
  include `assignmentscoreid` to update. `ASSIGNMENT.CREATEDBYPLUGIN` tags
  our rows. Exact embedded field names are to be confirmed by a GET of a
  real assignment once the plugin has field access.
- Categories: four district ones on every teacher (Classwork, Test,
  Project, Quiz; `DISTRICTTEACHERCATEGORYID` 1–4) plus teacher-created
  ones; `ISACTIVE` may be 0.
- `year_id` = `TERMS.YEARID`; `term_id` = the section's `TERMS.ID`.
  PowerSchool's convention is `termid = yearid * 100 + n`, so `year_id`
  derives from `roster_sections.term_id` (to confirm on the test section).
- Schoology sections are SIS-provisioned; `section_school_code` =
  `SECTIONS.DCID`. Schoology → PTP passback is on for roughly 40 % of
  sections with gradebook assignments, per teacher / section.

## Design

### The send (one destination, one section)

`POST /api/assessments/[id]/gradebook-send` — staff, `edit` on the
assessment. Body:

```json
{ "target": "powerschool" | "schoology",
  "section_ps_id": "…",
  "category_id": "…",
  "name": "Unit 3 test",
  "due_date": "2026-09-22",
  "publish": "teacher_default" }
```

1. **Authorize twice.** `authorizeAssessment(id, "edit")`, then the
   sender's email must be a CURRENT teacher of `section_ps_id` in
   `roster_section_teachers` (active row, `start_date ≤ today ≤ end_date`;
   any role). Otherwise 404 — the same shape as every other access refusal.
   On an act-as session the target teacher's email is checked (they are
   the one who could do this themselves) and `actor_sub` is recorded.
2. **Select rows.** `buildResults(id)` filtered to attempts whose section
   resolves to `section_ps_id` and whose student has a DCID (PowerSchool)
   or a Schoology enrollment (Schoology). Rows with `unscored_count > 0`
   are **held back** and counted, never sent as partial points (D-3).
   Rows already sent whose `total_points` is unchanged are skipped.
3. **Create or reuse the assignment.** `gradebook_pushes` (below) has at
   most one live row per `(assessment_id, section_ps_id, target)`; if it
   exists, its external assignment id is reused and `name` / `due_date`
   changes are ignored (the teacher edits those in the gradebook). Else
   create, store the id.
4. **Write scores** in one bulk call (PowerSchool `PUT /ws/xte/score`;
   Schoology `PUT /sections/{id}/grades`), record per-student outcome,
   return `{ sent, updated, held_back, failed: [{ student_number, reason }] }`.
5. **Audit**: one `attempt_events` row per sent attempt, kind
   `gradebook_sent`, `detail: { target, external_assignment_id, points }`.

Points only (D-4): `scorepoints = total_points`, assignment max =
`max_points`. Percent and letter are the gradebook's business.

### Data model (migration 0042)

- `roster_students.dcid text`, `roster_sections.dcid text`,
  `roster_section_teachers.users_dcid text` — nullable; the importer reads
  the new extract columns when present (`docs/roster-extract.md` gains
  three optional rows; the fixture and `roster-extract.test.ts` gain the
  columns; no `format_version` change).
- `gradebook_pushes`: `id`, `assessment_id`, `section_ps_id`, `target`
  (`powerschool | schoology`), `external_assignment_id` (PowerSchool
  `assignmentsectionid`; Schoology `assignment_id`), `external_section_id`
  (Schoology section id; null for PowerSchool), `category_id`, `name`,
  `created_by_sub`, `actor_sub`, `created_at`, `last_sent_at`, `last_result
  jsonb` (`{sent, updated, held_back, failed[]}`), `archived_at` (set when
  the external assignment is found deleted — then the next send creates a
  new one). Unique on `(assessment_id, section_ps_id, target)` where
  `archived_at IS NULL`.
- `gradebook_push_scores`: `push_id`, `attempt_id`, `external_score_id`
  (PowerSchool `assignmentscoreid`; Schoology has none — the grade is keyed
  by enrollment), `points_sent`, `sent_at`. Lets a re-send update rather
  than duplicate, and skip unchanged rows.
- `schoology_connections`: `staff_sub` PK, `schoology_uid`, `token`,
  `token_secret` (both encrypted at rest with a new `GRADEBOOK_TOKEN_KEY`,
  AES-GCM, key in `app-env`), `connected_at`, `revoked_at`.
- `gradebook_section_prefs`: `(staff_sub, section_ps_id)` → `target`,
  `category_id` — the remembered destination (D-5). Written on every
  successful send, read to pre-fill the dialog.
- `attempt_events` gains kind `gradebook_sent` (staff-only, not
  client-postable — same guard as `teacher_hand_in`).

### PowerSchool client (`lib/gradebook/powerschool.ts`)

- Env: `POWERSCHOOL_BASE_URL`, `POWERSCHOOL_CLIENT_ID`,
  `POWERSCHOOL_CLIENT_SECRET` (the last two in `app-env`),
  `GRADEBOOK_PROVIDER=mock|live` (mock = the default for tests and CI, an
  in-memory gradebook that records calls).
- Token cached in-process until `expires_in − 60 s`; one retry on 401.
- Id mapping is a pure function over the roster tables: sender email →
  `users_dcid` via the section-teacher row; section → `roster_sections.dcid`
  and `term_id` (`year_id = floor(term_id / 100)`); student →
  `students.roster_ps_id` → `roster_students.dcid`. A missing DCID holds
  the row back with reason `no_dcid` (the extract will backfill overnight).
- Category: `GET /ws/xte/teacher_category` filtered `isactive`; the dialog
  lists them; default = the row with `districtteachercategoryid = 2`
  ("Test") when active, else the first active one (D-6).
- Name truncated to 50 characters (a limit two vendors document; confirm on
  the test section). `publishoption` = the category's
  `defaultpublishoption` unless the dialog overrides.
- 409 validation bodies are logged (`log.error("gradebook_push_failed")`)
  and surfaced verbatim in the summary's failure list; 412 "Resubmit" is
  retried once.

### Schoology client (`lib/gradebook/schoology.ts`)

- **Three-legged OAuth 1.0a per teacher (D-2).** `GET /api/gradebook/schoology/connect`
  → request token → redirect to `https://<district>.schoology.com/oauth/authorize`
  → `GET /api/gradebook/schoology/callback` exchanges for an access token,
  stores it encrypted, records `schoology_uid` from `GET /users/me`.
  "Disconnect" revokes locally. Env: `SCHOOLOGY_CONSUMER_KEY`,
  `SCHOOLOGY_CONSUMER_SECRET` (a district-private app's credentials,
  `app-env`), `SCHOOLOGY_DOMAIN`; the same `GRADEBOOK_PROVIDER` switch.
- Section: `GET /users/{uid}/sections`, match `section_school_code ===
  roster_sections.dcid`; no match → the dialog says the section is not in
  the teacher's Schoology courses.
- Students: `GET /sections/{id}/enrollments?type=member` → `enrollment_id`
  by `school_uid` (= student number). No enrollment → held back,
  reason `not_enrolled_in_schoology`.
- Category: `GET /sections/{id}/grading_categories` (Schoology categories
  are per course); the dialog requires a pick; remembered per section.
  An assignment without a category does not sync to PowerTeacher Pro.
- Write: `POST /sections/{id}/assignments` (`title`, `max_points`,
  `grading_category`, `due`, `published: 1`) then
  `PUT /sections/{id}/grades` with `{"grades":{"grade":[{assignment_id,
  enrollment_id, grade}]}}`. Rate limit: writes cost 3 of 50 credits per
  5 s; the client sleeps on 429 `Retry-After`.
- Whether the score then reaches PowerTeacher Pro is the teacher's
  existing Sync; the summary says so in one line when the target is
  Schoology.

### UI

- **Results page** (`/dashboard/[id]/results`): a **Send to gradebook**
  button beside Print student work, shown at `edit` level. Dialog:
  destination (PowerSchool / Schoology — Schoology shows "Connect
  Schoology" when the teacher has no connection), section (the sitting's
  sections, each with "n scored · m awaiting scoring"), category (loaded
  for the chosen destination + section), name (default: the assessment
  title), due date (default: the latest sitting's date), then **Send**.
  Pre-filled from `gradebook_section_prefs`. After: a summary line and the
  failure list; the button reads "Sent to PowerSchool · 2026-09-22" with
  "Send again" once a push exists.
- **No "both"** (D-1). A teacher who wants both runs the dialog twice; the
  dialog warns when the other target already has a push for that section
  ("Already sent to Schoology on … — if that course syncs to
  PowerSchool this will create a duplicate").
- **Account page / header**: "Connect Schoology" lives with the existing
  feedback / sign-out chrome so a teacher can connect before the first
  send.
- **Per-student page**: the timeline shows `gradebook_sent`.

### Authorization, in one place

`lib/gradebook/authorizeSend.ts`: given a session, an assessment id and a
section, returns the acting teacher's `{ email, users_dcid }` or a 404.
The two clients never receive a `users_dcid` from the request body. Tests
cover: owner on own section; co-teacher (grant + roster row); owner on a
section they do not teach (404); admin act-as (allowed as the target,
`actor_sub` recorded); a substitute's `run` level (404).

## Slices

| # | Slice | Side | Size | Model |
|---|---|---|---|---|
| 0 | This note + roadmap row 6 pointer | docs | XS | — |
| 1 | **Extract DCIDs**: `docs/roster-extract.md` three optional columns, parser + importer + **migration 0042** (roster columns only), fixture + tests; the IT reply names the columns | design tool | S | Sonnet 5 / medium |
| 2 | **PowerSchool send**: mock + live client, id mapping, `authorizeSend`, `gradebook_pushes` / `_scores` / `_prefs` tables (same migration as 1 if unshipped, else 0043), the send route, `gradebook_sent` event; live-verified on IT's test section | design tool | M | Opus 5 / medium |
| 3 | **Schoology connect + send**: OAuth 1.0a flow, `schoology_connections` + token encryption, client, the route's second target | design tool | M | Opus 5 / medium |
| 4 | **UI**: results-page button + dialog, remembered prefs, connect chrome, per-student timeline row | design tool | S | Sonnet 5 / medium |
| 5 | Rows in `docs/design-tool-manual-checks.md` + the live runs (one PowerSchool test section, one Schoology course with passback on) | docs | S | Sonnet 5 / low |

Order: 1 → 2 → 4 (PowerSchool end to end, the gradebook of record) → 3 →
5. Slice 1 ships as soon as IT's columns land — the importer tolerates
their absence, so either side can go first. Slices 2 and 3 touch disjoint
files and may run in parallel once 1 is merged.

## Decisions

- **D-1 (James, 2026-09-22)** one destination per send; no "both" option.
  A teacher without Schoology → PTP sync sends twice.
- **D-2 (James, 2026-09-22)** Schoology via three-legged OAuth per
  teacher; no district admin key.
- **D-3 (recommended)** only fully scored attempts are sent; held-back
  rows are counted in the dialog and the summary. A later send picks them
  up. *Alternative: send partial points and overwrite later — rejected
  because a partial score in a gradebook reads as a real grade.*
- **D-4 (recommended)** points only; max = the assessment's constant
  `max_points`.
- **D-5 (IT's suggestion, recommended)** remember destination + category
  per (teacher, section); always show the pre-filled dialog, never send
  silently.
- **D-6 (recommended)** PowerSchool default category = the teacher's
  active copy of district "Test"; Schoology has no default (per-course
  categories) — required pick, remembered.
- **D-7 (recommended)** a re-send updates the existing assignment's
  scores and skips unchanged rows; name / due date edits after the first
  send belong to the gradebook.

## Open questions (James)

- 8.1 Due date default: latest sitting's date, or today?
- 8.2 Publish scores: category default, or always "Immediately"? —
  **ANSWERED 2026-09-23: category default** until Teaching & Learning
  decides otherwise.
- 8.3 Should a **passed-back** attempt's earlier send be withdrawn
  (score cleared in the gradebook) or left until the next send overwrites
  it? Recommend: left, summary notes it.
- 8.4 Show the button to co-teachers (edit level) — yes per the access
  model; confirm.
- 8.5 Schoology "Connect" placement: header chrome vs first-send prompt
  only?

## Verification

- Unit: id mapping, `authorizeSend` matrix, payload builders for both
  targets against recorded fixtures, held-back rules, re-send skipping,
  token encryption round trip, the mock provider's recorded calls.
- Live: IT's PowerSchool test section (a real 201 + score rows visible in
  PTP, then a re-send with one corrected score), one Schoology course with
  passback on (grade visible in Schoology, then in PTP after the teacher's
  Sync, no duplicate).
- The rows list every dialog state (no connection, section not in
  Schoology, missing DCIDs, all held back, other-target warning).

## Progress

Nothing built.

**2026-09-23 — IT's second reply** (the reply and ours are in the ops
repository):

- **Extract columns SHIPPED** from the 2026-09-23 nightly run, same manifest
  and `format_version`: `students.csv` → `dcid`; `sections.csv` → `dcid`
  **and `year_id`** (`TERMS.YEARID`); `section_teachers.csv` →
  `users_dcid`. `floor(term_id / 100)` was confirmed for PSD terms, but
  slice 1 reads `year_id` from the extract instead of deriving it (the
  "Id mapping" paragraph above changes accordingly). Slice 1 is unblocked:
  first confirm a snapshot carries the columns.
- **PowerSchool plugin written** (write access to the assignment, category
  association and score tables; read access to teacher + district
  categories; audit columns read-only; a failed write names the missing
  field). Waiting on IT's test instance, then the OAuth pair. We read a
  real assignment first, then one create + score write + re-send on a test
  section, before a production install.
- **Schoology:** a district Standard App (not launched inside Schoology) is
  being registered; teachers connect their own accounts (D-2). ONE app, on
  the origin — Secure Test has one deployed environment and `localhost`
  cannot receive the callback, so slice 3 is built and verified against
  the origin with the feature switched on for the maintainer's account
  only (decision 2026-09-23).
- **8.2 answered:** new assignments follow the **category default** for
  score publishing until Teaching & Learning decides otherwise.
