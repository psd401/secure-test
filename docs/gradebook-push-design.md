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
  and `year_id` (both from the extract since 2026-09-23); student →
  `students.roster_ps_id` → `roster_students.dcid`. A missing DCID holds
  the row back with reason `no_dcid` (the extract will backfill overnight).
- Category: `GET /ws/xte/teacher_category?users_dcid&year_id` (a plain
  array; the id is `teachercategoryid`) filtered `isactive`; the dialog
  lists them; default = the row with `districtteachercategoryid = 2`
  ("Test") when active, else **no default — the teacher must pick** (D-6,
  revised 2026-09-28).
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
- **D-3 (James, 2026-09-28)** only fully scored attempts are sent; held-back
  rows are counted in the dialog and the summary. A later send picks them
  up. *Alternative: send partial points and overwrite later — rejected
  because a partial score in a gradebook reads as a real grade.*
- **D-4 (James, 2026-09-28)** points only; max = the assessment's constant
  `max_points`.
- **D-5 (IT's suggestion; James, 2026-09-28)** remember destination + category
  per (teacher, section); always show the pre-filled dialog, never send
  silently.
- **D-6 (James, 2026-09-28)** PowerSchool default
  category = the teacher's active copy of district "Test"; when that copy
  is inactive there is **no default and the teacher must pick** (the 2a
  read found a teacher whose four district categories were all inactive —
  a first-active fallback would have preselected an unrelated category).
  Schoology has no default (per-course categories) — required pick,
  remembered.
- **D-7 (James, 2026-09-28)** a re-send updates the existing assignment's
  scores and skips unchanged rows; name / due date edits after the first
  send belong to the gradebook.

## Open questions (James)

- 8.1 Due date default: latest sitting's date, or today? — **ANSWERED
  2026-09-28 (James): today**, the date the send is run.
- 8.2 Publish scores: category default, or always "Immediately"? —
  **ANSWERED 2026-09-23: category default** until Teaching & Learning
  decides otherwise.
- 8.3 Should a **passed-back** attempt's earlier send be withdrawn
  (score cleared in the gradebook) or left until the next send overwrites
  it? Recommend: left, summary notes it. — **ANSWERED 2026-09-28 (James):
  left**; the next send overwrites, the summary notes it.
- 8.4 Show the button to co-teachers (edit level) — yes per the access
  model; confirm. — **CONFIRMED 2026-09-28 (James): yes.**
- 8.5 Schoology "Connect" placement: header chrome vs first-send prompt
  only? — OPEN; slice 3 is HELD (James, 2026-09-28) until the PowerSchool
  send works end to end.

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

**Slice 1 BUILT 2026-09-23** (extract DCIDs; **migration 0042**
`roster_dcids`). **DEPLOYED 2026-09-24 ~14:30 PT**: LIVE =
origin/main `7b33384`, health stamp = HEAD, Aurora at 0042 via
`migrate-aurora.sh` (43 journal rows); roster-health exit 0 before the deploy
(the 06:00 run on the old code succeeded). The first import that stores the
DCIDs is 2026-09-25 06:00 — check it with `roster-health` then. Its
"DCIDs" block (`89fcf6e`, deployed the same evening) prints active rows with
a value / active rows for each of the four columns. The newest snapshot
was checked first (headers only): `students.dcid`, `sections.dcid` +
`year_id`, `section_teachers.users_dcid` all present. The four columns are
`OPTIONAL_COLUMNS` in `lib/roster/extract.ts` — a file without one is
accepted and the importer leaves the stored value alone (a warehouse
regression cannot erase ids a send depends on, and cannot refuse the roster
everyone signs in against); present-and-empty stores NULL; a non-integer
refuses the row like any malformed cell. Stored as nullable `text`
(opaque ids, like `ps_id`) on `roster_students.dcid`,
`roster_sections.dcid` / `year_id`, `roster_section_teachers.users_dcid`.
The complete fixture now carries the columns (4–5 digit synthetic ids);
tests in `test/roster-extract-dcids.test.ts` and `test/roster-import.test.ts`.
**Deploy order matters:** the roster-sync Lambda bundle carries the new
importer, which writes the new columns — run `migrate-aurora.sh` right after
the deploy (the recipe does), and before the 06:00 import, or that night's
import fails `write_failed:students:42703` and the roster stays at the
previous night's.

The Schoology app credentials (`SCHOOLOGY_CONSUMER_KEY` / `_SECRET`) and
`GRADEBOOK_TOKEN_KEY` were added to the `app-env` secret the same evening
(nothing references them until slice 3 deploys).

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

**2026-09-25 — IT's reply on the PowerSchool test server** (the reply and
our questions are in the ops repository). OAuth sign-in and plugin reads
(assignments, teacher categories) already worked from the maintainer's Mac.

