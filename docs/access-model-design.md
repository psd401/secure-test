# Access model — co-teachers, substitutes, principals, system admins

Design note, 2026-09-17. Roadmap `docs/roadmap-2026-09.md` §"Unscoped —
needs decisions" rows **U-1** (co-teachers), **U-2** (substitutes), **U-3**
(principals) and **U-6** (system admin: see in-progress work, impersonate
staff). The four share one missing thing, so this note designs that thing
once and treats the four as its cases. Design tool only; nothing in the
client or the shared schema moves (a student's plane is untouched: the
client authorizes by sitting + roster membership, not by who owns the
assessment). Decisions marked **D-n** are James's and are listed at the
end; **§Progress says what is built** (slice 1 as of 2026-09-17).

## What exists that this stands on

- **Two roles from the email domain** (`lib/auth/roles.ts`): `psd401.net`
  → `staff`, `edtools.psd401.net` → `student`, anything else → denied.
  The session JWT carries `sub`, `role`, `email`. There is no admin, no
  building, no hierarchy. `assessments.assigned_scope`
  (`teacher|school|district`) exists as a column and nothing enforces it.
- **Every staff row is owner-only by `owner_sub`**: assessments, test
  sessions, the accommodations overlay (`students`), rubrics, assets;
  attempts / items / responses inherit through the assessment. Enforcement
  is `requireStaff()` for the role plus a per-row `owner_sub ===
  session.sub` check — done through a helper (`loadOwnedAssessment`,
  `loadOwnedAttempt`) in 10 route files and **inline in 36**, in two
  styles (owner in the WHERE → 404; select-then-compare → 403, which leaks
  existence). The dashboard pages repeat the same six query patterns.
- **The only cross-teacher mechanism is sharing with copy semantics**
  (`assessment_shares`, 2026-09-01): accept = export the owner's bundle,
  import it under the recipient's `owner_sub`. Nothing is co-owned; no
  other route consults the shares table.
- **Roster visibility is a separate axis keyed on email**: "my sections" =
  `roster_section_teachers.teacher_email = session.email` and current
  (`sectionsCurrentlyTaughtBy`). The table's primary key is
  `(section_ps_id, teacher_ps_id, start_date)` — **a section can already
  carry several teacher rows**, and the warehouse DOES send them
  (measured 2026-09-17 on that morning's snapshot: `role_name` is one of
  `Lead Teacher` / `Co-teacher` / `Student Teacher`; 243 of 4644 sections
  have more than one teacher row; a known co-taught English section
  carries both teachers with the same dates). The importer stores
  `role_name` + `priority_order`; `sectionsCurrentlyTaughtBy` does not
  filter on role, so a co-teacher already sees the section and can start a
  sitting on it — what is missing is only the shared assessment. Sections
  carry `school_id`.
- **Audit is per feature, not general**: `attempt_deletions.deleted_by_sub`,
  `attempts.submitted_by_sub`, `deadline_extended.detail.by`,
  `peek_requests.requested_by`, `scores.reviewed_by_sub`. No log of edits,
  publishes or sitting creation beyond row timestamps.
- `test/auth-role-enforcement.test.ts` enumerates every route from disk
  and checks ROLE (401 / 403). Nothing enumerates OWNERSHIP.

## The four cases, stated as access questions

| Case | Who | Needs to | On what | For how long | Granted by |
|---|---|---|---|---|---|
| U-1 co-teacher | a second teacher of the same section | everything the owner can: edit, publish, run sittings, monitor, score, see results | one assessment (and its sittings + attempts) | while they co-teach | the owner (or the roster, if it names co-teachers) |
| U-2 substitute | a staff member covering a class | run the day: see the roster, start / close a sitting, monitor, view screen, hand in, extend; NOT edit, NOT results | one teacher's sections (or one section) | a day or a range | the teacher, or an admin |
| U-3 principal | a building leader | read: results, in-progress counts, integrity timelines; NOT edit, NOT run | every teacher in a building | standing | an admin |
| U-6 system admin | James + named others | read everything incl. in-progress sittings; act as any staff user | the district | standing | configuration |

Two things fall out. First, a **grant** is the unit: (who, what scope,
what level, from, until, granted by). Second, the level is a small ladder,
not per-action flags: `view` (results and monitor, read-only) < `run`
(view + sittings, monitor actions, hand in, extend) < `edit` (run + items,
settings, publish, scoring) < `own` (edit + share, archive, delete, grant).

## Design

### The principal: role + admin list (D-1)

- `role` stays email-derived (`staff` / `student`). **System admin is a
  configuration list, not a role**: `ADMIN_EMAILS` (comma-separated) in
  the task environment, read once at boot, compared to `session.email`.
  One to three people, changed by a deploy — the same posture as every
  other provider selector. A `staff_roles` table would be the alternative
  and is not worth its own UI for three rows; revisit if the list grows.
- `isAdmin(session)` is the one new predicate. It never widens
  `requireStaff()`'s ROLE check (an admin is staff); it widens the
  OWNERSHIP check below.

### The grant: one table (D-2)

```
access_grants
  id              uuid pk
  grantee_email   text      -- staff email, lowercased (the roster key)
  scope_kind      text      -- 'assessment' | 'teacher' | 'school'
  scope_id        text      -- assessment uuid | teacher email | school_id
  level           text      -- 'view' | 'run' | 'edit' | 'own'
  starts_at       timestamptz not null default now()
  ends_at         timestamptz null    -- null = standing
  granted_by_sub  text not null
  granted_by_email text not null
  note            text null           -- "sub for 9/18", "co-teacher"
  revoked_at      timestamptz null
  created_at
  unique (grantee_email, scope_kind, scope_id) where revoked_at is null
```

