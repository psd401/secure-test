# Feedback release to students — design note

Roadmap row FR (new). Side: design-tool only (no client change, no release).
Asked by James, 2026-10-29, after a beta teacher asked whether students can
get AI feedback without the AI's score. Goal: a teacher writes their own
feedback and releases any combination of teacher score, AI score, teacher
feedback and AI feedback to students, as a Google Doc (through Drive) or a
PDF (through the student-work packet).

## What exists (2026-10-29)

- **Google Doc send** (`docs/google-docs-release-design.md`, row GD;
  `lib/googleDocs/content.ts`). Essays only (GD D-8). The send dialog has
  independent boxes for prompt, sources, score, teacher feedback and AI
  feedback, so "AI feedback, no score" already works for an essay whose
  final score is an approved AI score.
- **Student-work packet** (`app/dashboard/[id]/results/work/page.tsx`,
  `lib/reporting/workPacket.ts`, `docs/student-work-export-design.md`). The
  PDF route: per section or per student, Save-as-PDF from the browser (ADR
  0013). Prints what the student wrote (`?answers=0` leaves it out), with
  `?scores=none|teacher|ai|both`. Each score block carries its rubric table
  and that scorer's comments, so AI comments print only with the AI score.
  The `ai` side prints the latest AI row whatever its status, headed "AI
  proposal", "AI score (not reviewed)" or "AI score (approved)" — it was
  built for a teacher to annotate, not for students.
- **Report print page** (`app/dashboard/[id]/results/print/page.tsx`). The
  family-facing marks report; never prints a student's answer. AI rubric
  comments only when the rubric opts in (`student_visibility.with_feedback`).
  Not the PDF route for this note (D-6).
- **Score rows** (`scores`). Approving an AI proposal inserts a new `final`
  row with `method = 'ai'` and `reviewed_by_sub` set; the proposal stays.
  Hybrid can settle an AI `final` with no reviewer. Overriding inserts a
  `final` row with `method = 'human'`; the AI proposal stays `proposed`.
  Changing a final supersedes it and writes a new `human` final whose
  optional reason is stored as `rationale.note`.