- **Roster read access granted on the ONE plugin (v1.1), not a test-only
  copy** — what we test is what ships: `USERS` (`DCID`, `EMAIL_ADDR`),
  `SECTIONS` (`DCID`, `ID`, `TERMID`, `SCHOOLID`), `CC` (`SECTIONID`,
  `STUDENTID`), `STUDENTS` (`DCID`, `STUDENT_NUMBER`), `TERMS` (`YEARID`),
  read-only. IT's condition, which the design already follows: these reads
  are for lookups and pre-send checks, never a second roster — in
  production the nightly extract stays the source of who teaches and who
  is enrolled. **Accepted exposure (maintainer, 2026-09-25):** the
  production plugin's credentials can now read staff emails, student
  numbers and enrolments district-wide, so they are guarded like the
  roster itself (secret only, never logged).
- **No DNS or trusted certificate for the test server** (temporary). Local
  workaround only (no admin rights for `/etc/hosts`): the local probe
  connects to the server's IP but presents and verifies the certificate
  against its name, trusting only the saved self-signed certificate, and
  refuses to run if a wrong name is accepted — verification stays on, and
  the transport lives in a dev script, so nothing test-shaped reaches
  production code.
- **Production has a publicly trusted certificate** — slice 2 builds for
  normal verification.
- **Probe run 2026-09-28** (`design-tool/scripts/ps-probe.ts`, read-only,
  on the district network; run it with **node** — Bun's TLS refuses the
  test server's self-signed certificate because it lacks the CA flag,
  Node's OpenSSL accepts it; production's public certificate is
  unaffected). Name check proven (a wrong name is refused); every granted
  field reads; `CC.SECTIONID` → `SECTIONS.ID` joins. **Two gaps
  confirmed**, both ours, test-server only (production takes these links
  from the extract): `STUDENTS.ID` is refused, so `CC.STUDENTID` cannot be
  joined to a student DCID for certain. A filter on `DCID` matched on the
  one row tried — possibly the common PowerSchool pattern of `ID` =
  `DCID`, unverified. A second run sampled 187 distinct `CC.STUDENTID`
  values: 187 of 187 exist as a student DCID. Weak evidence all the same
  — with the whole student history on file, DCIDs are likely dense enough
  (not measured) that most numbers in range exist as SOME student's DCID,
  so existence does not show it is the same student. Only reading `STUDENTS.ID` beside `DCID` proves it,
  and the pattern is not guaranteed row by row, so nothing is built on
  it; nothing granted links a teacher to their sections
  (`SECTIONTEACHER`, `SCHOOLSTAFF` refused). `TERMS.ID` is refused and
  not needed (`year_id` comes from the term id). Follow-up ask to IT:
  `STUDENTS.ID`, `SECTIONTEACHER` (`SECTIONID`, `TEACHERID`),
  `SCHOOLSTAFF` (`ID`, `USERS_DCID`) — or the fallback of one teacher's
  `USERS.DCID`, one section DCID and a few student DCIDs.
- **The test server holds a June 2025 snapshot** (the maintainer,
  2026-09-28): 2024-25 sections and terms, every student record and
  enrolment on file as of then. Test sends target a 2024-25 section; the
  current extract's section ids will not exist there.

