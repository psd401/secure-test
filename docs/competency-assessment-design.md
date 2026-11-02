# Competency assessments in SecureTest (roadmap row CB)

Design note, 2026-11-02. DRAFT — nothing is built. The district's
competency-based assessments (CBAs) let a student earn course credit, or
meet a graduation requirement, by passing a district performance task. This
note moves the Social Studies CBAs from paper into SecureTest. Decisions
marked **D-n** are James's and are listed at the end; **§Progress says what
is built** (nothing yet).

The task content (student and proctor packets, the curated options and their
source sets) is district material and **never goes in this repo** — it is
authored in the app by Assessment staff, and the working packets live in the
ops repository (internal — see the ops repository). This note describes the
shape of the tasks only.

## The process today (paper)

1. A high school counselor asks the Assessment office for a CBA for a student.
2. Assessment records the student on a results spreadsheet and issues an
   assessment number.
3. The counselor (or another trained staff member) proctors. The default is
   three sittings — plan, draft, revise — untimed; materials are locked away
   between sittings and never go home. The final response is handwritten.
   Students read a curated set of outside sources online and may not use AI.
4. The proctor returns the work to Assessment, which sends it — number only,
   no name — to a content-area teacher, possibly at another school.
5. The teacher scores it on the state (OSPI) rubric: **Pass** needs a 3 or
   higher in every row; otherwise **Needs Revision**, with written feedback.
   No Score is given for unintelligible, off-topic or copied work.
6. Assessment records the result and tells the student and counselor; on a
   Pass, the counselor's registrar enters a P for the term. A student may
   revise and resubmit.

Starting scope (D-9): the six Social Studies tasks — Cultural Interactions,
Causes of Conflict, Dig Deep, Technology Through the Ages (each in a World
History and a U.S. History version), Constitutional Issues and Checks and
Balances (Civics). Each has a menu of about four curated options per course.

## What exists that this stands on

- **Several sittings, one attempt.** Attempts are unique per
  `(assessment_id, student_id)`; joining a later sitting rebinds the same
  attempt and prefills every saved answer (resume prefill). Closing a sitting
  leaves the attempt `in_progress`; "Continue in a new session" re-issues a
  code with the same scope (`docs/ended-session-rejoin-design.md`). This is
  the three-sitting structure, already.
- **Untimed.** A null `time_limit_seconds`, or the sitting-wide "No time
  limit".
- **No AI, enforced.** The lockdown client is a sealed page with no network
  (`openwiki/client/lockdown-and-security.md`); spellcheck is off unless the
  `spell_check` accommodation is on; autocorrect and Text Replacement are
  always off. The paper process enforces "no AI" by watching; this enforces
  it by construction.
- **Built-in sources.** An item set can carry several labelled text sources,
  laid out inline, on their own page or side by side
  (`docs/multi-source-stimulus-design.md`). Images are inlined assets.
- **Essay items** with rich text, word count and autosave; every edit kept in
  `response_revisions` (answer history). Planning and source-notes items can
  be ungraded essay items in the same assessment.
- **Analytic rubrics.** `RubricSchema` (`packages/schema/src/items.ts`):
  criteria × levels with points. Manual scoring records per-criterion level,
  points and rationale (`lib/api/reviewActions.ts`). `scoring_method: human`
  keeps AI out of scoring entirely.
- **Feedback to students**: per-row rationales on the print page and in the
  Google Docs release when `student_visibility.with_feedback` is on.
- **Pass back** reopens a handed-in attempt and keeps its earlier scores as
  `superseded` (`docs/pass-back-design.md`) — the Needs Revision loop.
- **Grants** (`access_grants`, `docs/access-model-design.md`): email-keyed,
  `view < run < edit < own`, with `starts_at`/`ends_at`. Scope kinds
  `assessment`, `teacher` and `school` — `school` is stored but never
  resolved (D-7 there, deferred).
- **Roster**: `roster_students.school_id` exists, so "students at my school"
  is answerable.
- **`assessments.assigned_scope`** (`teacher | school | district`) exists and
  nothing sets or reads it "until a district-authored assessment exists".
- **Accommodations**: text-to-speech for sources and responses, speech to
  text (in place of a scribe), zoom, contrast, font.
- **AI agreement tooling**: the scoring corpus and model eval
  (`docs/scoring-corpus-design.md`, `docs/scoring-model-eval-design.md`)
  measure per-criterion agreement and weighted kappa against teacher finals.

### What does not exist

