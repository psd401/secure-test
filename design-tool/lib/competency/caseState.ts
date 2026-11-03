import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Rubric } from "@secure-test/schema";
import type { getDb } from "@/db/client";
import {
  attempts,
  items,
  responses,
  scores,
  students,
  type AssessmentRow,
  type CompetencyAssignmentRow,
} from "@/db/schema";
import { deriveCompetencyResult, type CompetencyResult } from "@/lib/scoring/competencyResult";

type Db = ReturnType<typeof getDb>;

/**
 * What a case looks like right now (docs/competency-assessment-design.md,
 * slice 6, James 6.1). The stored status records only the milestones a
 * person or a join writes — assigned, in progress, released, withdrawn.
 * Handed in and Scored are READ, from the attempt and from the final score on
 * the option's final response, so a Change score, a pass back or an auto hand
 * in can never leave the case saying something the attempt does not.
 */
export type CaseStatus = "assigned" | "in_progress" | "handed_in" | "scored" | "released" | "withdrawn";

export interface CaseState {
  status: CaseStatus;
  /** The result the final score yields now; null until there is one. */
  result: CompetencyResult | null;
  attempt_id: string | null;
  /** When the current final score was written — newer than released_at means re-release. */
  scored_at: Date | null;
}

/** Pure: the case's status from what was stored and what the attempt and score say. */
export function caseStatusOf(input: {
  stored: CompetencyAssignmentRow["status"];
  released_at: Date | null;
  attempt_status: "in_progress" | "submitted" | null;
  result: CompetencyResult | null;
  scored_at: Date | null;
  /** F-1 (hand-run 2026-11-02): when the attempt was last handed in, and when
   * this assignment was made. A hand-in from BEFORE the assignment belongs to
   * an earlier option (D-18) — this case has not been started yet. */
  attempt_submitted_at?: Date | null;
  assigned_at?: Date | null;
}): CaseStatus {
  if (input.stored === "withdrawn") return "withdrawn";
  const staleHandIn =
    input.attempt_status === "submitted" &&
    input.attempt_submitted_at != null &&
    input.assigned_at != null &&
    input.attempt_submitted_at < input.assigned_at;
  if (input.attempt_status === null || staleHandIn) {
    return input.stored === "in_progress" ? "in_progress" : "assigned";
  }
  // A passed-back attempt is in progress again, whatever was released before.
  if (input.attempt_status === "in_progress") return "in_progress";
  if (input.result === null || input.scored_at === null) return "handed_in";
  if (input.stored === "released" && input.released_at && input.released_at >= input.scored_at) return "released";
  return "scored";
}

/**
 * The final response of each option: the item in the set with a rubric, the
 * last one by position if a set has several (the planning items carry none).
 */
async function finalItemBySet(db: Db, assessmentId: string): Promise<Map<string, { id: string; rubric: Rubric }>> {
  const rows = await db
    .select({ id: items.id, set: items.item_set_id, position: items.position, config: items.config })
    .from(items)
    .where(and(eq(items.assessment_id, assessmentId), isNotNull(items.item_set_id)));
  const out = new Map<string, { id: string; rubric: Rubric; position: number }>();
  for (const r of rows) {
    const rubric = r.config?.rubric;
    if (!r.set || !rubric) continue;
    const prev = out.get(r.set);
    if (!prev || r.position > prev.position) out.set(r.set, { id: r.id, rubric, position: r.position });
  }
  return new Map([...out].map(([k, v]) => [k, { id: v.id, rubric: v.rubric }]));
}

/**
 * Every case's state on one assessment, in three queries: the final items,
 * the students' attempts (the overlay rows live under the assessment's owner,
 * the tenant every join resolves into), and the final scores on those
 * responses.
 */
export async function loadCaseStates(
  db: Db,
  assessment: Pick<AssessmentRow, "id" | "owner_sub" | "competency_pass_min_points">,
  cases: readonly CompetencyAssignmentRow[],
): Promise<Map<string, CaseState>> {
  const out = new Map<string, CaseState>();
  if (cases.length === 0) return out;
  const finals = await finalItemBySet(db, assessment.id);

  const attemptRows = await db
    .select({ id: attempts.id, status: attempts.status, submitted_at: attempts.submitted_at, ps: students.roster_ps_id })
    .from(attempts)
    .innerJoin(students, eq(students.id, attempts.student_id))
    .where(
      and(
        eq(attempts.assessment_id, assessment.id),
        eq(students.owner_sub, assessment.owner_sub),
        inArray(
          students.roster_ps_id,
          cases.map((c) => c.student_ps_id),
        ),
      ),
    );
  const attemptByPs = new Map(attemptRows.map((a) => [a.ps, a]));

  const finalItemIds = [...new Set([...finals.values()].map((f) => f.id))];
  const scoreRows =
    attemptRows.length > 0 && finalItemIds.length > 0
      ? await db
          .select({
            attempt_id: responses.attempt_id,
            item_id: responses.item_id,
            rationale: scores.rationale,
            rubric_snapshot: scores.rubric_snapshot,
            created_at: scores.created_at,
          })
          .from(scores)
          .innerJoin(responses, eq(responses.id, scores.response_id))
          .where(
            and(
              eq(scores.status, "final"),
              inArray(
                responses.attempt_id,
                attemptRows.map((a) => a.id),
              ),
              inArray(responses.item_id, finalItemIds),
            ),
          )
          .orderBy(desc(scores.created_at))
      : [];
  const scoreOf = new Map(scoreRows.map((s) => [`${s.attempt_id}:${s.item_id}`, s]));

  for (const c of cases) {
    const attempt = attemptByPs.get(c.student_ps_id) ?? null;
    const final = finals.get(c.item_set_id);
    const score = attempt && final ? scoreOf.get(`${attempt.id}:${final.id}`) : undefined;
    const min = assessment.competency_pass_min_points;
    const result =
      score && final && min !== null
        ? deriveCompetencyResult(score.rubric_snapshot ?? final.rubric, score.rationale, min)
        : null;
    const scored_at = result ? (score?.created_at ?? null) : null;
    out.set(c.id, {
      status: caseStatusOf({
        stored: c.status,
        released_at: c.released_at,
        attempt_status: (attempt?.status as "in_progress" | "submitted" | undefined) ?? null,
        result,
        scored_at,
        attempt_submitted_at: attempt?.submitted_at ?? null,
        assigned_at: c.created_at,
      }),
      result,
      attempt_id: attempt?.id ?? null,
      scored_at,
    });
  }
  return out;
}

/**
 * The student's one attempt on this assessment (the overlay row lives under
 * the assessment's owner, the tenant every join resolves into), or null.
 */
export async function attemptForStudent(
  db: Db,
  assessment: Pick<AssessmentRow, "id" | "owner_sub">,
  studentPsId: string,
) {
  const [row] = await db
    .select({ attempt: attempts })
    .from(attempts)
    .innerJoin(students, eq(students.id, attempts.student_id))
    .where(
      and(
        eq(attempts.assessment_id, assessment.id),
        eq(students.owner_sub, assessment.owner_sub),
        eq(students.roster_ps_id, studentPsId),
      ),
    )
    .limit(1);
  return row?.attempt ?? null;
}