**2026-09-28 — plugin v1.2 closes both gaps** (IT, the same afternoon,
over the collab channel — its first use, clean both ways): read-only
`STUDENTS.ID`, `SECTIONTEACHER` (`SECTIONID`, `TEACHERID`),
`SCHOOLSTAFF` (`ID`, `USERS_DCID`) added on the ONE plugin, same
credentials, same rule (lookups and pre-send checks only; the extract
stays the production roster). The probe re-run against v1.2 (a pilot
teacher's email as the argument; counts only):

- Every granted field reads; `TERMS.ID` still refused as expected.
- **Student join proven:** `CC.STUDENTID` → `STUDENTS.ID` matches, and
  over a 187-enrolment sample every row resolves to a student with a
  DCID (187 of 187; `ID` = `DCID` on all 187 — informational, nothing
  builds on it).
- **Teacher → sections proven:** `USERS.DCID` → `SCHOOLSTAFF.USERS_DCID`
  (3 staff rows, one per school) → `SECTIONTEACHER.TEACHERID` → 100
  distinct section ids (a page cap, a floor not a count) →
  `SECTIONS.DCID` resolves for 50 of the 50 checked.
- Nothing more is needed from the plugin for slice 2. The probe's
  expected-refusal block now holds only `TERMS.ID`.

**2026-09-28 — slice 2a: the gradebook read shapes** (`ps-probe.ts
--shapes`, GET only, node, the test server; prints shapes — keys and
types, values only for booleans, enum-like settings and PowerSchool's
`_name` type tags; dates masked to their format). Target: a pilot-analog
teacher's 2024-25 AP Seminar section (the teacher email and section DCID
are command-line arguments, not recorded here). `SECTIONS.COURSE_NUMBER`
is refused (403), so the section is chosen by DCID — read from the
production PowerSchool section page (`frn=003<dcid>`), which is valid on
the test server because it is a June 2025 copy of production.

- **List responses are plain arrays** (no wrapper) for both
  `/ws/xte/teacher_category` and `/ws/xte/section/assignment/`.
- **Assignment shape confirmed** (`_name: "assignment"`): `assignmentid`,
  `hasstandards`, `standardscoringmethod`, `calculationrelationship`,
  `_assignmentsections[]` (`_name: "assignmentsection"`) with
  `sectionsdcid`, `name`, `description`, `duedate`, `scoretype`,
  `scoreentrypoints`, `weight`, `totalpointvalue`, `extracreditpoints`,
  `iscountedinfinalgrade`, `isscoringneeded`, `publishoption`,
  `isscorespublish`, `islocked`, `assignmentsectionid`, and
  `_assignmentcategoryassociations[]` (`_name: "assignmentcategoryassoc"`,
  `teachercategoryid`, `isprimary`). The embedded field names in "What IT
  established" are right.
- **Points:** `scoretype` seen as `POINTS` and `COLLECTED`; on a points
  row `totalpointvalue` = `scoreentrypoints` × `weight` (10 × 1 = 10). Our
  create sends `scoretype: POINTS`, `scoreentrypoints` = `totalpointvalue`
  = the assessment's `max_points`, `weight: 1`.
- **Dates are `YYYY-MM-DD`** (`duedate`, `publisheddate`,
  `publishonspecificdate`).
- One PowerSchool assignment can span several sections (the sample had
  three `_assignmentsections`); ours always carries one (D-1: one send =
  one section).
- **Categories** (`_name: "teachercategory"`): id `teachercategoryid`,
  `name`, `categorytype` (`user` | `district`), `districtteachercategoryid`
  on district copies, `isactive`, `defaultpublishoption`,
  `defaultscoreentrypoints`, `defaultweight`, `defaulttotalvalue`,
  `isdefaultpublishscores`, `_teachercategorysectionexcludeassociations[]`.
  This teacher had 16 in 2024-25, the four district copies all inactive
  (→ D-6 revised), every one publishing `Immediately`.
- **Not read:** score rows (no plugin GET for scores); the score body
  stays as IT documented it until 2c's first write.
- The shapes file sits gitignored in `design-tool/samples/`; slice 2b turns
  it into hand-written fixtures with synthetic ids.

