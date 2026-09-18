// Roster-suggested co-teachers for the Share dialog's Co-teach mode
// (docs/access-model-design.md, D-4 (b)), access slice 3.
//
// "Co-teacher" is a roster fact, not a grant — `coTeachersOf` reads it, the
// Share dialog offers one-click Co-teach, and the CALLER decides whether to
// write an `access_grants` row. Nothing here writes.
//
// Who counts as a co-teacher of `teacherEmail`, on a section they CURRENTLY
// teach together (same liveness rule as `sectionsCurrentlyTaughtBy`:
// `roster_section_teachers.is_active` and `start_date <= today <= end_date`,
// the section itself active):
//
//   - the OTHER teacher's row is `Co-Teacher`, regardless of the caller's own
//     role (a Lead Teacher's co-teacher suggests themselves to the lead); or
//   - the CALLER's own row is `Co-Teacher` and the other's is `Lead Teacher`
//     (co-teaching is symmetric: the co-teacher also sees the lead).
//
// `Student Teacher` never counts, on either side — U-1's later `run`-level
// grant, not this one. Matched case-insensitively: the fixture CSV spells it
// `Co-Teacher`, the design note's warehouse measurement `Co-teacher`.
import { and, eq, ne, sql } from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";
import { roster_section_teachers, roster_sections } from "@/db/schema";
import type { getDb } from "@/db/client";
import { normalizeEmail, teacherAssignmentIsCurrentOn } from "@/lib/roster/queries";

type Db = ReturnType<typeof getDb>;

const lowerRole = (col: PgColumn) => sql<string>`lower(trim(${col}))`;

const STUDENT_TEACHER = "student teacher";
const CO_TEACHER = "co-teacher";
const LEAD_TEACHER = "lead teacher";

export interface CoTeachSection {
  course_name: string;
  period_expression: string;
}

export interface CoTeacherSuggestion {
  email: string;
  sections: CoTeachSection[];
}

/**
 * Every CURRENT co-teacher of `teacherEmail`, with the shared sections they
 * co-teach — sorted by email, then by section so the list is stable.
 *
 * One query: `self` is the caller's own assignment rows, `other` every OTHER
 * teacher's row on the same section, joined and filtered in SQL so a hundred
 * sections cost one round trip, not one per section.
 */
export async function coTeachersOf(
  db: Db,
  teacherEmail: string,
  // Accepted for symmetry with the route's signature and a future caller
  // that wants a specific day; liveness is evaluated by the DATABASE's own
  // `current_date` (`teacherAssignmentIsCurrentOn`), the same posture as
  // `sectionsCurrentlyTaughtBy`, so a long-running process cannot hold a
  // stale answer. Unused today.
  _now: Date = new Date(),
): Promise<CoTeacherSuggestion[]> {
  const mine = normalizeEmail(teacherEmail);
  if (!mine) return [];

  const self = alias(roster_section_teachers, "self");
  const other = alias(roster_section_teachers, "other");

  const rows = await db
    .select({
      other_email: other.teacher_email,
      course_name: roster_sections.course_name,
      period_expression: roster_sections.period_expression,
    })
    .from(self)
    .innerJoin(roster_sections, eq(roster_sections.ps_id, self.section_ps_id))
    .innerJoin(
      other,
      and(
        eq(other.section_ps_id, self.section_ps_id),
        ne(other.teacher_ps_id, self.teacher_ps_id),
      ),
    )
    .where(
      and(
        eq(self.teacher_email, mine),
        eq(roster_sections.is_active, true),
        teacherAssignmentIsCurrentOn(self),
        teacherAssignmentIsCurrentOn(other),
        ne(lowerRole(self.role_name), STUDENT_TEACHER),
        ne(lowerRole(other.role_name), STUDENT_TEACHER),
        sql`(
          ${lowerRole(other.role_name)} = ${CO_TEACHER}
          or (${lowerRole(self.role_name)} = ${CO_TEACHER} and ${lowerRole(other.role_name)} = ${LEAD_TEACHER})
        )`,
      ),
    );

  const byEmail = new Map<string, CoTeachSection[]>();
  for (const row of rows) {
    const email = normalizeEmail(row.other_email);
    if (!email || email === mine) continue; // a shared teacher_email is a data problem, not a suggestion
    const list = byEmail.get(email) ?? [];
    const section = { course_name: row.course_name, period_expression: row.period_expression };
    if (!list.some((s) => s.course_name === section.course_name && s.period_expression === section.period_expression)) {
      list.push(section);
    }
    byEmail.set(email, list);
  }

  return [...byEmail.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([email, sections]) => ({
      email,
      sections: sections.sort(
        (a, b) =>
          a.course_name.localeCompare(b.course_name) ||
          a.period_expression.localeCompare(b.period_expression),
      ),
    }));
}
