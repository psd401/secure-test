// Slice 78 (ADR 0017): the read side of the roster mirror.
//
// `is_active` on a roster row says the warehouse still reports it. Whether a
// relationship holds TODAY is a date question, answered here and nowhere
// else, so the resolver (slice 78) and the teacher's roster view (slice 79)
// cannot disagree about who is currently in a section:
//
//   teacher on section:  start_date <= today <= end_date   (PowerSchool gives
//                        a current assignment a future end_date)
//   student in section:  dateenrolled <= today < dateleft  (dateleft is the
//                        section's end date or the withdrawal date — the day
//                        they left, they are no longer in the room)
//
// Both use Postgres' current_date, so the answer is the database's calendar,
// not the app server's.

import { and, asc, eq, gt, gte, lte, sql } from "drizzle-orm";
import {
  roster_enrollments,
  roster_section_teachers,
  roster_sections,
  roster_students,
  type RosterSectionRow,
  type RosterStudentRow,
} from "@/db/schema";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

const today = sql`current_date`;

export const teacherAssignmentIsCurrent = and(
  eq(roster_section_teachers.is_active, true),
  lte(roster_section_teachers.start_date, today),
  gte(roster_section_teachers.end_date, today),
);

export const enrollmentIsCurrent = and(
  eq(roster_enrollments.is_active, true),
  lte(roster_enrollments.dateenrolled, today),
  gt(roster_enrollments.dateleft, today),
);

export function normalizeEmail(email: string | null | undefined): string | null {
  const v = (email ?? "").trim().toLowerCase();
  return v === "" ? null : v;
}

/** Every ACTIVE roster student carrying this address. More than one is a
 * warehouse data problem the caller must refuse, not pick from. */
export async function findActiveRosterStudentsByEmail(
  db: Db,
  email: string,
): Promise<RosterStudentRow[]> {
  return db
    .select()
    .from(roster_students)
    .where(
      and(eq(roster_students.is_active, true), eq(roster_students.email, email)),
    )
    .orderBy(asc(roster_students.ps_id));
}

/** The sections a teacher is currently assigned to, by their email. */
export async function sectionsCurrentlyTaughtBy(
  db: Db,
  teacherEmail: string,
): Promise<RosterSectionRow[]> {
  const rows = await db
    .selectDistinct({ section: roster_sections })
    .from(roster_section_teachers)
    .innerJoin(
      roster_sections,
      eq(roster_sections.ps_id, roster_section_teachers.section_ps_id),
    )
    .where(
      and(
        teacherAssignmentIsCurrent,
        eq(roster_section_teachers.teacher_email, teacherEmail),
        eq(roster_sections.is_active, true),
      ),
    );
  return rows
    .map((r) => r.section)
    .sort((a, b) => a.ps_id.localeCompare(b.ps_id));
}

/**
 * Is this student currently enrolled in a section this teacher currently
 * teaches? Optionally narrowed to ONE section (slice 79's "a picked
 * section"), in which case the teacher must teach that section and the
 * student must be enrolled in it.
 */
export async function studentIsInTeachersSection(
  db: Db,
  studentPsId: string,
  teacherEmail: string,
  sectionPsId: string | null = null,
): Promise<boolean> {
  const conditions = [
    teacherAssignmentIsCurrent,
    enrollmentIsCurrent,
    eq(roster_section_teachers.teacher_email, teacherEmail),
    eq(roster_enrollments.student_ps_id, studentPsId),
    eq(roster_sections.is_active, true),
  ];
  if (sectionPsId !== null) {
    conditions.push(eq(roster_sections.ps_id, sectionPsId));
  }
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(roster_section_teachers)
    .innerJoin(
      roster_sections,
      eq(roster_sections.ps_id, roster_section_teachers.section_ps_id),
    )
    .innerJoin(
      roster_enrollments,
      eq(roster_enrollments.section_ps_id, roster_sections.ps_id),
    )
    .where(and(...conditions))
    .limit(1);
  return row !== undefined;
}

export interface RosteredStudent {
  student: RosterStudentRow;
  section: RosterSectionRow;
}

/**
 * The students currently enrolled in the sections this teacher currently
 * teaches — one row per (student, section), so a student in two of the
 * teacher's sections appears twice. Slice 79's roster view groups them.
 */
export async function studentsInTeachersSections(
  db: Db,
  teacherEmail: string,
  sectionPsId: string | null = null,
): Promise<RosteredStudent[]> {
  const conditions = [
    teacherAssignmentIsCurrent,
    enrollmentIsCurrent,
    eq(roster_section_teachers.teacher_email, teacherEmail),
    eq(roster_sections.is_active, true),
    eq(roster_students.is_active, true),
  ];
  if (sectionPsId !== null) {
    conditions.push(eq(roster_sections.ps_id, sectionPsId));
  }
  const rows = await db
    .selectDistinct({ student: roster_students, section: roster_sections })
    .from(roster_section_teachers)
    .innerJoin(
      roster_sections,
      eq(roster_sections.ps_id, roster_section_teachers.section_ps_id),
    )
    .innerJoin(
      roster_enrollments,
      eq(roster_enrollments.section_ps_id, roster_sections.ps_id),
    )
    .innerJoin(
      roster_students,
      eq(roster_students.ps_id, roster_enrollments.student_ps_id),
    )
    .where(and(...conditions));
  return rows.sort(
    (a, b) =>
      a.section.ps_id.localeCompare(b.section.ps_id) ||
      a.student.last_name.localeCompare(b.student.last_name) ||
      a.student.first_name.localeCompare(b.student.first_name) ||
      a.student.ps_id.localeCompare(b.student.ps_id),
  );
}
