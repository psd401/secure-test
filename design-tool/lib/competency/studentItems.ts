import { and, desc, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { competency_assignments } from "@/db/schema";

type Db = ReturnType<typeof getDb>;

/**
 * F-2 (hand-run 2026-11-02, docs/competency-assessment-design.md D-4): on a
 * district assessment each student is given ONE option, so their progress,
 * their results page and their row's maximum count that option's questions
 * plus any question in no set — the same rule delivery uses
 * (`buildDeliveryBundle`'s `onlyItemSetId`). Classroom assessments, and a
 * student with no assignment, keep every question.
 */

/**
 * Each student's option on this assessment: the live (not withdrawn)
 * assignment's set, else the most recent one's — so a withdrawn student's
 * record still reads against the option they took.
 */
export async function optionByStudent(
  db: Db,
  assessmentId: string,
  studentPsIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (studentPsIds.length === 0) return out;
  const rows = await db
    .select({
      ps: competency_assignments.student_ps_id,
      set: competency_assignments.item_set_id,
      status: competency_assignments.status,
    })
    .from(competency_assignments)
    .where(
      and(
        eq(competency_assignments.assessment_id, assessmentId),
        inArray(competency_assignments.student_ps_id, [...new Set(studentPsIds)]),
      ),
    )
    .orderBy(desc(competency_assignments.created_at));
  for (const r of rows) {
    if (r.status !== "withdrawn") out.set(r.ps, r.set);
  }
  for (const r of rows) {
    if (!out.has(r.ps)) out.set(r.ps, r.set);
  }
  return out;
}

/** Whether this question is the student's: no option known = every question. */
export function inStudentOption(item: { item_set_id: string | null }, option: string | undefined): boolean {
  return !option || item.item_set_id === null || item.item_set_id === option;
}
