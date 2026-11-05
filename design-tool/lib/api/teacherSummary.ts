import { count, countDistinct, eq, isNull, max, ne, sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { assessments, attempts, students, test_sessions } from "@/db/schema";

/**
 * The admin "By teacher" summary (/dashboard?all=1&view=teachers): one row
 * per assessment owner, for seeing who uses SecureTest and how much. Admin
 * only — the page reaches it only in the all view, which `homeListMode`
 * already limits to admins. Counts only; no student identity is returned.
 *
 * Archived assessments are included: they are still part of a teacher's
 * history. Practice sittings and the staff attempts made in them are not —
 * they are a teacher trying the test, not students taking it.
 */
export interface TeacherSummaryRow {
  owner_sub: string;
  owner_email: string | null;
  assessments: number;
  drafts: number;
  published: number;
  archived: number;
  /** Class sittings opened (practice sittings excluded). */
  sittings: number;
  /** Distinct students with at least one attempt on any of the owner's assessments. */
  students: number;
  /** Submitted student attempts. */
  submitted: number;
  /** Newest of: an assessment edited, a class sitting opened, a student attempt started. */
  last_activity: Date | null;
}

type Db = ReturnType<typeof getDb>;

export async function teacherSummary(db: Db): Promise<TeacherSummaryRow[]> {
  const [owned, sittings, work] = await Promise.all([
    db
      .select({
        owner_sub: assessments.owner_sub,
        owner_email: max(assessments.owner_email),
        assessments: count(),
        drafts: sql<number>`(count(*) filter (where ${assessments.status} = 'draft'))::int`,
        published: sql<number>`(count(*) filter (where ${assessments.status} = 'published'))::int`,
        archived: sql<number>`(count(*) filter (where ${assessments.archived_at} is not null))::int`,
        last: max(assessments.updated_at),
      })
      .from(assessments)
      .groupBy(assessments.owner_sub),
    db
      .select({
        owner_sub: assessments.owner_sub,
        sittings: count(),
        last: max(test_sessions.created_at),
      })
      .from(test_sessions)
      .innerJoin(assessments, eq(assessments.id, test_sessions.assessment_id))
      .where(ne(test_sessions.kind, "practice"))
      .groupBy(assessments.owner_sub),
    db
      .select({
        owner_sub: assessments.owner_sub,
        students: countDistinct(attempts.student_id),
        submitted: sql<number>`(count(*) filter (where ${attempts.status} = 'submitted'))::int`,
        last: max(attempts.started_at),
      })
      .from(attempts)
      .innerJoin(assessments, eq(assessments.id, attempts.assessment_id))
      .innerJoin(students, eq(students.id, attempts.student_id))
      .where(isNull(students.practice_for_sub))
      .groupBy(assessments.owner_sub),
  ]);

  const sittingsFor = new Map(sittings.map((s) => [s.owner_sub, s]));
  const workFor = new Map(work.map((w) => [w.owner_sub, w]));
  return owned.map((o) => {
    const s = sittingsFor.get(o.owner_sub);
    const w = workFor.get(o.owner_sub);
    return {
      owner_sub: o.owner_sub,
      owner_email: o.owner_email,
      assessments: o.assessments,
      drafts: o.drafts,
      published: o.published,
      archived: o.archived,
      sittings: s?.sittings ?? 0,
      students: w?.students ?? 0,
      submitted: w?.submitted ?? 0,
      last_activity: latest(o.last, s?.last, w?.last),
    };
  });
}

function latest(...ds: (Date | string | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const d of ds) {
    if (!d) continue;
    const t = d instanceof Date ? d : new Date(d);
    if (!best || t > best) best = t;
  }
  return best;
}