- **AI short answer** (PR #137) is on `main` and live since 2026-10-28.

## Gaps this note closes

1. **No way to type teacher feedback.** No screen sends a scoring `note`.
2. **A score-change reason leaks as feedback.** The Doc's "Teacher
   feedback" box prints `rationale.note`, and the only writer of that field
   is the change-score reason (`lib/api/reviewActions.ts`). A reason such
   as "regraded after appeal" reaches the student labelled as feedback.
3. **Feedback is not labelled by source** in the Doc: the AI's overall
   comment prints under "Feedback:", and its rubric column is headed
   "Feedback".
4. **Score and feedback are tied together.** The Doc has one score box; the
   packet prints AI comments only inside the AI score block.
5. **AI feedback is lost on override** in the Doc (it needs the final row
   to be the AI's).
6. **The packet shows students AI scores a teacher overrode** ("AI
   proposal") when the `ai` side is chosen.
7. **The Doc is essay-only.** The packet already covers every type.

## Decisions (James, 2026-10-29)

- **D-1 Source labels, always.** Every feedback block and every score says
  where it came from: "Teacher feedback", "AI feedback", "Teacher score",
  "AI score". No unlabelled "Feedback" anywhere a student reads.
- **D-2 Any combination.** Teacher score, AI score, teacher feedback and AI
  feedback are four independent boxes; none ticked is allowed.
- **D-3 Overridden AI scores are never shown.** "AI score" means the
  response's `final` row is the AI's (`method = 'ai'`). When the teacher
  overrode or changed it, the AI score box prints nothing for that
  question (D-17: a Hybrid final no teacher reviewed still counts).
- **D-4 Teacher feedback per question AND per student overall**, both
  optional.
- **D-5 Essays and short answers** in both outputs.
- **D-6 Two outputs.** Google Doc through the existing Drive send; PDF
  through the student-work packet.
- **D-7 A send-time menu.** The same boxes on the Doc dialog and the packet
  toolbar; the rubric's `with_feedback` opt-in does not gate either.
- **D-8 The AI's wording is unchanged.** Rubric language and level names in
  the AI's comments stay until teachers say otherwise.
- **D-9 Label text.** "AI score" (not "AI-suggested score").
- **D-10 AI feedback survives an override.** After a teacher overrides the
  AI score, the AI's comments can still go to the student, labelled "AI
  feedback", from the AI's own row (latest non-research, non-superseded
  `ai` row). D-3 still hides the score.
- **D-11 The PDF includes the student's answer** by default — the packet's
  existing behaviour; `answers=0` stays for a feedback-only sheet.
- **D-12 One teacher comment per question** (and one overall per student).
  Co-teachers edit the same comment; the last editor is recorded.
- **D-13 Auto-scored questions** (multiple choice, exact-match short answer)
  print under a plain "Score" when either score box is ticked.
- **D-14 Teacher feedback stays out of AI.** Not in class insights, the
  insights chat, or any prompt — for now.
- **D-15 R-1 to R-4 accepted** as written below.
- **D-16 The packet keeps a teacher copy.** A "Teacher copy" option keeps
  today's AI headings ("AI proposal", "AI score (not reviewed)", "AI score
  (approved)") for annotating. Without it the packet is the student copy
  and D-3 applies.
- **D-17 Hybrid AI finals no teacher reviewed are shown** as "AI score":
  D-3's "the AI's score stands" includes them.

## Recommendations (accepted 2026-10-29, D-15)

- **R-1 Teacher feedback lives in its own tables**, not in
  `scores.rationale`. Scores are append-only and superseded on change;
  feedback should survive a score change and be edited in place. The
  change-score reason stays in `rationale.note` and never prints for
  students.
- **R-2 A rubric-table box**, default off. On: the table shows criterion
  and level, points only when a score box is ticked, and the AI's
  per-criterion comments only when AI feedback is ticked. Off: the AI's
  per-criterion comments print as a labelled list.
- **R-3 One content model for both outputs.** A pure
  `buildFeedbackRelease(contents, attemptData)` → a labelled block list,
  rendered to Doc HTML by `lib/googleDocs/content.ts` and to JSX by the
  packet, so the two cannot drift and every combination is tested without
  Drive or a browser.
- **R-4 Remember the teacher's last choices** per assessment.

## Contents model

```
contents: {
  prompt, sources,                 // Doc only, as today (GD D-2)
  answer,                          // packet: today's answers=0|1 (D-11)
  teacher_score, ai_score,         // D-2, D-3, D-13
  teacher_feedback, ai_feedback,   // D-2, D-4, D-10
  rubric_table,                    // R-2
}
```

Per question, what prints:

| Box | Source | Prints when |
|---|---|---|
| Teacher score | `final` row, `method = 'human'` | the teacher scored or changed it |
| AI score | `final` row, `method = 'ai'` | the AI's score stands (D-3) |
| (either) | `final` row, `method = 'auto'` | printed as "Score" (D-13) |
| Teacher feedback | `response_feedback` row | the teacher wrote some |
| AI feedback | the AI's own row (D-10) | the AI scored the response |

The per-student overall teacher feedback prints once, at the top, under
"Teacher feedback". The packet's `scores=` parameter maps onto the two
score boxes (`both` = both ticked), so old bookmarked URLs keep working.

## Data model (migration, next free number)

- `response_feedback` — `id`, `response_id` (cascade), `author_sub`,
  `text` (≤ 4000), `created_at`, `updated_at`. Unique on `response_id`
  (D-12).
- `attempt_feedback` — same shape keyed on `attempt_id`: the overall
  comment (D-4).
- `google_doc_releases.contents` keeps its jsonb shape; new keys are added,
  old rows read `score` as `teacher_score || ai_score`.
- Event kind `feedback_edited` on the attempt timeline (staff-only), so a
  comment written after a release is visible.

FERPA: teacher feedback is student-record content. It never goes into a
log, the class-insights evidence pack, or an AI prompt (D-14).

## Slices

1. **Labels and the leak fix.** The Doc says "AI feedback" / "Teacher
   score" etc. (D-1) and stops reading `rationale.note`; auto scores print
   as "Score" (D-13). No migration. Tests on `buildDocHtml` for every
   label and for a change-score reason that must not appear. Ships alone.
2. **Teacher feedback entry.** Migration (`response_feedback`,
   `attempt_feedback`, event kind); `PUT`/`DELETE` routes at **edit**
   level; a comment box per question in the scoring queue and on the
   per-student results page, and an overall box on the per-student page.
   Not shown to students yet.
3. **Shared content model + Doc dialog.** R-3's builder; the Doc dialog's
   boxes become the D-2 set plus R-2; AI feedback per D-10; R-4.
4. **Packet menu.** The packet toolbar gets the same boxes; score and
   feedback split; D-3 applied to the AI score unless "Teacher copy" is on
   (D-16); teacher feedback printed.
5. **Short answers in the Doc.** The Doc gains short-answer questions
   beside essays (D-5); the packet already prints them.
6. **Rows** in `docs/design-tool-manual-checks.md`: each box alone; all
   four; none; an approved AI score; an overridden AI score (score hidden,
   AI feedback shown); a Hybrid AI final; a changed score whose reason must
   not print; overall feedback only; a short answer; an auto-scored
   question; Doc and PDF from the same choices match.

## Risks

- **Old Docs keep the leak.** Docs already released with a change reason
  under "Teacher feedback" stay as sent. Slice 1 can list affected releases
  (a read-only query) so teachers can check them.
- **AI feedback beside a teacher score that disagrees** (D-10). A student
  may read AI comments that argue for a different score. The labels make
  the source plain; the teacher can untick AI feedback.
- **The packet has two audiences.** Teachers print it to annotate (they
  want proposals); students get it as feedback (D-3). D-16's teacher-copy
  option keeps the two apart; the student copy is the default.

## Questions

None open. Answered 2026-10-29: 1.1 → D-10, 1.2 → D-11, 1.3 → D-12,
1.4 → D-13, 1.5 → D-14, 1.6 → D-15, 2.1 → D-16, 2.2 → D-17.

## Progress

- 2026-10-29: note written; revised the same day (PDF route = the packet,
  AI short answer live). No code.
- 2026-10-29: slice 2 built. Migration
  0066 adds `response_feedback` and `attempt_feedback` (unique per response /
  attempt, text 1–4000, `author_sub` = last editor) and the staff-only
  `feedback_edited` event kind (detail `{ scope, response_id?, item_id?,
  action }`, never the text). `PUT`/`DELETE /api/responses/[responseId]/feedback`
  (through `loadResponseChain`) and `/api/attempts/[attemptId]/feedback`
  (through `authorizeAttempt`), both edit level, write intent, 404 posture,
  handed-in attempts only; an identical save writes nothing and a DELETE of
  nothing is a quiet 200. Writes live in `lib/teacherFeedback/write.ts`, which
  rethrows a DB failure as a bare error so the text cannot reach the error
  log (D-14). `TeacherFeedbackBox` (explicit Save, "Not saved" while dirty)
  on every scoring-queue card and per answer on the per-student page, plus
  an overall box there; read-only text below edit level. Not printed by the
  family report (`NOT_PRINTED`); the timeline says "Feedback edited / cleared
  by teacher". The insights evidence-pack test now carries a feedback
  sentinel that must not appear. Known gap: a comment on a question is
  deleted with its response row, so if an attempt is passed back and the
  student withdraws that answer, the comment goes with it.
- 2026-10-29: slice 3 built. `buildFeedbackRelease` (`lib/reporting/feedbackRelease.ts`,
  R-3) turns the boxes plus each question's score rows, rubric and teacher
  comment into labelled blocks (score, rubric table, AI feedback, teacher
  feedback) and the overall comment; `lib/googleDocs/content.ts` only renders
  them. The Doc dialog's boxes are prompt, sources, teacher score, AI score,
  teacher feedback, AI feedback and rubric table (R-2, off by default). AI
  score only when the final row is the AI's, reviewed or not (D-3, D-17); AI
  feedback from the latest non-research, non-superseded `ai` row, so it
  survives an override (D-10), but never an AI row older than the answer's
  last edit (`responses.updated_at`): a pass-back leaves proposals in place,
  and one about the old answer must not reach the student. Rubric-table
  levels and points come from the final row only. The route still accepts an older tab's `score` and every
  saved `contents` is read through `readReleaseContents`, where `score` means
  both score boxes. Migration 0067 adds `feedback_release_prefs`
  (staff × assessment, R-4), written after each send (best-effort: a failed
  write is a bare warning, never a failed send) and read by both pages that
  show the dialog. Open for a ruling: (T1) a changed Hybrid final loses its
  AI feedback, because Hybrid's only AI row is superseded by the change — the
  code and the dialog's hint ("even when you overrode the AI's proposal")
  follow D-10 as written until James rules;
  (T2) an unreviewed proposal with no final still sends its comments as AI
  feedback, as D-10 is written; teachers' own per-criterion comments on a
  manual score are not printed.
