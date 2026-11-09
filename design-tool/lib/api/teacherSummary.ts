import { count, eq, sql, type SQL } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { assessments, attempts, students } from "@/db/schema";

type Db = ReturnType<typeof getDb>;

/**
 * Per-assessment attempt counts for the dashboard list, within `scope` (the
 * caller's `visibleAssessmentScope(...).condition`).
 *
 * - `n`: every attempt, practice included — the row's Delete gate is about
 *   any attempt existing (docs/archive-and-delete-design.md D-1 / D-4).
 * - `students` / `submitted`: the all view's participation columns. They
 *   leave out practice attempts (a staff overlay student, `practice_for_sub`):
 *   a teacher trying the test is not a student taking it.
 *
 * `attempts.student_id` is NOT NULL with an FK, so the students join cannot
 * drop a row from `n`.
 */
export async function attemptStatsByAssessment(db: Db, scope: SQL | undefined) {
  return db
    .select({
      assessment_id: attempts.assessment_id,
      n: count(),
      students: sql<number>`(count(distinct ${attempts.student_id}) filter (where ${students.practice_for_sub} is null))::int`,
      submitted: sql<number>`(count(*) filter (where ${attempts.status} = 'submitted' and ${students.practice_for_sub} is null))::int`,
    })
    .from(attempts)
    .innerJoin(assessments, eq(assessments.id, attempts.assessment_id))
    .innerJoin(students, eq(students.id, attempts.student_id))
    .where(scope)
    .groupBy(attempts.assessment_id);
}
