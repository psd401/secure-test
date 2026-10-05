# Co-teacher accommodation records (U-17) + accommodations by class period (U-18)

Roadmap rows U-17 and U-18 (`docs/roadmap-2026-09.md`), both from the
open-beta teacher report of 2026-10-05. Design tool only: the delivery
bundle already carries the resolved `accommodations` map, so **no client
release** is needed for either row. Builds on U-16 (`explainAccommodations`
is the one rule; the "Who gets what" preview shows its result).

Status: **note written 2026-10-05; 13.1–13.11 DECIDED the same day (James:
all recommendations).** Slice 1 next.

## The problem, in the teacher's words

- **U-17.** "I put the accommodations on my Students page and they didn't
  carry over." The teacher co-teaches; the assessment is the lead's. Each
  teacher's Students page is their OWN overlay (`students.owner_sub`), and
  delivery reads the ASSESSMENT OWNER's overlay row for the child.
- **U-18.** One common assessment is given to on-level, honors and
  co-taught periods. The teacher wants (a) a narrower allowed list for some
  periods and (b) to give a whole period a tool without assigning it
  student by student.

## What exists (read 2026-10-05)

- **The rule** — `explainAccommodations(rule, recordRows, overrides)` in
  `design-tool/lib/accommodations/effective.ts`: record rows (enabled
  values) ∩ `allowed_accommodations`, then per-student exceptions (On adds,
  Off removes; on a teacher-assigned test an On may exceed the list). An
  empty allowed list gives nothing.
- **Delivery** — `app/api/assessments/[id]/delivery/route.ts`:
  `resolveEffectiveAccommodations(db, assessment, ownerRowId,
  coTeacherEntitlementStudentId(...))`. The fallback reads the SITTING
  owner's row for the same roster student, and only when the owner's row has
  **no live rows at all** (2026-09-22). So once the owner has any record for
  a child, a co-teacher's record for that child is ignored.
- **Overlay rows** — `students` (owner_sub, ssid, roster_ps_id, name). The
  Students page, the TIDE import and `student_accommodations` all work on
  the CALLER's rows (`app/api/students/route.ts` filters
  `owner_sub = session.sub`). There is **no table mapping a teacher's email
  to their sub**, and `students` carries no owner email; `access_grants` is
  keyed on grantee EMAIL.
- **Co-teachers** — two sources: an `access_grants` row (`scope_kind =
  'assessment'`, level `edit`, D-4 (b) of `docs/access-model-design.md`),
  offered one-click from the roster's `Co-teacher` role
  (`lib/roster/coTeachers.ts`, `coTeachersOf`).