- `assessment` scope = co-teacher (level `edit` or `own`). `teacher`
  scope = substitute or principal-on-one-teacher (level `run` / `view`)
  — "everything this teacher owns", resolved through the owner's email.
  `school` scope = principal (level `view`) — "every teacher whose current
  sections sit in this `school_id`", resolved through the roster.
- The `teacher` arm resolves through **`assessments.owner_email`**, added by
  migration 0038 because the assessment row carried only `owner_sub` and there
  is no staff table to map a sub to an address (slice 2, §Progress deviation 1).
- Keyed on **email**, not sub, on purpose: a substitute may never have
  signed in when the grant is made, and the roster's own key is email.
  The session carries both.
- Time-boxed by `starts_at` / `ends_at`; a sub's grant expires on its own.
  Revoke sets `revoked_at`; the row stays as the audit record.

### Enforcement: one helper replaces 36 inline checks (D-3)

```ts
// lib/api/access.ts
type Level = "view" | "run" | "edit" | "own";
authorizeAssessment(db, session, assessmentId, need: Level)
  → { ok: true, assessment, level, via: "owner" | "grant" | "admin" }
  | { ok: false, response: 404 }          // never 403: no existence leak
authorizeSitting(db, session, sittingId, need)     // through its assessment
authorizeAttempt(db, session, attemptId, need)     // through its assessment
```

- Resolution order: owner → `own`; admin → `own` (D-6 says what admin
  writes are allowed); else the highest unexpired, unrevoked grant whose
  scope covers the row (assessment id, the owner's email, the owner's
  current school). Every route asks for the level it needs; the helper
  answers 404 below it.
- **Slice 1 is a pure refactor**: every inline `owner_sub` check moves to
  the helper with `need: "own"` and no grants table yet, so behaviour is
  identical and the diff is reviewable route by route. A new enumerating
  test asserts every `app/api/**/route.ts` that loads an assessment,
  sitting or attempt imports the helper (the role test's pattern), so the
  next route cannot regress to inline.
- The dashboard's list queries widen the same way: "assessments I can
  see" = owned ∪ granted (with a "Shared with you as co-teacher" /
  "Covering for <teacher>" label on the row).
- Student-plane routes are untouched: a student's access is the sitting's
  scope + roster membership and never consults grants.

### Co-teacher (U-1) — D-4

- "Share" gains a second mode beside copy: **Co-teach** (grant `edit` on
  the assessment). The co-teacher sees the assessment in their list, edits
  it in place, starts sittings on THEIR sections (`sectionsCurrentlyTaughtBy`
  keeps working per person), and sees every sitting + attempt on it.
  `owner_sub` does not change; the owner alone shares, archives, deletes.
- Sittings show in both lists because the query is "sittings whose
  assessment I can see", not `owner_sub`. Monitor actions on a sitting
  need `run`, which `edit` includes.
- **Roster-driven**: the roster names co-teachers (`role_name =
  'Co-teacher'` on the same section, current dates), so the grant can come
  from it. Two shapes, D-4 chooses: (a) **implicit** — `authorize*` treats
  "a current co-teacher of any section the owner currently teaches" as an
  `edit` grant on every assessment the owner has, no row written, and the
  Share dialog shows "Co-teachers: <emails> can already edit this"; or
  (b) **suggested** — the Share dialog lists the roster's co-teachers with
  one-click Co-teach, writing a real `access_grants` row. (a) is zero
  clicks and follows the roster when co-teaching ends; (b) is explicit,
  per-assessment, and auditable. Either way Student Teacher rows are NOT
  co-teachers (a `run`-level grant by the lead, later).

### Substitute (U-2) — D-5

- The teacher (from Students or a new "Coverage" card on the home) or an
  admin grants `run` on `teacher:<their email>` for a date range. The sub
  signs in with their own `psd401.net` account and sees "Covering for
  <teacher> until <date>" with that teacher's Published assessments and
  sections, can start / close / monitor / hand in / extend, and cannot
  open the editor or the results pages.
