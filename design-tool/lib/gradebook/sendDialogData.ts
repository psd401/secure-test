// The results page's Send-to-gradebook dialog inputs (slice 4): which sections
// the signed-in teacher can send, with "n scored · m awaiting scoring" and the
// last send. Server-side; reuses the `buildResults` rows the page already
// computed, so no second results pass.
//
// The section rule is `loadSectionCandidates`' (mapping.ts): the attempt's
// sitting's section when it named one, else the student's current enrollment.
// Only sections the SENDER currently teaches are offered — the send route
// refuses any other (authorizeSend), so listing it would be a dead option.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { attempts, gradebook_push_scores, gradebook_pushes, test_sessions } from "@/db/schema";
import type { getDb } from "@/db/client";
import { normalizeEmail, sectionsCurrentlyTaughtBy, studentsEnrolledInSection } from "@/lib/roster/queries";
import { sectionLabel } from "@/lib/roster/teacherRoster";
import type { AssessmentResults } from "@/lib/scoring/results";
import { candidateScore } from "./mapping";
import type { GradebookBasis } from "./types";
import { SEND_TARGET, type SendDialogSection } from "./sendDialog";

type Db = ReturnType<typeof getDb>;

export async function loadSendDialogSections(
  db: Db,
  assessmentId: string,
  senderEmail: string | null | undefined,
  results: Pick<AssessmentResults, "rows">,
): Promise<SendDialogSection[]> {
  const email = normalizeEmail(senderEmail);
  if (!email) return [];
  const taught = await sectionsCurrentlyTaughtBy(db, email);
  if (taught.length === 0) return [];

  const submitted = results.rows.filter((r) => r.status === "submitted");
  // U-25 slice 2: a student working again with an attempt 1 is still in the
  // section for an attempt-1 send (D-19), so their sitting is looked up too.
  const listed = results.rows.filter((r) => r.status === "submitted" || r.attempt_one !== null);
  const attemptRows =
    listed.length > 0
      ? await db
          .select({ id: attempts.id, test_session_id: attempts.test_session_id })
          .from(attempts)
          .where(inArray(attempts.id, listed.map((r) => r.attempt_id)))
      : [];
  const sittingByAttempt = new Map(attemptRows.map((a) => [a.id, a.test_session_id]));
  const sittingIds = [...new Set(attemptRows.map((a) => a.test_session_id).filter((v): v is string => !!v))];
  const sittings =
    sittingIds.length > 0
      ? await db
          .select({ id: test_sessions.id, section_ps_id: test_sessions.section_ps_id })
          .from(test_sessions)
          .where(inArray(test_sessions.id, sittingIds))
      : [];
  const sectionBySitting = new Map(sittings.map((s) => [s.id, s.section_ps_id]));

  const pushes = await db
    .select({
      id: gradebook_pushes.id,
      section_ps_id: gradebook_pushes.section_ps_id,
      last_sent_at: gradebook_pushes.last_sent_at,
      basis: gradebook_pushes.basis,
    })
    .from(gradebook_pushes)
    .where(
      and(
        eq(gradebook_pushes.assessment_id, assessmentId),
        eq(gradebook_pushes.target, SEND_TARGET),
        isNull(gradebook_pushes.archived_at),
      ),
    );
  const lastSent = new Map(pushes.map((p) => [p.section_ps_id, p.last_sent_at]));
  const basisBySection = new Map(
    pushes.map((p) => [p.section_ps_id, p.basis as GradebookBasis]),
  );

  // E11 (D-3): what each attempt last sent, per live push, against the total
  // the page now shows — a mismatch is a score changed since the send.
  const sentRows =
    pushes.length > 0
      ? await db
          .select({
            push_id: gradebook_push_scores.push_id,
            attempt_id: gradebook_push_scores.attempt_id,
            points_sent: gradebook_push_scores.points_sent,
          })
          .from(gradebook_push_scores)
          .where(
            inArray(
              gradebook_push_scores.push_id,
              pushes.map((p) => p.id),
            ),
          )
      : [];
  const sectionByPush = new Map(pushes.map((p) => [p.id, p.section_ps_id]));
  // U-25 slice 2: "changed" is against the score the push's own basis would
  // send now (`candidateScore`), so an attempt-1 push is not flagged by a
  // retake it never sends.
  const rowByAttempt = new Map(results.rows.map((r) => [r.attempt_id, r]));
  const changedBySection = new Map<string, number>();
  for (const sent of sentRows) {
    const section = sectionByPush.get(sent.push_id)!;
    const row = rowByAttempt.get(sent.attempt_id);
    const total = row
      ? candidateScore(row, basisBySection.get(section) ?? "latest")?.total_points
      : undefined;
    if (total === undefined || total === sent.points_sent) continue;
    changedBySection.set(section, (changedBySection.get(section) ?? 0) + 1);
  }

  const out: SendDialogSection[] = [];
  for (const section of taught) {
    const enrolled = new Set((await studentsEnrolledInSection(db, section.ps_id)).map((s) => s.ps_id));
    let scored = 0;
    let awaiting = 0;
    let withAttemptOne = 0;
    for (const row of listed) {
      const sittingId = sittingByAttempt.get(row.attempt_id) ?? null;
      const sittingSection = sittingId ? (sectionBySitting.get(sittingId) ?? null) : null;
      const inSection = sittingSection
        ? sittingSection === section.ps_id
        : row.student.student_number !== null && enrolled.has(row.student.student_number);
      if (!inSection) continue;
      if (row.attempt_one) withAttemptOne++;
      if (row.status !== "submitted") continue;
      if (row.unscored_count === 0) scored++;
      else awaiting++;
    }
    const sent = lastSent.get(section.ps_id) ?? null;
    // A section with no handed-in work and no earlier send has nothing to offer
    // — unless someone in it has an attempt 1: a class passed back and still
    // working can still be sent its attempt-1 scores (U-25 hand-run, row 918).
    if (scored + awaiting === 0 && withAttemptOne === 0 && !sent) continue;
    out.push({
      ps_id: section.ps_id,
      label: sectionLabel(section),
      scored,
      awaiting,
      last_sent_at: sent ? sent.toISOString() : null,
      changed_since_send: changedBySection.get(section.ps_id) ?? 0,
      basis: basisBySection.get(section.ps_id) ?? null,
      attempt_one_students: withAttemptOne,
    });
  }
  return out;
}
