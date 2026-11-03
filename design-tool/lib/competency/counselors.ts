import { and, asc, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import {
  access_grants,
  assessments,
  competency_assignments,
  roster_students,
  type AccessGrantRow,
} from "@/db/schema";
import { normalizeEmail } from "@/lib/roster/queries";
import { studentDisplayName } from "@/lib/roster/teacherRoster";
import { competencyOptions } from "@/lib/competency/assignments";
import { schoolGrantSchools } from "@/lib/competency/schoolGrants";

type Db = ReturnType<typeof getDb>;

/**
 * Counselors (docs/competency-assessment-design.md, slice 6, James 6.2/6.3).
 *
 * A counselor is a `school`-scoped grant at `view` made by Assessment staff.
 * The grant is read ONLY here — `lib/api/grants.ts` still skips the school
 * scope, so it opens no assessment, sitting, attempt or result anywhere else.
 * What it reaches is the released result (not the response) of competency
 * cases for students whose roster `school_id` is the grant's.
 */

/**
 * The two counselor grants: `view` reads released results; `run` also assigns
 * that school's students (slice 8). Anything higher on a school is not
 * Assessment's to list or remove from here.
 */
const COUNSELOR_LEVELS = ["view", "run"];

/** Live now, by the database's clock (see lib/competency/schoolGrants.ts). */
const live = () =>
  and(
    isNull(access_grants.revoked_at),
    sql`${access_grants.starts_at} <= now()`,
    or(isNull(access_grants.ends_at), sql`${access_grants.ends_at} > now()`),
  );

/** The schools whose released results this email may read now (any counselor grant). */
export async function counselorSchoolIds(db: Db, email: string | null | undefined): Promise<string[]> {
  return schoolGrantSchools(db, email, "view");
}

/** Every live counselor grant (school scope at `view` or `run`), for Assessment's page. */
export async function listCounselorGrants(db: Db): Promise<AccessGrantRow[]> {
  return db
    .select()
    .from(access_grants)
    .where(
      and(eq(access_grants.scope_kind, "school"), inArray(access_grants.level, COUNSELOR_LEVELS), live()),
    )
    .orderBy(asc(access_grants.scope_id), asc(access_grants.grantee_email));
}

/** The roster's schools, by id, with their active student counts. */
export async function rosterSchools(db: Db): Promise<{ school_id: string; students: number }[]> {
  const rows = await db
    .select({ school_id: roster_students.school_id, n: count() })
    .from(roster_students)
    .where(eq(roster_students.is_active, true))
    .groupBy(roster_students.school_id)
    .orderBy(asc(roster_students.school_id));
  return rows
    .filter((r): r is { school_id: string; n: number } => r.school_id !== null)
    .map((r) => ({ school_id: r.school_id, students: r.n }));
}

/**
 * Soft-revoke one counselor grant. Only a school-scope `view` / `run` grant — a
 * principal's school grant made through the admin surface is not
 * Assessment's to remove from here.
 */
export async function revokeCounselorGrant(db: Db, grantId: string): Promise<boolean> {
  const rows = await db
    .update(access_grants)
    .set({ revoked_at: new Date() })
    .where(
      and(
        eq(access_grants.id, grantId),
        eq(access_grants.scope_kind, "school"),
        inArray(access_grants.level, COUNSELOR_LEVELS),
        isNull(access_grants.revoked_at),
      ),
    )
    .returning({ id: access_grants.id });
  return rows.length > 0;
}

export interface ReleasedResult {
  assignment_id: string;
  student_name: string;
  grade: string | null;
  school_id: string | null;
  assessment_name: string;
  option_label: string;
  result: string;
  released_at: string;
}

/**
 * Released competency results for students in these schools, newest first.
 * The stored result is what Assessment released — a later rescore shows here
 * only once it is released again.
 */
export async function releasedResultsForSchools(db: Db, schoolIds: readonly string[]): Promise<ReleasedResult[]> {
  if (schoolIds.length === 0) return [];
  const rows = await db
    .select({ a: competency_assignments, s: roster_students, asmt: assessments })
    .from(competency_assignments)
    .innerJoin(assessments, eq(assessments.id, competency_assignments.assessment_id))
    .innerJoin(roster_students, eq(roster_students.ps_id, competency_assignments.student_ps_id))
    .where(
      and(
        eq(competency_assignments.status, "released"),
        eq(assessments.assigned_scope, "district"),
        inArray(roster_students.school_id, [...schoolIds]),
      ),
    )
    .orderBy(desc(competency_assignments.released_at));
  const labels = new Map<string, Map<string, string>>();
  for (const { asmt } of rows) {
    if (labels.has(asmt.id)) continue;
    labels.set(asmt.id, new Map((await competencyOptions(db, asmt.id)).map((o) => [o.item_set_id, o.label])));
  }
  return rows
    .filter(({ a }) => a.result !== null && a.released_at !== null)
    .map(({ a, s, asmt }) => ({
      assignment_id: a.id,
      student_name: studentDisplayName(s),
      grade: s.grade,
      school_id: s.school_id,
      assessment_name: asmt.name,
      option_label: labels.get(asmt.id)?.get(a.item_set_id) ?? "Option",
      result: a.result!,
      released_at: a.released_at!.toISOString(),
    }));
}
