import { and, asc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { assessments, competency_assignments, roster_students, test_sessions } from "@/db/schema";
import { studentDisplayName } from "@/lib/roster/teacherRoster";
import { competencyOptions } from "@/lib/competency/assignments";

type Db = ReturnType<typeof getDb>;

export interface ProctorStudent {
  assignment_id: string;
  ps_id: string;
  name: string;
  grade: string | null;
  option_label: string;
  status: string;
}

export interface ProctorSitting {
  id: string;
  code: string;
  expires_at: string;
  student_ps_ids: string[];
}

export interface ProctorAssessment {
  id: string;
  name: string;
  published: boolean;
  students: ProctorStudent[];
  open_sittings: ProctorSitting[];
}

/**
 * The proctor's home list (docs/competency-assessment-design.md, slice 4):
 * every live assignment naming `proctorEmail`, grouped by district
 * assessment, with the open sittings this proctor started on each. Keyed on
 * the caller's own email, so it reads nothing the proctor could not reach
 * through the sitting routes anyway. Archived assessments are left out.
 */
export async function loadProctorCases(
  db: Db,
  proctorEmail: string | null,
  proctorSub: string,
): Promise<ProctorAssessment[]> {
  if (!proctorEmail) return [];
  const rows = await db
    .select({ a: competency_assignments, s: roster_students, asmt: assessments })
    .from(competency_assignments)
    .innerJoin(assessments, eq(assessments.id, competency_assignments.assessment_id))
    .innerJoin(roster_students, eq(roster_students.ps_id, competency_assignments.student_ps_id))
    .where(
      and(
        eq(competency_assignments.proctor_email, proctorEmail),
        ne(competency_assignments.status, "withdrawn"),
        eq(assessments.assigned_scope, "district"),
        isNull(assessments.archived_at),
      ),
    )
    .orderBy(asc(assessments.name), asc(roster_students.last_name), asc(roster_students.first_name));
  if (rows.length === 0) return [];

  const byAssessment = new Map<string, ProctorAssessment>();
  const labels = new Map<string, Map<string, string>>();
  for (const { asmt } of rows) {
    if (labels.has(asmt.id)) continue;
    labels.set(asmt.id, new Map((await competencyOptions(db, asmt.id)).map((o) => [o.item_set_id, o.label])));
  }
  for (const { a, s, asmt } of rows) {
    const group = byAssessment.get(asmt.id) ?? {
      id: asmt.id,
      name: asmt.name,
      published: asmt.status === "published",
      students: [],
      open_sittings: [],
    };
    group.students.push({
      assignment_id: a.id,
      ps_id: s.ps_id,
      name: studentDisplayName(s),
      grade: s.grade,
      option_label: labels.get(asmt.id)?.get(a.item_set_id) ?? "Option",
      status: a.status,
    });
    byAssessment.set(asmt.id, group);
  }

  const sittings = await db
    .select()
    .from(test_sessions)
    .where(
      and(
        inArray(test_sessions.assessment_id, [...byAssessment.keys()]),
        eq(test_sessions.owner_sub, proctorSub),
        eq(test_sessions.status, "open"),
        eq(test_sessions.kind, "class"),
        gt(test_sessions.expires_at, new Date()),
        isNull(test_sessions.archived_at),
      ),
    )
    .orderBy(asc(test_sessions.created_at));
  for (const t of sittings) {
    byAssessment.get(t.assessment_id)?.open_sittings.push({
      id: t.id,
      code: t.code,
      expires_at: t.expires_at.toISOString(),
      student_ps_ids: t.student_ps_ids ?? [],
    });
  }
  return [...byAssessment.values()];
}

/** How many live cases name this proctor — the home list's cue (slice 4). */
export async function proctorCaseCount(db: Db, proctorEmail: string | null): Promise<number> {
  if (!proctorEmail) return 0;
  const rows = await db
    .select({ id: competency_assignments.id })
    .from(competency_assignments)
    .innerJoin(assessments, eq(assessments.id, competency_assignments.assessment_id))
    .where(
      and(
        eq(competency_assignments.proctor_email, proctorEmail),
        ne(competency_assignments.status, "withdrawn"),
        eq(assessments.assigned_scope, "district"),
        isNull(assessments.archived_at),
      ),
    );
  return rows.length;
}
