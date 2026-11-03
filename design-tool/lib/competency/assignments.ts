import { and, asc, eq, ne } from "drizzle-orm";
import type { NextResponse } from "next/server";
import type { getDb } from "@/db/client";
import {
  competency_assignments,
  item_sets,
  type AssessmentRow,
  type CompetencyAssignmentStatus,
} from "@/db/schema";
import { authorizeAssessment, notFoundResponse } from "@/lib/api/access";
import { isCompetencyAdmin } from "@/lib/auth/admin";
import type { SessionPayload } from "@/lib/auth/session";

type Db = ReturnType<typeof getDb>;

/**
 * Competency assignments (docs/competency-assessment-design.md, slice 2): the
 * one gate, the status machine and the option labels the routes and the
 * Assignments page share.
 */

/**
 * Where each STORED status may go next. Slice 6 (James 6.1) settled what is
 * stored: the milestones a person or a join writes — assigned, in progress
 * (first join, slice 4), released (Assessment's review, slice 6) and
 * withdrawn (a switch of option is a withdrawal plus a new assignment,
 * D-18). Handed in and Scored are read from the attempt and the final score
 * (lib/competency/caseState.ts) and never written, so they go nowhere here.
 * Released may be released again: a passed-back case that is rescored is
 * re-released with its new result. Withdrawn is final.
 */
export const ASSIGNMENT_TRANSITIONS: Record<CompetencyAssignmentStatus, readonly CompetencyAssignmentStatus[]> = {
  assigned: ["in_progress", "released", "withdrawn"],
  in_progress: ["released", "withdrawn"],
  handed_in: [],
  scored: [],
  released: ["released", "withdrawn"],
  withdrawn: [],
};

export function canTransition(from: CompetencyAssignmentStatus, to: CompetencyAssignmentStatus): boolean {
  return ASSIGNMENT_TRANSITIONS[from].includes(to);
}

export type CompetencyAccess =
  | { ok: true; assessment: AssessmentRow }
  | { ok: false; response: NextResponse };

/**
 * Assessment staff (D-14, `COMPETENCY_ADMIN_EMAILS`) on a district assessment
 * they can edit. Anyone else — a co-author not on the list, a listed person
 * on a teacher's own assessment, an act-as session — gets the same 404, so
 * the route does not say which part failed. `edit` rather than `own` lets a
 * second listed person work the cases once the owner shares the assessment.
 */
export async function authorizeCompetency(
  db: Db,
  session: SessionPayload,
  assessmentId: string,
  intent: "read" | "write",
): Promise<CompetencyAccess> {
  if (!isCompetencyAdmin(session)) return { ok: false, response: notFoundResponse() };
  const access = await authorizeAssessment(db, session, assessmentId, "edit", intent);
  if (!access.ok) return access;
  if (access.assessment.assigned_scope !== "district") {
    return { ok: false, response: notFoundResponse() };
  }
  return { ok: true, assessment: access.assessment };
}

export interface CompetencyOption {
  item_set_id: string;
  label: string;
}

/**
 * The assessment's options in authoring order, labelled "Option N" plus the
 * first source's label when there is one — the name a counselor and the
 * student agreed on is usually the prompt's topic, which is that label.
 */
export async function competencyOptions(db: Db, assessmentId: string): Promise<CompetencyOption[]> {
  const sets = await db
    .select({ id: item_sets.id, sources: item_sets.sources })
    .from(item_sets)
    .where(eq(item_sets.assessment_id, assessmentId))
    .orderBy(asc(item_sets.created_at), asc(item_sets.id));
  return sets.map((s, i) => {
    const first = s.sources[0]?.label?.trim();
    return { item_set_id: s.id, label: first ? `Option ${i + 1}: ${first}` : `Option ${i + 1}` };
  });
}

/** True when the set is one of this assessment's options. */
export async function isOptionOf(db: Db, assessmentId: string, itemSetId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: item_sets.id })
    .from(item_sets)
    .where(and(eq(item_sets.id, itemSetId), eq(item_sets.assessment_id, assessmentId)))
    .limit(1);
  return Boolean(row);
}

/**
 * The student's live (not withdrawn) assignment on this assessment, or null —
 * what delivery filters the bundle by (slice 3). Keyed by the roster id: an
 * overlay student with none has no assignment.
 */
export async function liveAssignmentFor(
  db: Db,
  assessmentId: string,
  rosterPsId: string | null,
): Promise<{ id: string; item_set_id: string } | null> {
  if (!rosterPsId) return null;
  const [row] = await db
    .select({ id: competency_assignments.id, item_set_id: competency_assignments.item_set_id })
    .from(competency_assignments)
    .where(
      and(
        eq(competency_assignments.assessment_id, assessmentId),
        eq(competency_assignments.student_ps_id, rosterPsId),
        ne(competency_assignments.status, "withdrawn"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Roster ids of the students on this assessment whose live assignment names
 * `proctorEmail` — the students a proctor may list in a sitting (slice 4).
 */
export async function proctoredStudentPsIds(
  db: Db,
  assessmentId: string,
  proctorEmail: string | null,
): Promise<Set<string>> {
  if (!proctorEmail) return new Set();
  const rows = await db
    .select({ ps: competency_assignments.student_ps_id })
    .from(competency_assignments)
    .where(
      and(
        eq(competency_assignments.assessment_id, assessmentId),
        eq(competency_assignments.proctor_email, proctorEmail),
        ne(competency_assignments.status, "withdrawn"),
      ),
    );
  return new Set(rows.map((r) => r.ps));
}

/**
 * The first join moves a case from assigned to in progress (slice 4). Only
 * from `assigned`, so a later join, or a case already further along, is
 * untouched; a no-op on anything that is not a district assignment.
 */
export async function markAssignmentStarted(db: Db, assessmentId: string, studentPsId: string): Promise<void> {
  await db
    .update(competency_assignments)
    .set({ status: "in_progress", updated_at: new Date() })
    .where(
      and(
        eq(competency_assignments.assessment_id, assessmentId),
        eq(competency_assignments.student_ps_id, studentPsId),
        eq(competency_assignments.status, "assigned"),
      ),
    );
}