**2026-09-28 — slice 2b BUILT (not deployed)**: the PowerSchool send on
the mock. **Migration 0046** `gradebook_push` (`gradebook_pushes`,
`gradebook_push_scores`, `gradebook_section_prefs`, attempt-event kind
`gradebook_sent`, staff-only) — applied to dev + test; Aurora takes it at
the next deploy (migrate-on-start). `lib/gradebook/`: `powerschool.ts`
(`GRADEBOOK_PROVIDER=mock|live`, mock default; token cached to
`expires_in − 60 s`, one retry on 401 and on 412; optional injected
`fetch` for 2c's pinned transport; a missing env → 503
`gradebook_not_configured`), `powerschoolPayloads.ts` (categories, D-6
default or null, the 50-character name, the create body),
`powerschoolScoreBodyUnconfirmed.ts` (the score body + its reader, isolated
until 2c's first write), `mapping.ts` (roster ids + the pure `planSend`),
`authorizeSend.ts`, `sendPowerSchool.ts`. Routes `POST
/api/assessments/[id]/gradebook-send` and `GET
/api/assessments/[id]/gradebook-categories` (also returns the remembered
target + category for slice 4). Readings beyond the note: held-back reason
`not_on_roster` beside `unscored` / `no_dcid`; missing teacher / section
ids → 409 `missing_dcid`; the push row is claimed BEFORE the external
create so the live-row unique index settles two concurrent first sends
(409 `send_in_progress`, a stale claim taken over after 2 minutes); a
create whose response carries no id → 502 `create_response_unreadable`
(a duplicate assignment is possible then); nothing to send → no
PowerSchool call; a 404 on the score write archives the push so the next
send creates anew; 409 bodies are logged with every 4+-digit run masked;
the remembered destination is written only when a score reached the
gradebook; 8.3 notes name passed-back and awaiting-scoring students
separately. **Not handled:** deleting an attempt after a send leaves its
score in the gradebook; a send that fails between the external write and
recording it may re-write rows on the next send. Design-tool 2343 tests,
typecheck clean. Next: 2c live check on the test server.

**2026-09-28 — slice 2c STARTED, blocked on a plugin field grant.**
`design-tool/scripts/ps-send-check.ts` (node; read-only unless `--write`;
`--cleanup <assignmentid>` deletes a check assignment with `force=true`)
drives the app's own client, payload and score-body code through the
probe's pinned transport (injected `fetch`), against the pilot-analog
2024-25 section. Found and fixed on the way:

- **2b bug:** the live client cut every response to 4 000 characters
  BEFORE parsing, so a category list with long HTML descriptions parsed as
  zero categories (a real send would have failed the same way). Now only
  an error body is cut; a regression test covers both halves.
- `GradebookHttpError` uses plain fields (node's type stripping refuses
  parameter properties); the schema-table API caps `pagesize` at 100.
- The read-only run resolved the teacher, the section (year 34, first
  semester by its due dates), 31 enrolments with DCIDs, and the categories:
  16, 6 active, district "Test" inactive → no default (D-6 as revised).
  The create and score bodies printed as designed.
- **The first create was refused:** 403 `No access to field`
  `assignment.createdbyplugin` — a column PowerTeacher Pro fills itself on
  a plugin's create, not one we send. Nothing was written. Asked IT for
  plugin v1.3 with write access on every column (audit columns included)
  of ASSIGNMENT, ASSIGNMENTSECTION, ASSIGNMENTCATEGORYASSOC,
  ASSIGNMENTSCORE and ASSIGNMENTSCORECOMMENT (score comments are not sent
  yet — James expects to want them), so the grant is not discovered one
  field per round.
  The deploy of 0046 stays held until 2c's writes pass.

**2026-09-28 — slice 4 BUILT (not deployed), PowerSchool only; decisions
8.1 today / 8.3 leave / 8.4 yes; slice 3 HELD until the PowerSchool send
works end to end.** `lib/gradebook/sendDialog.ts` (pure: `SEND_TARGET`
is the one extension point for a destination picker; `canSendToGradebook`
= edit level; `chooseCategory` = remembered → route default → forced pick,
never first-active; `canSubmitSend`; name cut to 50; `todayLocal`;
`formatSendSummary` / `formatFailure` / `sendErrorCopy` map every route
code to a teacher sentence), `lib/gradebook/sendDialogData.ts` (server:
sections the SENDER currently teaches with handed-in work or an earlier
push, "n scored · m awaiting scoring" from the page's own `buildResults`
rows by the `loadSectionCandidates` section rule, last live push per
section from `gradebook_pushes` — one enrollment query per taught section
per page load), `components/app/SendToGradebookControl.tsx` + the
`SendToGradebookAndReload` wrapper (button beside Print student work;
label "Sent to PowerSchool · <date>" once any section has a push; the
dialog notes the chosen section's own date and reads "Send again";
summary + held-back reasons + failures stay visible until Done, then a
full reload), the results page reads `access.level` via
`authorizeAssessment`, the per-student timeline renders `gradebook_sent`
as "Sent to PowerSchool <time> · N points". Left out: destination picker,
Connect Schoology chrome, the other-target warning (slice 3). Design-tool
2364 tests, typecheck clean; no browser hand-run yet — slice 5 writes the
rows.

**2026-09-29 — slice 2c live check PASSED on the test server (plugin
v1.3), after two fixes.** Run from the district network with
`scripts/ps-send-check.ts` on a 2024-25 section (teacher and section on
the command line, not recorded), plus scratchpad probes. Measured:
- **The create answers 201 with an EMPTY body; `Location` ends in the
  `assignmentid`**, not the `assignmentsectionid`. The first write run
  took the Location number as the section id and the score write answered
  403 "User does not teach section … EDIT". Fixed in `d73201b`: the live
  client GETs `/ws/xte/section/assignment/<assignmentid>` and reads
  `_assignmentsections[0].assignmentsectionid`; both ids are returned and
  logged (`gradebook_assignment_created`).
- **The score write body IT documented is right** (create → 3 scores →
  corrected re-send all read back from ASSIGNMENTSCORE). Its 200 response
  names each student but carries **no `assignmentscoreid`**, so
  `external_score_id` stays null — and a re-send **without** the id
  updates the same row in place (same `assignmentscoreid`, one row). No
  change needed; the mock now answers the same way.
- **A write to a deleted assignment answers 500** "Unable to find
  …AssignmentSection with id …", not 404 — the send never retired the push.
  Now `isAssignmentSectionMissing` treats that 500 (and a 404) as
  `assignment_missing`.
- **One student with no AssignmentStudentAssociation refuses the WHOLE
  batch** (409, nothing written; `errors[].params.student_dcid`). A student
  who left the class, or a roster a night behind, would have blocked the
  class. Now the send holds those students out as
  `not_in_powerschool_section` ("not on this class in PowerSchool (left the
  class?)") and writes the rest once.
- A score above the maximum (12 of 10) is accepted as extra credit; ours
  never exceed max.
Every check assignment was deleted (`--cleanup`, 204). The send's own
code path (DB + route) was not run against the test server — its two new
branches are unit-tested against the measured bodies; rows 314–316 run on
the deployed app.

**2026-09-29 — GB-2 fixed: a Send again checks the assignment still
exists.** Found running rows 314–316 through the app (local dev on the
district network, a loopback relay to the test server): a Send again whose
scores were all unchanged wrote nothing, so an assignment deleted in
PowerTeacher Pro went unnoticed ("2 unchanged") — only a failing write
surfaced `assignment_missing`. Now every send with an earlier push first
reads `GET /ws/xte/section/assignment/?users_dcid=…&section_ids=<dcid>`
(`listAssignmentSectionIds`). Measured the same day: a plain array, no
paging (`pagesize` ignored), the id a NUMBER at
`_assignmentsections[].assignmentsectionid`; 26 assignments / 28 KB on
the check section. Missing → the push is archived, every student (to be
written or unchanged) fails `assignment_missing`, the note is shown,
nothing is written. An unreadable list refuses the send (502
`gradebook_unavailable`) and keeps the push — never read as "deleted",
which would duplicate the assignment. Cost: one read per Send again, of
the whole section list. Row 316 re-run ✅. Two further readings from the
run: the check teacher has no "Test" category (the D-6 default is absent,
the dialog asks for a pick), and the due date must fall inside the
section's term (today's date is outside a 2024-25 test copy).

**2026-09-29 — production wiring (built, not deployed).** IT issued the
production plugin credentials; James added them to the app secret with a
hidden-prompt script kept outside the repo (`POWERSCHOOL_BASE_URL` /
`_CLIENT_ID` / `_CLIENT_SECRET` — the base URL rides in the secret so the
district hostname stays out of the repo). Production PowerSchool is
reachable from the internet (James), unlike the test server.
`infra/lib/app-service.ts` maps the three keys into the task and sets
`GRADEBOOK_PROVIDER=live` — Send to gradebook for every teacher with edit
access (James). New read-only operator mode `ps-reach`
(`scripts/ps-reach.ts`, `oneoff-aurora.sh ps-reach [teacher@psd401.net]`):
the OAuth token plus one category read through the task's own network path,
printing statuses and counts only. Run it right after the deploy, before
the first real send.