- **Sections** — `roster_section_teachers` (teacher_email, role, dates) and
  `roster_enrollments`; a sitting names at most one `section_ps_id` (null =
  all the owner's sections, or a student list).
- **The preview** — `lib/accommodations/preview.ts` lists the owner's
  overlay rows; it deliberately skips the sitting-based fallback.

### Finding F-1 (defect, found while reading): a co-teacher's exceptions do nothing

`POST /api/assessments/[id]/overrides` authorizes the assessment at `edit`
(a co-teacher passes) but the STUDENT at `own` (`authorizeStudent`), and the
Exceptions tab lists `GET /api/students` — the caller's own rows. So a
co-teacher can only attach an exception to THEIR overlay row, while delivery
and the preview read exceptions for the OWNER's row. The co-teacher sees
the exception saved; the student never gets it. Fixed by U-17 slice 1
(exceptions always attach to the owner's row — see D-10 proposal).

## Decisions already made (James, 2026-10-05, with the rows)

- **D-1 (U-17)** Union the owner's and co-teachers' live records for the
  child; **On wins** — an Off on one teacher's record does not cancel
  another's On. Withdrawing a support on one test stays the job of an
  exception (Off).
- **D-2 (U-17)** "Co-teachers" = holders of a live grant on this assessment
  **and** the owner's roster co-teachers (`coTeachersOf`).
- **D-3 (U-17)** The owner's Students page shows co-teachers' records for
  the same child, read-only.
- **D-4 (U-18)** Both a per-section **allowed list** and a per-section
  **grant**.
- **D-5 (U-18)** A section's allowed list **replaces** the assessment-wide
  list for that section.
- **D-6 (U-18)** A section grant sits **below** per-student exceptions: an
  Off exception removes it.
- **D-7 (U-18)** Configured on the Allowed tab with a section picker, not on
  the sitting.
- **D-8 (U-18)** A student in two configured sections: the attempt's
  sitting's section when it names one, else the union of their sections.
- **D-9** U-16 first (done), one note for both rows (this one).

## Design

### U-17 — whose records count

For an attempt by roster student S on assessment A (owner O):

1. **Teachers whose records count** = O, plus every teacher T that is a
   co-teacher by D-2 **and currently teaches S** (an active
   `roster_section_teachers` row on a section S is enrolled in today). The
   "teaches S" filter keeps a co-teacher of O's 3rd period from leaking a
   record into O's 5th period. (Question 13.1.)
2. **Record rows** = the live `student_accommodations` rows of each such
   teacher's overlay row for S (`students.roster_ps_id = S`, practice rows
   excluded), concatenated **owner first**, then co-teachers by email.
3. **Same tool, two values** (owner Black on Rose, co-teacher Yellow on
   Black): the existing "first wins" in `explainAccommodations` makes the
   OWNER's value win, then the first co-teacher's. (Question 13.2.)
4. **Exceptions** stay on the owner's row only (one place per test).
5. This **replaces** `coTeacherEntitlementStudentId` (the sitting-based,
   only-when-empty fallback).

**Finding teachers' overlay rows needs their sub.** Grants and the roster
know a co-teacher by EMAIL; overlay rows by SUB. Proposal: add
`students.owner_email` (nullable, lowercased), written on every insert from
the session, backfilled once from `assessments` / `test_sessions` pairs of
(owner_sub, owner_email). Rows that stay null (a teacher who has never made
a test or a sitting) are matched as soon as that teacher's next write fills
it — a write-time backfill on `GET /api/students` too. (Question 13.3.)

**The Students page (D-3).** On the owner's student row: an "Also on
<co-teacher>'s record: Text-to-Speech (Test Content)" line, read-only.
Symmetric on the co-teacher's page ("Also on <lead>'s record: …"), since
both records now count on the lead's tests. (Question 13.4.)

**F-1 fix (proposed D-10).** The Exceptions tab lists the OWNER's students
for this assessment (owner's overlay rows + the co-teacher's students
resolved to the owner's row, creating the owner's overlay row on first
exception when it does not exist yet — the join path already creates
overlay rows under the owner), and the overrides routes authorize the
student through the assessment (`edit`) instead of `own`. (Question 13.5.)

**The preview** keys students by roster id and unions the same teachers'
records, so "Who gets what" shows the co-teacher's records too, marked
"(from <co-teacher>'s record)". (Question 13.6.)

### U-18 — accommodations by class period

**Storage (proposal).** One jsonb column on `assessments`:

```
section_accommodations: {
  "<section_ps_id>": {
    "allowed": ["zoom", "spell_check"] | null,   // null = use the assessment's list
    "grants":  [{ "tool_id": "tts_test_content", "value": "On" }]
  }
}
```

Autosaves with the Allowed tab like the existing two lists (one PATCH).
A table is the alternative; jsonb keeps the autosave a single write and the
whole configuration readable with the assessment row. (Question 13.7.)

**The rule, per student, extended:**

1. Effective allowed list = the section's `allowed` when set, else the
   assessment's (D-5).
2. Record rows (U-17's union) ∩ effective allowed.
3. **+ section grants** (only tools in the effective allowed list — the UI
   only offers those, and the PATCH refuses others; Question 13.8).
4. Per-student exceptions: On adds (teacher-assigned may exceed the list, as
   today), Off removes — including a section grant (D-6).
5. `construct_altering` stays assessment-wide: a tool alters the construct
   or not regardless of period.

**Which section (D-8).** At delivery, the attempt's sitting `section_ps_id`
when it names one; otherwise every section S is currently enrolled in that
has a configuration on this assessment — allowed lists unioned, grants
unioned. A student in no configured section gets the assessment-wide rule.

**Assigned from above.** On a school / district-assigned assessment
(`assigned_scope` ≠ `teacher`) a section's allowed list may only NARROW the
assessment's (subset enforced on PATCH): the construct decision was made
above the teacher, exactly as exceptions are gated today.

**Which sections the picker offers.** The owner's current sections plus the
current sections of every co-teacher with a grant (they give the test to
their own periods). Labels via `sectionLabel`. A configured section that
leaves the roster keeps its configuration (shown as "no longer on your
class list", removable). (Question 13.9.)

**Copies, shares, exports.** Section ids are one teacher's classes.
`section_accommodations` is NOT carried by the teacher bundle (export /
import), Duplicate, or Share-copy — a copy starts with the assessment-wide
rule only. (Question 13.10.)

**UI (D-7).** On the Allowed tab, above the checklist: "Settings for:
All periods ▾ | <section> …". "All periods" is today's checklist. Picking a
section shows:

- "Use the test's list" (default) / "Use a different list for this period"
  — the second reveals the checklist for that period;
- "Give everyone in this period:" — the period's allowed tools as
  checkboxes with the value picker the Exceptions tab already uses;
- the **Who gets what** preview filtered to that section (the section
  filter deferred from U-16, decision 9.5).

**Reporting.** No change: the bundle's `accommodations` map and the
construct-altering flags are per attempt already.

## Slices (proposal)

| # | Slice | Side | Model |
|---|---|---|---|
| 0 | This note; 13.x answered | — | — |
| 1 | **U-17 server + F-1**: migration `students.owner_email` + backfill; `teachersWhoseRecordsCount(db, assessment, rosterPsId)`; resolver takes record rows from several overlay rows (owner first); delivery + preview switch over and `coTeacherEntitlementStudentId` is deleted; overrides routes authorize via the assessment and attach to the owner's row; tests | design tool | Opus 5 / medium |
| 2 | **U-17 UI**: Exceptions tab lists the owner's students; "Also on X's record" on both Students pages; preview marks co-teacher-sourced tools; rows | design tool | Sonnet 5 / medium |
| 3 | **U-18 server**: migration `assessments.section_accommodations`; PATCH validation (ids, subset rule, grants within allowed); rule steps 1/3; section choice at delivery (D-8); preview gains `?section=`; bundle/duplicate/share leave it out; tests | design tool | Opus 5 / medium |
| 4 | **U-18 UI**: section picker on the Allowed tab, per-period list + grants, preview section filter; rows | design tool | Sonnet 5 / medium |
| 5 | **Docs**: help topic 5 ("co-teachers' records count", "by class period"), quick start, FAQ, a picture from `_demo` | design tool | Sonnet 5 / low |

Two migrations (slices 1 and 3). Deploy after slice 2 and after slice 4, or
once after 4.

## Open questions (for James)

- 13.1 A co-teacher's record counts only when that co-teacher currently
  teaches the child (roster)? (rec: yes)
- 13.2 Same tool, different values on two records: the owner's value wins?
  (rec: yes)
- 13.3 Add `students.owner_email` (migration + backfill) to find a
  co-teacher's records by email? (rec: yes; no other sub↔email source)
- 13.4 "Also on X's record" shown on BOTH teachers' Students pages? (rec: yes)
- 13.5 F-1: exceptions always attach to the owner's row, and a co-teacher at
  edit can add them for any student on the test? (rec: yes; fix in slice 1,
  before anything else in U-18)
- 13.6 Preview marks tools that came from a co-teacher's record? (rec: yes)
- 13.7 `section_accommodations` as one jsonb column on `assessments` (vs a
  table)? (rec: jsonb)
- 13.8 A section grant must be a tool that period allows? (rec: yes)
- 13.9 Picker offers the owner's sections + co-teachers' sections?
  (rec: yes)
- 13.10 Section settings are dropped from exports, Duplicate and Share
  copies? (rec: yes)
- 13.11 Deploy once after slice 4, or after slice 2 as well? (rec: after
  slice 2 too — F-1 is a live defect)

## Progress

- 2026-10-05 — note written; D-1…D-9 carried from the roadmap rows; F-1
  found reading the overrides route. 13.1–13.11 DECIDED as recommended
  (James): co-teacher records count only when that co-teacher currently
  teaches the child; owner's value wins; `students.owner_email`; "Also on
  X's record" on both pages; exceptions on the owner's row (F-1 first);
  preview marks co-teacher-sourced tools; jsonb column; grants within the
  period's list; picker = owner's + co-teachers' sections; dropped from
  copies; deploy after slice 2 and after slice 4.
- 2026-10-05 — **slice 1 BUILT** (server, not deployed): **migration 0056**
  `students.owner_email` + index, backfilled from the newest (sub, email)
  pair on `assessments` / `test_sessions`; stamped at staff sign-in
  (`/api/auth/callback`, best-effort), on `POST /api/students` and after a
  TIDE import (`stampOverlayOwnerEmail`). `lib/accommodations/coTeacherRecords.ts`:
  `coTeacherEmailsFor` (live assessment grants + `coTeachersOf(owner)`),
  `teachersCurrentlyTeaching`, `coTeacherRecordStudentIds` (rows by roster id,
  or by the roster SSID on an unbound TIDE row; ordered by email),
  `exceptionTargetFor` (F-1). `resolveEffectiveAccommodations` takes the
  co-teachers' row ids and UNIONS their live records after the owner's;
  `coTeacherEntitlementStudentId` is deleted. Delivery switched over. The
  preview keys children by roster id, lists a co-teacher-only child, and
  marks `from_record_of` per tool. `POST /api/assessments/[id]/overrides`
  attaches to the owner's row (owner's row named directly, or the caller's
  own row mapped / created; `student_not_linked` 400 for an unmappable row).
  Tests: `test/coteach-accommodations.test.ts` (10), the 2026-09-22 fallback
  test rewritten for D-1 (owner's Off no longer cancels; an Off exception
  does). Design-tool 2882 pass, typecheck clean. Migration applied to dev,
  test and `_demo`.
- 2026-10-05 — **slice 2 BUILT** (UI, not deployed): `GET
  /api/assessments/[id]/exception-students` (edit; the owner's records, plus
  for a co-teacher their own records for children the owner lacks) feeds the
  Exceptions tab; `lib/accommodations/sharedRecords.ts`
  (`relatedTeacherEmails` = roster co-teachers + grantees on my tests +
  owners of tests granted to me; `otherTeachersRecords`, enabled visible tools
  of those teachers' records for children they currently teach) feeds "Also
  on <name>'s record: …" on the Students page rows and a box on the student
  page; Who gets what tags "From <name>'s record" (names = the address's
  local part — the app has no staff names). Rows 459–461 ✅ on local
  `_demo`, 462–465 open. Design-tool 2886 pass.
- 2026-10-05 — **slice 3 BUILT** (U-18 server, not deployed): **migration
  0057** `assessments.section_accommodations jsonb not null default '{}'`.
  `lib/accommodations/sections.ts`: `SectionAccommodationsSchema`,
  `validateSectionAccommodations` (district / school period lists only
  narrow; grants within the period's list, On values, no repeats),
  `ruleForSections` (period list replaces the test's; several configured
  periods union; narrow-only re-applied at resolve time), `configuredSectionsOf`,
  `sectionsForAttempt` (the sitting's section when named, else the student's
  current configured periods). `explainAccommodations` applies `rule.grants`
  after the record (the record's own value kept) and before exceptions;
  reports `grantedBySection`; an Off exception's removal of a grant counts in
  `removedByException`. Delivery passes the periods; `PATCH
  /api/assessments/[id]` takes `section_accommodations` (whole value, locked
  while Published like the allowed list) and answers 400 with the error, the
  period and the tool; the preview takes `?section=` (that period's current
  students only, `others_count` from its enrolment) and flags `from_section`.
  Exports / Duplicate / Share copies carry nothing (explicit field lists —
  tested). **Reading:** an exception still has to be a tool on the TEST's
  allowed list (`POST …/overrides` unchanged), so a tool only a period allows
  cannot get a per-student exception; widen the test's list or grant the
  period. Tests: `test/section-accommodations.test.ts` (13). Design-tool
  2899 pass. Migration applied to dev, test and `_demo`.
- 2026-10-05 — **slice 4 BUILT** (U-18 UI + 17.2, not deployed): `GET
  /api/assessments/[id]/section-options` (edit; owner's + co-teachers'
  current sections, plus configured ones off the roster); `PeriodSettings`
  on the Allowed tab under the test's checklist (deviation from the note:
  "All periods" is a picker entry meaning the list above, rather than the
  checklist moving inside the picker) — own list or the test's, "Give
  everyone in this period" with the TIDE value picker, remove, autosave of
  the whole value; Who gets what follows the picked period and tags "Whole
  period". **17.2:** `POST …/overrides` accepts a tool a period the student
  is currently in allows (refused before the student is resolved when no
  period allows it, so a refusal creates nothing); the PATCH orphan sweep
  keeps exceptions any period still allows; the Exceptions tab's tool picker
  offers the union. **Found in the hand-run and fixed:** a period grant
  reaches students with no record at all, so the preview now lists a granted
  period's current roster students (named from the roster, `student_id =
  roster:<ps_id>`). Rows 466–468 ✅ local `_demo`, 469–474 open. Design-tool
  2903 pass.
