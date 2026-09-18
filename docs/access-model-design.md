# Access model — co-teachers, substitutes, principals, system admins

Design note, 2026-09-17. Roadmap `docs/roadmap-2026-09.md` §"Unscoped —
needs decisions" rows **U-1** (co-teachers), **U-2** (substitutes), **U-3**
(principals) and **U-6** (system admin: see in-progress work, impersonate
staff). The four share one missing thing, so this note designs that thing
once and treats the four as its cases. Design tool only; nothing in the
client or the shared schema moves (a student's plane is untouched: the
client authorizes by sitting + roster membership, not by who owns the
assessment). Decisions marked **D-n** are James's and are listed at the
end; **§Progress says what is built** (nothing yet).

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
| 2 | Migration: `access_grants`, `test_sessions.created_by_sub`, `impersonation_sessions`; `ADMIN_EMAILS` + `isAdmin`; grant resolution inside the helper; list-query widening; `GET/POST/DELETE /api/grants` (owner or admin) | M — Opus 5 / medium |
| 3 | Co-teach: the Share dialog's second mode, the "Shared with you as co-teacher" row label, sittings visible to both; rows | S — Sonnet 5 / medium |
| 4 | Substitute: Coverage card (teacher) + admin grant, the sub's home, read-only editor / results refusal, `created_by_sub` on sittings; rows | M — Opus 5 / medium |
| 5 | Admin: `/admin` page (open sittings, grants, impersonate / stop, banner), `impersonation_sessions`; rows | M — Opus 5 / medium |
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
  `created_by_sub` = the sub. — **DECIDED as recommended (James, 2026-09-17)**
- **D-6** Admin reads everything; admin writes outside the admin surface
  go through impersonation. — **DECIDED as recommended (James, 2026-09-17)**
- **D-7** Principal = a `view` grant on a `school_id`; read-only
  surfaces only in v1. — **DEFERRED (James, 2026-09-17): principals are
  not a user in this release; the `school` scope stays in the table's
  design so slice 6 can land later without a migration.**
- **D-8** Impersonation = a second session JWT carrying `actor_*`, a
  persistent banner, `impersonation_sessions` audit; the target's sub is
  what the feature tables record. — **DECIDED as recommended (James, 2026-09-17)**

## Progress

- 2026-09-17 — note written; D-1…D-8 decided the same day (D-4 = (b),
  D-7 deferred); nothing built.
