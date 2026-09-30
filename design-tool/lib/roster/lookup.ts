/**
 * Student lookup (roadmap U-11's operator half, 2026-09-30): answers "why
 * can't this student get in?" with the app's OWN resolution rules, so the
 * answer cannot drift from what the join routes decide.
 *
 * Input is the student's Google address or their student number (`ps_id`).
 * Output is facts about the roster and the open sittings, never a name and
 * never a stored address: the result is printed by a one-off ECS task whose
 * stdout lands in CloudWatch, and lib/log.ts's redaction contract applies
 * there too. An address shows up only as its domain and whether it looks
 * like a student address.
 */
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import {
  roster_enrollments,
  roster_section_teachers,
  roster_sections,
  roster_students,
  test_sessions,
} from "@/db/schema";
import { isAdmittedToSitting } from "@/lib/api/resolveStudent";
import { normalizeEmail } from "./queries";

type Db = ReturnType<typeof getDb>;

export const STUDENT_EMAIL_DOMAIN = "edtools.psd401.net";

export type LookupQuery = { email: string } | { psId: string };

/** What the join routes would answer for this address, before any sitting. */
export type LookupVerdict =
  | "ok"
  | "no_email"
  | "not_on_roster"
  | "identity_conflict";

export interface LookupStudent {
  ps_id: string;
  is_active: boolean;
  enroll_status: number;
  /** Domain of the stored address, or null when the row has none. */
  email_domain: string | null;
  /** The stored address is lowercase, trimmed and on the student domain. */
  email_is_student_shape: boolean;
  /** Only for an email query: the stored address equals the one asked about. */
  email_matches_query?: boolean;
}

export interface LookupEnrollment {
  section_ps_id: string;
  course_name: string;
  period: string;
  section_active: boolean;
  dateenrolled: string;
  dateleft: string;
  /** The app's enrollmentIsCurrent: active and dateenrolled <= today < dateleft. */
  enrollment_current: boolean;
  teachers: Array<{ email: string | null; role: string; current: boolean }>;
}

export interface LookupSitting {
  code: string;
  owner_email: string | null;
  scope: "section" | "sections" | "students" | "practice";
  section_ps_id: string | null;
  admitted: boolean;
}

export interface LookupResult {
  /** The resolution the join routes would reach, for an email query. For a
   * student-number query, the verdict the student's STORED address would get. */
  verdict: LookupVerdict;
  /** Active roster rows carrying the address (2+ = identity_conflict). */
  active_rows_with_email: number;
  students: LookupStudent[];
  /** Enrollments of the resolved student (every row, current or not). */
  enrollments: LookupEnrollment[];
  /** Open, unexpired sittings that either admit the student or are owned by
   * one of the teachers of the student's sections. */
  sittings: LookupSitting[];
  /** The UTC date the app's date rules compare against. */
  as_of: string;
}

function isStudentShape(email: string | null): boolean {
  if (!email) return false;
  return email === email.trim().toLowerCase() && email.endsWith(`@${STUDENT_EMAIL_DOMAIN}`);
}

function domainOf(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : null;
}

function scopeOf(s: typeof test_sessions.$inferSelect): LookupSitting["scope"] {
  if (s.kind === "practice") return "practice";
  if (s.student_ps_ids !== null) return "students";
  return s.section_ps_id !== null ? "section" : "sections";
}

export async function lookupStudent(db: Db, query: LookupQuery): Promise<LookupResult> {
  // Same clock as the app's date rules (Postgres current_date, UTC).
  const [clock] = (await db.execute(
    sql`select current_date::text as today`,
  )) as unknown as Array<{ today: string }>;
  const today = clock!.today;

  const queryEmail = "email" in query ? normalizeEmail(query.email) : null;

  let rows: Array<typeof roster_students.$inferSelect>;
  if ("email" in query) {
    rows = queryEmail
      ? await db.select().from(roster_students).where(eq(roster_students.email, queryEmail))
      : [];
  } else {
    rows = await db.select().from(roster_students).where(eq(roster_students.ps_id, query.psId.trim()));
  }

  // The address the verdict is about: the query's, or the stored one.
  const verdictEmail = queryEmail ?? normalizeEmail(rows[0]?.email);
  const active = verdictEmail
    ? await db
        .select()
        .from(roster_students)
        .where(and(eq(roster_students.is_active, true), eq(roster_students.email, verdictEmail)))
    : [];

  const verdict: LookupVerdict = !verdictEmail
    ? "no_email"
    : active.length === 0
      ? "not_on_roster"
      : active.length > 1
        ? "identity_conflict"
        : "ok";

  const students: LookupStudent[] = rows.map((r) => ({
    ps_id: r.ps_id,
    is_active: r.is_active,
    enroll_status: r.enroll_status,
    email_domain: domainOf(r.email),
    email_is_student_shape: isStudentShape(r.email),
    ...(queryEmail ? { email_matches_query: normalizeEmail(r.email) === queryEmail } : {}),
  }));

  // Enrollments and sittings only make sense for exactly one student.
  const subject = verdict === "ok" ? active[0]! : rows.length === 1 ? rows[0]! : null;
  if (!subject) {
    return { verdict, active_rows_with_email: active.length, students, enrollments: [], sittings: [], as_of: today };
  }

  const enrolRows = await db
    .select({ enrollment: roster_enrollments, section: roster_sections })
    .from(roster_enrollments)
    .innerJoin(roster_sections, eq(roster_sections.ps_id, roster_enrollments.section_ps_id))
    .where(eq(roster_enrollments.student_ps_id, subject.ps_id));

  const sectionIds = [...new Set(enrolRows.map((r) => r.section.ps_id))];
  const teacherRows = sectionIds.length
    ? await db
        .select()
        .from(roster_section_teachers)
        .where(inArray(roster_section_teachers.section_ps_id, sectionIds))
    : [];

  const enrollments: LookupEnrollment[] = enrolRows
    .map(({ enrollment: e, section: s }) => ({
      section_ps_id: s.ps_id,
      course_name: s.course_name,
      period: s.period_expression,
      section_active: s.is_active,
      dateenrolled: String(e.dateenrolled),
      dateleft: String(e.dateleft),
      enrollment_current:
        e.is_active && String(e.dateenrolled) <= today && String(e.dateleft) > today,
      teachers: teacherRows
        .filter((t) => t.section_ps_id === s.ps_id)
        .map((t) => ({
          email: t.teacher_email,
          role: t.role_name,
          current: t.is_active && String(t.start_date) <= today && String(t.end_date) >= today,
        })),
    }))
    .sort((a, b) => a.section_ps_id.localeCompare(b.section_ps_id));

  const teacherEmails = new Set(
    teacherRows.map((t) => normalizeEmail(t.teacher_email)).filter((e): e is string => e !== null),
  );
  const open = await db
    .select()
    .from(test_sessions)
    .where(and(eq(test_sessions.status, "open"), gt(test_sessions.expires_at, new Date())));

  const sittings: LookupSitting[] = [];
  for (const s of open) {
    const admitted = await isAdmittedToSitting(db, subject, s);
    const relevant = admitted || teacherEmails.has(normalizeEmail(s.owner_email) ?? "");
    if (!relevant || s.kind === "practice") continue;
    sittings.push({
      code: s.code,
      owner_email: s.owner_email,
      scope: scopeOf(s),
      section_ps_id: s.section_ps_id,
      admitted,
    });
  }

  return { verdict, active_rows_with_email: active.length, students, enrollments, sittings, as_of: today };
}