- A sitting admits only students in the caller's own roster sections
  (`app/api/test-sessions/route.ts`, "Widening (coaches, admins) is open
  question 3.6"). A counselor has no sections, so cannot admit anyone; a
  `run` grant does not help, because the check uses the caller's sections.
- No pass rule, no Pass / Needs Revision result, no No Score.
- No scoring-only access: scoring needs `edit`, which can also change items.
- No outside web access during a test, by design (D-2).

## Design

### Typed, sealed, with built-in sources (D-1, D-2, D-3)

The response is typed and scored in SecureTest (D-1). Each curated option's
source set is built into the test as item-set sources (D-2); the student
reads nothing outside the bundle. Topic choice narrows to the curated options
— the open-choice option does not carry over, because it depends on the
student finding their own sources (D-3).

### One assessment per task per course, options inside it (D-4)

Each task-and-course pair is ONE assessment — four history tasks × World and
U.S. History plus two Civics tasks, ten in all — owned by Assessment staff,
`assigned_scope = 'district'`. One per course keeps the student's test list
unambiguous. Each curated option is an **item set** inside it:

- the set's stimulus is the option's prompt and its built-in sources;
- the set holds that option's three items: planning and source notes
  (essay, ungraded), and the final response (essay, rich text,
  `scoring_method: human` — D-6) with the task's OSPI rubric as an analytic
  rubric, levels 4/3/2/1 as points 4/3/2/1, language reproduced exactly.

**The student sees only their option.** Delivery is already built per
student at join time (`GET /api/assessments/:id/delivery`, see
`docs/e12-per-student-stimulus-design.md`), so this is a filter in that
route: for a district assessment, the bundle carries only the item set named
on the student's assignment. Every other option stays out of the bundle —
the student cannot page to it, and a bundle with every option's sources
(about four) is never sent. The
authoring preview shows all options.

**Choosing and switching (D-18).** The student picks an option with the
counselor before the first sitting; whoever makes the assignment records it.
A switch is treated as a new assessment: Assessment withdraws the assignment
and makes a new one for the other option. Nothing carries over — the new
option's items start empty and no feedback follows. Underneath it is still
the student's one attempt on this assessment (reopened through pass back if
it was handed in), but because each option has its own items nothing is
overwritten: the old option's responses and scores stay as the record of
the withdrawn assignment.

**Scoring reads the current option.** The pass rule and the release apply to
the final-response item of the option on the assignment.

### The assignment (D-5, D-8)

New table `competency_assignments` — the case record that replaces the
spreadsheet row:

| column | |
| --- | --- |
| `assessment_id` | the task assessment |
| `student_ps_id` | roster student |
| `item_set_id` | the option the student is taking |
| `proctor_email` | the one staff member who runs this student's sittings |
| `assigned_by_email` / `_sub` | who made it |
| `status` | `assigned → in_progress → handed_in → scored → released` (+ `withdrawn`) |
| `result` | `pass | needs_revision | no_score`, null until scored |
| `released_at` / `released_by_email` | Assessment's review step (D-10) |
| timestamps | |

One live (not withdrawn) assignment per `(assessment_id, student_ps_id)`.

**Assessment staff (D-14).** A fixed list in config,
`COMPETENCY_ADMIN_EMAILS` — same pattern as `ADMIN_EMAILS` (`lib/auth/admin.ts`):
read from the environment, which comes from Secrets Manager, never from a
tracked file. It starts with one person, the Director of Assessment. On any
`district` assessment, a listed person can create and change assignments,
delegate scorers, release results and pass back, as well as author.

**Who assigns.** v1: Assessment staff create assignments, pick the option
and name the proctor (D-5). Next: counselors, through a
`school`-scoped `run` grant — finally resolving that stored scope — which
lets a counselor create assignments for students whose
`roster_students.school_id` matches (D-8). Proctor training is checked by
Assessment outside the app (D-7).

**What a proctor can do.** An assignment acts as a `run` grant on that one
assessment for that one student. In `POST /api/test-sessions`, for a
`district` assessment only, the student-list scope check accepts "every
listed student has a live assignment naming me as proctor" in place of
"every listed student is in my sections". A proctor's sitting is always a
student list of their assigned students; the proctor opens and closes each
sitting, so the proctor controls the session flow. The sitting is owned by
the proctor (like any sitting); the assessment stays Assessment's.

Proctor home: a "Competency assessments" list — my assigned students, the
option, status, and Start / Continue session.

### Scoring (D-6, D-11, D-12)

- **Score-only access (D-11, v1).** A new level `score` between `run` and
  `edit`: `view < run < score < edit < own`. It reaches the review queue and
  the scoring actions, not items or settings. Assessment delegates it to
  scorers as a time-boxed `assessment` grant (`ends_at` = end of the scoring
  window) (D-12). Pass back stays with Assessment staff in v1 (D-15); letting
  a scorer pass back from the `score` level is a later slice.
- **Not blind in v1 (D-6).** Scorers see the student's name as any scorer
  does today. The anonymous work-packet mode remains available for printing.
- **The pass rule.** An assessment-level setting
  `competency.pass_min_points_per_criterion` (3 for every OSPI task). When
  the final response has a `final` score, the result is derived:
  `pass` if every criterion's level points ≥ the minimum, else
  `needs_revision`. A scorer can mark **No Score** (new flag on the score,
  with a reason from the OSPI list), which yields `no_score`. The rationale
  per row is the feedback.
- **AI later.** Human only (D-6). The corpus captures every CBA final, so
  the existing eval can measure AI agreement offline; switching to `hybrid`
  or `ai` is a later decision against the eval's pass bar. With a few CBAs
  per term, pool across options of one task (shared rubric) to get a usable n.

### Release and results (D-10, D-13)