- Sitting creation under a grant records `owner_sub` = the TEACHER (so
  the sitting stays the teacher's after the sub leaves) and
  `created_by_sub` = the sub (new column, audit).
- The one-day teacher-row script's job — a real section for a hand-run —
  is a different problem and stays a script.

### Principal (U-3) — D-7

- Grant `view` on `school:<school_id>`; resolution = every teacher with a
  current section in that school. Read-only: results list, per-student
  page, print report, work packet, integrity timeline; the Monitor in
  read-only form (no actions, no View screen). Building comes from the
  roster's `sections.school_id`; a principal of two buildings gets two
  grants.
- Later, not v1: a building dashboard (sittings open now across the
  school). Slice 6 is the grant + read-only routes only.

### System admin (U-6) — D-6, D-8

- `isAdmin` → `own` on everything for READS. An `/admin` page: open
  sittings district-wide (code, teacher, section, joined / handed in
  counts, started), the grants table with create / revoke, the error /
  feedback tables that exist already.
- **Impersonation = act-as**: `POST /api/admin/impersonate { email }`
  issues a session JWT with `sub` / `email` / `role` = the target's and
  `actor_sub` / `actor_email` = the admin's; every page shows a persistent
  banner "Acting as <email> — stop"; `stop` restores the admin's own
  session. `impersonation_sessions` records start, stop, actor, target.
  Every existing "who did this" column keeps recording the TARGET's sub
  (that is what the teacher would see), and the request-id log line
  carries `actor_sub` so the server log can always tell the two apart.
- **Admin writes outside impersonation are limited to the admin surface**
  (grants, the admin page); an admin who needs to change a teacher's
  assessment impersonates them, so the audit trail names one path.

### What is NOT in this note

- Teacher practice sittings (U-4) and placeholder students (U-5): no
  access-model change; they are their own notes.
- Assignment scope (`assessments.assigned_scope` school / district): the
  column stays unused until a district-authored assessment exists.
- An org chart: principal-of-building comes from grants + the roster's
  school id, not from a staff directory the app does not have.

## Slices

| # | Slice | Size / model |
|---|---|---|
| 0 | This note; D-1…D-8 | — |
| 1 | `lib/api/access.ts` + the refactor of every inline owner check to `authorize*` with `need: "own"`; the enumerating test; no behaviour change, no migration | L — Opus 5 / medium, one commit per route group (assessments, sittings, attempts, students/rubrics/assets) |
| 2 | Migration: `access_grants`, `test_sessions.created_by_sub` (+ `assessments.owner_email` — see §Progress deviation 1; `impersonation_sessions` moved to slice 5); `ADMIN_EMAILS` + `isAdmin`; grant resolution inside the helper; per-route levels; list-query widening; the grants API | M — Opus 5 / medium |
| 3 | Co-teach: the Share dialog's second mode, the "Shared with you as co-teacher" row label, sittings visible to both; rows | S — Sonnet 5 / medium |
| 4 | Substitute: Coverage card (teacher) + admin grant, the sub's home, read-only editor / results refusal, `created_by_sub` on sittings; rows | **DEFERRED 2026-09-18 with slices 5 + 6** — revisit substitute, admin and principal accounts together |
| 5 | Admin: impersonation (`POST /api/admin/impersonate` + `/stop`, the act-as banner, `impersonation_sessions` = **migration 0040**), the `/admin` page (open sittings district-wide, Act as, Monitor), the admin-only Admin nav link, Act as on the all view's foreign rows; rows 246–252 | **BUILT 2026-09-21** (M — Opus 5). The grants console moved out to 5b |
| 5b | Admin: the grants console (create / revoke at `teacher` and `school` scope over `/api/grants`, which exists and has no UI), the error / feedback tables | **DEFERRED with slice 6** — no grantee exists until substitutes (4) or principals (6) do |
| 5a | **System-admin "All teachers" view** (2026-09-21): home `?all=1` toggle for `isAdmin` — every non-archived assessment with owner email, status, attempt count, Results / Monitor links; the sittings strip likewise; owner-only actions hidden on rows the admin does not own (D-6); non-admins see no toggle and `?all=1` changes nothing; rows | S — Sonnet 5 / medium |
| 6 | Principal: `school` scope resolution, read-only Monitor + results; rows | **DEFERRED to a later release (D-7)** |

Slice 1 alone is worth shipping: it removes 36 copies of the ownership
check and adds the test that keeps it that way.

## Decisions (James)

- **D-1** System admin = `ADMIN_EMAILS` in the task environment (not a
  table, not a role). — **DECIDED as recommended (James, 2026-09-17)**
- **D-2** One `access_grants` table keyed on grantee EMAIL with scope
  `assessment | teacher | school` and level `view < run < edit < own`,
  time-boxed, revoke = soft. — **DECIDED as recommended (James, 2026-09-17)**
- **D-3** Slice 1 refactors every inline owner check to one helper that
  answers 404 (never 403) before any grant exists. — **DECIDED as recommended (James, 2026-09-17)**
- **D-4** Co-teacher: (a) implicit from the roster (`Co-teacher` on a
  shared current section → `edit` on all of the lead's assessments, no
  row) or (b) roster-suggested explicit grants from the Share dialog,
  per assessment. `owner_sub` unchanged either way. — recommendation:
  **(b)** for v1 — a teacher may co-teach one section and not want every
  assessment shared; the roster still makes it one click. — **DECIDED (b)
  (James, 2026-09-17; shared ownership is the goal)**
- **D-5** Substitute = a `run` grant on the teacher for a date range,
  made by the teacher or an admin; sittings stay the teacher's with
  `created_by_sub` = the sub. — **DECIDED as recommended (James, 2026-09-17)**;
  refined 2026-09-18 (James): the sub gets the MONITOR ONLY — no results
  surfaces of any kind; both the teacher (self-delegation, range capped at
  31 days) and an admin (uncapped, via `/api/grants`) may grant; a
  long-term sub stays a `run` grantee until the roster reassigns the
  section (no edit) — acceptable. **Slice 4 DEFERRED 2026-09-18 (James)**
  with slices 5 and 6: substitutes, admins and principals are revisited
  together when the account model is next on the table; the refinements
  above are the design when it is.
- **D-6** Admin reads everything; admin writes outside the admin surface
  go through impersonation. — **DECIDED as recommended (James, 2026-09-17)**
- **D-7** Principal = a `view` grant on a `school_id`; read-only
  surfaces only in v1. — **DEFERRED (James, 2026-09-17): principals are
  not a user in this release; the `school` scope stays in the table's
  design so slice 6 can land later without a migration.**
- **D-8** Impersonation = a second session JWT carrying `actor_*`, a
  persistent banner, `impersonation_sessions` audit; the target's sub is
  what the feature tables record. — **DECIDED as recommended (James, 2026-09-17)**;
  **Clarified 2026-09-21 (James): two different "admins".** The SYSTEM
  admin (the maintainer, `ADMIN_EMAILS`) is wanted NOW — the first need is
  reading the pilot's results across teachers; the BUILDING admin
  (principal, D-7) is the one deferred. Slice 5a below = an "All teachers"
  view on the home for `isAdmin` sessions (read-only listing; every
  downstream page already resolves the admin to `own`). Impersonation and
  the grants console (5b) stay deferred with slice 6.
  **slice 5 DEFERRED 2026-09-18 (James)** with slices 4 and 6: admin and principal
  accounts are wanted but too early to commit to a design direction;
  revisit together. `ADMIN_EMAILS` + admin resolution from slice 2 stay
  as built (inert while the list is empty).

## Progress

- 2026-09-17 — note written; D-1…D-8 decided the same day (D-4 = (b),
  D-7 deferred).
- 2026-09-17 — **slice 1 BUILT** (pure refactor, no migration, no grants):
  `design-tool/lib/api/access.ts` holds the ladder, the six
  `authorize*(db, session, id, need)` entry points (assessment, sitting,
  attempt, overlay student, rubric, asset) and the three `page*` wrappers the
  dashboard pages use. Every inline owner check in `app/api/**/route.ts` and
  every by-id load in `app/dashboard/**` now goes through it; `lib/api/loadOwned.ts`
  is deleted and `loadOwnedAttempt` is gone from `lib/api/staffAttempt.ts`
  (`sittingIsOpen` / `sessionOpenResponse` stay). The shared loaders that used
  to carry their own comparison — `loadItemSetForSession` (was
  `loadOwnedItemSet`), `checkSourceItem`, `loadResponseChain`,
  `rejectUnownedRubricId`, `duplicateAssessment` — take a session (or an
  already-authorized row) and defer to the helper. List queries are untouched:
  slice 2 widens them. `test/access-enforcement.test.ts` enumerates the routes
  from disk and holds each to one of four classifications (student plane, no
  owned row, via a named shared loader, or imports `@/lib/api/access`), refuses
  an inline `owner_sub` comparison, and unit-tests the helper itself.
  **The one accepted behaviour change (D-3): every select-then-compare 403
  became a 404** — assessments GET/PATCH/DELETE, export, items (collection +
  one + reorder + both imports), item sets (4 routes), overrides (GET/POST/
  DELETE, incl. `student_forbidden` → 404 `student_not_found`), results,
  review-queue, rubric extract, shares (2), generate-item, students `[id]`,
  student accommodations (POST + the two TIDE-diff routes), attempts
  (DELETE / extend / hand-in / score / score-ai / peek / peek-image),
  response score / rescore-ai / approve, assets `[id]`, and the two dashboard
  pages that rendered a "Forbidden" panel (results, scoring) which now
  `notFound()`.
- 2026-09-17 — **slice 2 BUILT** (migration **0038**, `0038_access_grants.sql`,
  applied to dev + test). What landed:
  - **`access_grants`** exactly as §"The grant" specifies, plus the partial
    unique index `access_grants_live_unq` on `(grantee_email, scope_kind,
    scope_id) where revoked_at is null` and an index on `grantee_email`. Revoke
    is soft, so the partial index is what makes re-granting after a revoke a new
    row rather than a conflict, and a 23505 from it is the expected outcome of a
    race → 409 `already_granted`.
  - **`test_sessions.created_by_sub`** (D-5, audit only — nothing authorizes on
    it), written by the sitting-creation route from this slice on.
  - **`ADMIN_EMAILS`** (D-1): `lib/auth/admin.ts` — `adminEmails()` /
    `isAdmin(session)`, memoised on the raw value, empty when unset. Added to
    `.env.local.example` (commented) and to the task environment from the NEW cdk
    context key **`adminEmails`** (string, default `""`, the stack does NOT throw
    without it — an empty list is a correct deployment). `cdk.context.json.example`
    and the infra README's new context table carry it.
  - **Resolution** (D-2/D-6) in `lib/api/grants.ts`, called by
    `lib/api/access.ts`: owner → `own`/`owner`; admin → `own`/`admin`; else the
    highest live grant covering the row. `loadActiveGrants(db, email)` is ONE
    query carrying the whole liveness rule (`revoked_at is null`, `starts_at <=
    now()`, `ends_at is null or > now()`) and `grantedLevel(grants, row)` is
    pure, so a fifty-row list resolves with one query. `effectiveLevel` is the
    single-row door. Every `ok: true` access result now also carries `scope` —
    the grant scope it came through, or null for an owner/admin.
    `lib/api/accessLevels.ts` is a new four-export module holding the ladder,
    because access.ts ↔ grants.ts would otherwise be an import cycle whose
    module-level arrays are read during the other's initialisation; access.ts
    re-exports it, so routes still import levels from `@/lib/api/access`.
  - **`school` scope is stored and never resolved** (D-7). `RESOLVED_SCOPES` in
    grants.ts lists `assessment` and `teacher` only, and two tests assert a
    school grant confers nothing — through the helper and through the list.
  - **Per-route levels**: slice 1's uniform `"own"` replaced by the level each
    route actually needs (table in the slice's report; the note's ladder is the
    authority). Two notes on the edges: `PATCH /api/assessments/[id]` asks for
    `own` when it is the status-only ARCHIVE patch and `edit` otherwise — archive
    sits beside share and delete on the ladder, and the two shapes can never
    arrive together because the archive patch is already required to be
    status-only. `GET /api/assessments/[id]`, `export`, `results`,
    `review-queue` and the preview are all `view`, which means `view` is the
    level at which an answer KEY is readable — already true of export, and stated
    here rather than left implicit. The per-teacher tables (`students`,
    `rubrics`, `assets`) stay owner-only: no assessment grant reaches them, an
    admin does.
  - **`app/preview/[id]/route.ts` was the last inline owner check in the tree** —
    slice 1 swept `app/api/**` only, so that route kept its select-then-compare
    403. It now goes through `authorizeAssessment(…, "view")`, and
    `test/access-enforcement.test.ts` sweeps `app/preview` as a second root so
    the next non-api route cannot repeat it. Its asset lookup is now scoped to
    the ASSESSMENT's owner rather than the caller, or a co-teacher's preview
    would render `[image not found]` for every one of the lead's images.
  - **List widening**: `lib/api/visibleAssessments.ts` —
    `visibleAssessmentScope(db, session)` hands out one SQL fragment plus a pure
    annotator, and `visibleAssessments(...)` is the rows themselves with
    `access: { level, via, owner_email? }` on each. Used by the home page (list,
    archived count, Open-now strip, question and attempt counts — all five
    queries, so they cannot disagree), `GET /api/assessments`, and
    `GET /api/test-sessions`, whose predicate is now "sittings whose ASSESSMENT
    I can see" — the same authority `authorizeSitting` uses, so a sitting can no
    longer list and then 404. Archived / `?archived=1` semantics unchanged. The
    home page's Duplicate / Archive / Delete buttons now render only on a row the
    caller owns, since all three are `own` routes.
  - **Grants API**: `GET/POST /api/assessments/[id]/grants` and
    `DELETE …/grants/[grantId]` (all `own`; scope fixed to `assessment` and this
    id, so a teacher can never write a teacher- or school-scoped grant), and
    admin-only `GET/POST /api/grants` for the other scopes — **404 for a
    non-admin, not 403** (D-3: a 403 would tell any teacher that an admin API
    exists and that they are not on the list). Grantee rules, shared by both:
    must be staff by `roleForEmail(email, true)`, never self, and `own` is
    admin-only to grant — an `edit` co-teacher can change the assessment but
    cannot hand it to a third person.
  - **Sitting creation under a grant** (D-5): `POST /api/test-sessions` needs
    `run`, not ownership. An owner, an admin or an ASSESSMENT-scoped grant
    (co-teacher) creates a sitting that is the CALLER's — they run their own
    section, so `owner_sub` / `owner_email` must be theirs or redemption scopes
    the roster to the wrong teacher and admits nobody. A TEACHER-scoped grant (a
    substitute) creates a sitting that stays the granting teacher's
    (`owner_sub` / `owner_email` from the assessment) with `created_by_sub` = the
    sub, so it admits the teacher's students and survives the sub leaving.
    `sectionsCurrentlyTaughtBy(session.email)` is unchanged, which means a
    substitute cannot yet NAME a section they do not themselves teach — slice 4's
    problem, recorded here rather than half-solved.

  **Deviations from the note, both deliberate:**
  1. **`assessments.owner_email` was added in the same migration** (backfilled
     from the newest `test_sessions.owner_email` per assessment, and written on
     create / import / duplicate / share-accept from the session's email).
     `access_grants` is keyed on grantee EMAIL by design, and a `teacher`-scoped
     grant has to resolve through the OWNER's email — but an assessment carried
     only `owner_sub`, and there is no staff table to map one to the other.
     Consequence, stated because it is visible: **a teacher-scope grant does not
     resolve for an assessment whose `owner_email` is still NULL** — one nobody
     has ever sat and whose owner has not touched it since the backfill. It
     starts resolving the next time that owner creates, imports or duplicates;
     an `assessment`-scoped grant is unaffected.
  2. **`impersonation_sessions` was NOT created.** The slices table listed it
     under slice 2, but nothing in this slice writes or reads it and D-8's
     act-as flow is slice 5's whole subject; an unused table shipped early is a
     migration to get wrong twice. Slice 5 adds it with the code that uses it.

  Tests: `test/access-grants.test.ts` (resolution, the ladder per level, expired
  / future / revoked, teacher scope through `owner_email`, school-scope inertness,
  admin, list widening, the sitting branches) and `test/grants-api.test.ts` (both
  surfaces, the grantee rules, 409, scoped revoke, the admin 404). Design-tool
  **2017** tests (1985 before), typecheck clean.
- 2026-09-17 — **slice 3 BUILT** (Share dialog's Co-teach mode, D-4 (b)):
  - `lib/roster/coTeachers.ts` — `coTeachersOf(db, teacherEmail)`, a pure
    roster READ (writes nothing; the caller decides whether to grant). A
    current co-teacher of `teacherEmail` on a section they currently share:
    the OTHER teacher's row is `Co-Teacher` regardless of the caller's own
    role, OR the caller's own row is `Co-Teacher` and the other's is `Lead
    Teacher` (co-teaching is symmetric — a lead sees their co-teacher back,
    from the co-teacher's own query). `Student Teacher` never counts, either
    side. Matched case-insensitively (`lower(trim(role_name))`) because the
    fixture spells it `Co-Teacher` and the note's own warehouse measurement
    spells it `Co-teacher`. `lib/roster/queries.ts` grew
    `teacherAssignmentIsCurrentOn(table)`, a generic version of the existing
    `teacherAssignmentIsCurrent` so the self-join's two `alias()`d sides
    share the one liveness rule instead of a second copy of it.
  - `GET /api/assessments/[id]/grants/suggestions` — `own` (an owner
    deciding who to co-teach with is the same act as granting), 404 for
    anyone else including a non-admin co-teacher. Resolves suggestions
    through the ASSESSMENT's `owner_email`, not the caller's, so an admin
    calling it sees the real owner's roster.
  - `components/app/ShareDialog.tsx` grew a second section, Co-teach, beside
    the unchanged "Send a copy": a roster suggestions list with one-click
    Co-teach, a manual staff-email field, and the current co-teachers
    (`edit`/`own`-level live grants on this assessment) with Remove.
    `lib/ui/errorCopy.ts` grew `coTeachErrorCopy` for the codes
    `validateGrantRequest` returns. The dialog itself gates nothing new —
    it is reachable only from the Share button, which the caller already
    hides for a non-owner.
  - `app/dashboard/[id]/page.tsx` now calls `authorizeAssessment` directly
    (was `pageAssessment`) so the editor gets `via` and `owner_email`
    alongside the row. `app/dashboard/[id]/AssessmentEditor.tsx` gates
    Share and the Settings tab's Duplicate / Archive / Delete draft on
    `access.via === "owner"` (exported as the pure `isOwnerAccess`) —
    narrower than `level === "own"` on purpose, so an admin's `own` (D-6)
    does not light up owner-only WRITE buttons outside the admin surface
    ahead of slice 5's impersonation. Publish/Unpublish is UNCHANGED
    (unconditional): that PATCH is `edit`, which a co-teacher's grant
    already reaches. A co-teacher's own view carries a "Co-teaching
    (owner: …)" badge (`coTeachingBadgeText`, pure, falls back to the bare
    label when `owner_email` is still NULL — the migration 0038 deviation).
  - **Row labels**: the home list (`app/dashboard/page.tsx`) and the "Open
    now" sittings strip both read `access.via === "grant"` off the same
    `visibleAssessmentScope` annotation slice 2 already computes, and print
    "Shared with you as co-teacher · by \<owner_email\>" — one fact, shown
    everywhere it applies, never recomputed per view.
  - Preview needed no change (`app/preview/[id]/route.ts` already resolves
    through `authorizeAssessment(..., "view")` as of slice 2).
  Tests: `test/co-teachers.test.ts` (the roster query — symmetric, multi-section,
  Student Teacher excluded either side, an expired co-teach row excluded,
  two Lead Teachers are not co-teachers, unknown/blank email), 
  `test/grants-suggestions-route.test.ts` (own-only 404, admin resolves
  through the OWNER's roster, a malformed id, an assessment with no
  `owner_email` yet), and `test/co-teach-ui.test.tsx` (the pure gates —
  `isOwnerAccess`, `coTeachingBadgeText`, `sectionLabel`, `coTeachErrorCopy`
  — `<ShareDialog>`'s Radix `Dialog` renders nothing through
  `renderToStaticMarkup` while open, confirmed by probe, so the UI logic is
  tested as pure functions rather than markup, the same posture as
  `test/extend-time-control.test.tsx`). Design-tool **2040** tests (2017
  before), typecheck clean. Rows 222–230 in
  `docs/design-tool-manual-checks.md` ("Co-teach") are NOT RUN — most need a
  SECOND staff account (a co-teacher pilot pair, or a minted second token).
- **2026-09-17 evening — slices 1–3 PUSHED + DEPLOYED: LIVE at
  https://<origin> = origin/main `365fb78`, task def rev 41, rollout
  COMPLETED, health stamp = HEAD, Aurora at 0038 (39 journal rows) — the
  first deploy run end to end by `design-tool/infra/scripts/deploy.sh`.**
  `adminEmails` was UNSET in the context file, so nobody is admin on rev
  41 (valid; add it before the next deploy). Rows 222–230 NOT RUN (second
  staff account). Slices 4 (substitute) and 5 (admin + impersonation)
  next; 6 deferred (D-7).

- 2026-09-18 — slice 4 (substitute) was started by an agent and STOPPED
  mid-build when James deferred it; the partial work is parked on branch
  `claude/access-slice-4-deferred`, its migration 0039 rolled back locally
  (0039 now belongs to pass back). Nothing of it is on `main`.

- **2026-09-21 — slice 5a BUILT** (D-6 clarified the same day: the SYSTEM
  admin's "All teachers" view is wanted now; impersonation + the BUILDING
  admin stay deferred with slice 6). No migration. What changed:
  - `lib/api/visibleAssessments.ts`: `visibleAssessmentScope` /
    `visibleAssessments` gained an `{ all?: boolean }` option. An admin's
    DEFAULT list is now the same owned ∪ granted scope as anyone else —
    "My assessments," which is empty for a pure admin who owns and is
    granted nothing — and `{ all: true }` is the explicit widening to
    every non-archived (or, with `archived`, every archived) row,
    `via: "admin"`. Ignored for a non-admin either way, never a 403/404.
    This is a **behaviour change from slice 2**, which had the admin
    branch return everything unconditionally; `authorizeAssessment` and
    every per-row page are untouched — an admin still resolves to `own`
    on any row regardless of this flag, which is what lets Results open
    for a row the admin does not own even from the default list.
  - `GET /api/assessments` and `GET /api/test-sessions` both gained the
    same admin-only `?all=1`, one pattern for both (the home page, the
    list route and the sittings route all go through
    `visibleAssessmentScope`, so they cannot disagree).
  - `app/dashboard/page.tsx`: an admin-only "All teachers" / "My
    assessments" link beside "Show archived," composable with it
    (`dashboardHref`, pure); `showAllTeachersToggle` (pure, `isAdmin`) and
    `homeListMode` (pure) gate it. The all view's header reads "All
    teachers' assessments (N)"; the table gains an Owner column
    (`a.owner_email ?? "—"`); the Open-now strip names the owner on a
    `via: "admin"` card the same way it already named a co-teacher's
    owner on a `via: "grant"` card. **Found + fixed in the same slice**:
    the row actions (Duplicate / Archive / Delete) were gated on
    `accessFor.get(a.id)?.level === "own"`, which is true for an admin on
    EVERY row it can see (D-6 resolves admin to `own` via `"admin"`) — so
    an admin viewing the all list would have seen those buttons on rows
    it does not own. Changed to `via === "owner"`, the same narrower gate
    slice 3's `isOwnerAccess` already uses on the editor, with the same
    rationale recorded there.
  - `test/access-grants.test.ts`: the slice-2 test asserting
    `visibleAssessments(db, ADMIN)` (no options) returns everything was
    the behaviour being changed here — replaced with one test for the new
    default (own-only) and one for `{ all: true }`, plus a non-admin
    ignores-the-flag test. New admin `?all=1` tests in
    `test/assessments-api.test.ts` and `test/test-sessions-api.test.ts`.
    New `test/all-teachers-ui.test.ts` for the three pure page exports
    (`showAllTeachersToggle`, `homeListMode`, `dashboardHref`), same
    posture as `test/co-teach-ui.test.tsx` (no DOM harness here).
    `test/reporting-views.test.tsx`'s `DashboardPage` tests are
    unaffected (no `ADMIN_EMAILS` in their session). Design-tool **2093**
    tests (2082 before), typecheck clean.
  - Rows 239–244 in `docs/design-tool-manual-checks.md` ("System admin —
    All teachers") are NOT RUN — needs an `ADMIN_EMAILS` address plus a
    second, non-admin staff account.
- **2026-09-21 — slice 5a PUSHED + DEPLOYED: LIVE at https://<origin> =
  origin/main `03fa3b6`, task def rev 43, rollout COMPLETED, health stamp
  = HEAD, no migration (Aurora stays at 0039).** Rows 239–244 NOT RUN.
- **Rows 239–242 ✅ 2026-09-21** (Chrome on the origin, rev 43). Two
  findings, proposals only: **A5-1** the Owner column reads "—" on the
  admin's own older rows (`owner_email` is backfilled from sittings only;
  fix = fall back to "you" for `via === "owner"`, or backfill from the
  session at next PATCH); **A5-2** the all view's extra column pushes
  Delete behind a horizontal scroll — the A-1 fix (`w-full max-w-0` on the
  name cell) needs the same treatment with the Owner column present.
- **2026-09-21 — A5-1 + A5-2 fixed; isUniqueViolation cause-walk.**
  `app/dashboard/page.tsx` gains an exported pure `ownerCell(access,
  owner_email)`: "you" when `via === "owner"` (regardless of
  `owner_email`), else `owner_email ?? "—"` — the admin's own row no
  longer reads as ownerless. The Owner `TableCell` takes the same
  `w-full max-w-0 truncate` treatment A-1 gave the name cell (auto table
  layout otherwise ignores a cell's max-width), with the full address on
  `title`. Tested in `test/all-teachers-ui.test.ts`. Separately,
  `lib/api/testSessions.ts`'s `isUniqueViolation` read `err.code` off the
  top-level error only, so a real sitting-code collision wrapped in
  Drizzle's `DrizzleQueryError` (SQLSTATE on `.cause`) rethrew as a 500
  instead of retrying with a new code — the same bug `lib/api/grants.ts`
  had already fixed for its own copy. Extracted the cause-walking version
  to `lib/db/isUniqueViolation.ts` and pointed both call sites plus
  `app/api/attempts/route.ts`'s (same top-level-only bug, found by the
  same grep) at it. New `test/isUniqueViolation.test.ts` (the helper) and
  `test/create-session-with-code.test.ts` (a mocked `DrizzleQueryError`
  collision proves the retry path is actually taken, plus the exhaustion
  and non-collision cases). Design-tool **2106** tests (2093 before),
  typecheck clean; no migration. Row 240's findings marked FIXED in
  `docs/design-tool-manual-checks.md` — re-check on the next deploy.
- **2026-09-21 — A5-1 / A5-2 / A5-3 + the isUniqueViolation cause-walk
  DEPLOYED: LIVE = origin/main `d4e59bc`, task def rev 46 (44 and 45 were
  the two intermediate fixes the same hour), health stamp = HEAD, no
  migration.** Row 240 re-checked ✅ on rev 46. The all view is the 6xl
  container; the normal list stays 4xl.

- **2026-09-21 — A5-4: results scoped to the caller, not the owner (BUILT).**
  James's field report from the all view: every student read "(unknown)"
  and the section filter offered nothing. Cause: `buildResults` (the
  matrix, per-student page, print report, work packet, CSV) and the
  review-queue GET looked the student overlay up with
  `students.owner_sub = session.sub` and resolved sections through
  `session.email` — the CALLER, who in the all view is not the owner and
  has no overlay rows for those students. **Co-teachers (slice 3) hit the
  same defect** on every one of those surfaces; only the Monitor was right
  (`sittingAttendance` scopes by the sitting's owner). Fix: `buildResults`
  now takes `(assessmentId, options)` and reads the owner off the
  assessment row via a new exported `assessmentOwner(db, id)` —
  `owner_sub` always, `owner_email` from the row or, when that is null (a
  pre-0038 row that never had a sitting), the newest sitting's
  `owner_email`, the 0038 backfill rule; the tenant argument in the query
  comment still holds because the owner's overlay is the one the ingest
  wrote the attempts against, and access to the assessment is checked
  upstream by every caller. The review queue scopes by
  `access.assessment.owner_sub`; the work packet's "N of M enrolled"
  denominator uses the owner's sections. Impersonation (slice 5) would
  have masked this for admins only. Tests: `assessmentOwner` (row column
  wins, sitting fallback) and an `ADMIN_EMAILS` caller on the results
  route seeing names + sections; 27 `buildResults` call sites in tests
  dropped their owner args. Design-tool **2108** tests, typecheck clean,
  no migration. Row 245 unrun. Slice 5 (impersonation, D-8) is next,
  James 2026-09-21 ("both").

- **2026-09-21 — slice 5 BUILT: impersonation (D-8).** Migration **0040**
  (`0040_impersonation_sessions.sql`, applied to dev + test) and no other
  schema change. What landed, file by file:
  - **`db/schema.ts`** — `impersonation_sessions` (actor sub + email, target
    sub + email, `started_at`, `stopped_at`, `request_id`). It is the ONLY
    place an act-as is distinguishable from the teacher themselves, because
    D-8 deliberately leaves every feature table recording the TARGET's sub;
    `request_id` is the START's, not the stop's, so the row lines up with the
    log line that opened it. Best-effort by construction: an 8 h cookie can
    outlive a browser, so an open row is an audit record, not a session store.
  - **`lib/auth/session.ts`** — `actor_sub` / `actor_email` on
    `SessionPayload`, documented as present together or not at all.
  - **`lib/auth/admin.ts`** — new `isImpersonating(session)`, and **`isAdmin`
    now returns false whenever `actor_sub` is set**. This is the load-bearing
    line of the slice: it makes act-as a strict NARROWING, so one predicate
    already owned by twenty call sites closes the admin surface, the
    all-teachers toggle, `own`-on-every-row resolution and chained
    impersonation at once, with no second gate to forget. The impersonate
    route's own refusal of an already-impersonated session is this predicate
    and nothing else.
  - **`lib/api/impersonation.ts`** — the decisions. `checkImpersonationTarget`
    (staff by `roleForEmail`, never yourself), `resolveTargetSub`, and the two
    audit writes. **Target resolution is the slice's one real design problem**
    (decision 2.1): a session JWT needs a Google `sub` and the app stores no
    staff directory — D-1 made admin a config list precisely to avoid a staff
    table — so the only places an address and a sub appear together are the
    rows a teacher owns. The target's sub is therefore `assessments.owner_sub`
    of their newest `owner_email` match, falling back to their newest sitting
    (the migration-0038 backfill gap). A teacher with neither cannot be acted
    as, and the refusal says so out loud — `404 no_account_rows`, which the
    button turns into "This teacher has no assessments or sittings yet, so
    there is nothing to act on" rather than a blank dashboard.
  - **`POST /api/admin/impersonate`** — admin-only with the grants route's
    **404, not 403** (D-3). Mints a session whose `sub` / `email` / `role` are
    the target's and whose `actor_*` are the admin's, same 8 h TTL (a shorter
    one would expire mid-task into a login screen rather than back into the
    admin's own account), writes the audit row, logs `impersonation_start`.
    Every refusal but a malformed body is a 404: `not_staff`, `self`,
    `no_account_rows` are all statements about a principal the caller named.
  - **`POST /api/admin/impersonate/stop`** — gated on the session's own
    `actor_*`, NOT on `isAdmin` (by then the principal is the teacher and
    `isAdmin` is false for them by design); 404 with no actor. Closes the
    newest open row for the pair, mints the admin's own session back from the
    actor claims — the signed cookie is the only record of who the admin is,
    and re-issuing from it is exactly as trustworthy as the cookie — and
    **303-redirects** to `/dashboard`. It answers a plain form POST rather
    than JSON because Stop is the way out of a session that is not yours and
    must work on a page whose JavaScript has failed.
  - **`components/app/AppHeader.tsx`** — the persistent "Acting as \<target\> ·
    signed in as \<admin\>" strip above the band with a Stop form, and an
    admin-only **Admin** nav noun. `NAV[0].isActive` had to stop meaning
    "anything that is not Students" now that a second top-level route exists.
  - **`components/app/AppChrome.tsx`** (new) — the header resolved from the
    session, shared by `app/dashboard/layout.tsx` and the new
    `app/admin/layout.tsx`. A second copy in the admin layout is exactly where
    the banner would go missing.
  - **`app/dashboard/ActAsButton.tsx`** + `app/dashboard/page.tsx` — Act as
    beside Results on all-view rows the admin does NOT own (`via === "admin"`
    and an `owner_email`), reload-the-page posture like
    `DuplicateAssessmentButton` (and honest: the response changes who every
    later request is). `showAllTeachersToggle`'s parameter widened to carry
    `actor_sub` so the type says what `isAdmin` now reads.
  - **`app/admin/page.tsx`** (new) — admin-only else `notFound()`; open
    sittings district-wide (code, assessment, teacher, section, started) with
    Monitor and Act as per row, and no Act as on the admin's own sitting since
    the route refuses `self`. Deliberately NOT the grants console (5b).
  - **`proxy.ts`** — `/admin` joins `/dashboard` in `PROTECTED_PREFIXES`, so a
    signed-out visitor gets the login redirect instead of the page's 404.
  - **`lib/observability/serverError.ts`** — the one request-scoped place the
    server logs a `sub` now also logs `actor_sub` when the session carries
    one. The `resolveSub` test seam is kept (it returns no actor); the default
    resolver reads both from the verified JWT. The `server_error_events` ROW
    is unchanged — the table has no actor column, and D-8's rule is that the
    feature tables record the target.
  Tests: `test/impersonation-api.test.ts` (both routes end to end against the
  test DB — the cookie payload, the audit row, the sitting fallback, every
  404, the newest-open-row rule, and an act-as session resolving `owner` on
  the target's assessment but 404 on a third teacher's), `test/admin.test.ts`
  (the two predicates, including the pathological "admin's own address with an
  actor_sub"), two new cases in `test/server-error-record.test.ts`, and the
  two routes classified in `test/access-enforcement.test.ts`. Design-tool
  **2131** tests (2108 before), typecheck clean. Rows 246–252 in
  `docs/design-tool-manual-checks.md` ("System admin — impersonation") are
  NOT RUN — they need an `ADMIN_EMAILS` address and, for row 252, a second
  staff account. **Deferred, unchanged: the grants console (now slice 5b),
  substitutes (4) and principals (6).**