Assessment reviews each scored assignment and releases it (D-10; James
expects to remove this step once the process is familiar — keep it a
setting, not a code path). On release:

- the counselor(s) for the student's school see the result on their
  Competency list (via the `school` grant at `view`);
- **no PowerSchool push** (D-13). The counselor tells the registrar; the
  response stays in SecureTest as the record.

**Needs Revision → feedback in the app (D-16).** Assessment passes back the
same attempt (earlier scores kept as `superseded`, `docs/pass-back-design.md`),
the assignment returns to `in_progress`, and the proctor runs further
sittings. On the student's next join, the delivery bundle carries the
scorer's per-row feedback for the final response — criterion name, level
label and rationale from the superseded score — and the client shows it as a
read-only "Scorer feedback" panel beside that item while the student revises.

- Today nothing like this reaches the client: rubric feedback goes out only
  on the print page and the Google Docs release (`lib/reporting/printFeedback.ts`),
  and pass back shows the student nothing (pass-back design, "What the
  student sees"). So this is a **client change and a client release**
  (next-day fleet delivery through IT's AutoPkg recipe), plus
  `client/MANUAL-CHECKS.md` rows.
- It is not an answer key, so it does not cross ADR 0016's line; it is a new
  optional field on the delivery bundle, sent only for a passed-back
  attempt on a district assessment.
- A Pass sends no feedback to the client.

Switching option after a Needs Revision is a new assignment (D-18): no
feedback panel, a fresh start on the new option.

### Not in this note

- Blind / anonymous online scoring (D-6 — a later slice if wanted).
- AI scoring of CBAs (D-6).
- Non-Social-Studies CBAs and semester finals (D-9).
- Gradebook or transcript integration (D-13).
- Counselor data from the warehouse: the school-scoped grant is given by
  Assessment, not derived from a roster counselor field (none exists).
- Records retention: confirm the archive/delete rules
  (`docs/archive-and-delete-design.md`) keep CBA work as long as the
  district needs it.

## Slices

1. **District assessment + Assessment staff + pass rule.**
   `COMPETENCY_ADMIN_EMAILS`; `assigned_scope = 'district'`;
   `competency` settings; result derivation; No Score flag. Tests
   on the derivation first.
2. **Assignments.** Table, migration, Assessment UI to assign student +
   option + proctor; status transitions.
3. **Option filter in delivery.** The bundle carries only the assigned
   option's item set. Tests that no other option's text reaches the bundle.
4. **Proctor path.** Sitting scope accepts assignments for district
   assessments; proctor home list. Tests on the scope check (the security
   surface).
5. **`score` level.** Ladder change, review-queue and scoring routes accept
   it, grant UI for scorers.
6. **Release + counselor view.** Release action; `school` grant resolution
   at `view`; counselor list.
7. **Feedback on pass back (client release).** Bundle field + client panel +
   manual-check rows.
8. **Counselors assign.** `school` grant at `run` reaches assignment
   creation for that school's students.
9. **Content (Assessment, in the app).** Build the ten task-and-course assessments and
   their options; hand-run one CBA end to end before opening it up.

Later: scorer pass back (D-15); blind online scoring; AI scoring.

## Decisions (James)

- **D-1 (2026-11-02):** responses move from handwritten to typed and scored
  in SecureTest.
- **D-2 (2026-11-02):** each option's sources are built into the test.
  Copyright: see D-17.
- **D-3 (2026-11-02):** student topic choice is restricted to curated options.
- **D-4 (2026-11-02):** the options are integrated into a single assessment
  per task per course (ten; each option an item set, the student sees only
  theirs). One per course is less confusing to students than one per task.
- **D-5 (2026-11-02):** Assessment grants proctoring per student, per
  assessment; the proctor controls the sessions. Counselor assigning is the
  goal; Assessment assigning is acceptable for v1.
- **D-6 (2026-11-02):** blind scoring is compromised for v1; human scoring
  until AI agrees consistently, then possibly AI.
- **D-7 (2026-11-02):** no proctor-training check in the app; Assessment
  handles it outside.
- **D-8 (2026-11-02):** counselors are assigned at the school level.
- **D-9 (2026-11-02):** start with the Social Studies tasks; others later.
- **D-10 (2026-11-02):** Assessment reviews results before release, for now.
- **D-11 (2026-11-02):** score-only access in v1.
- **D-12 (2026-11-02):** Assessment delegates scorer access.
- **D-13 (2026-11-02):** no PowerSchool push; counselors tell the registrar;
  responses are kept in SecureTest for review.
- **D-14 (2026-11-02):** Assessment staff are a fixed list, starting with
  the Director of Assessment only.
- **D-15 (2026-11-02):** only Assessment passes back for now; the scorer
  should be able to later.
- **D-16 (2026-11-02):** a Needs Revision's feedback is delivered through
  the app.

- **D-17 (2026-11-02):** building the sources into the tests is fair use:
  student research, and the tests are used only inside the district.
- **D-18 (2026-11-02):** switching option is treated as a new assessment;
  feedback does not follow.

## Open questions

None open.

## Progress

Nothing built.
