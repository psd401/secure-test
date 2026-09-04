import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import {
  normalizeEmail,
  sectionsCurrentlyTaughtBy,
  studentsInTeachersSections,
} from "@/lib/roster/queries";

/**
 * Slice 79: the sections the signed-in teacher currently teaches, with a
 * live head-count — what a sitting-creation UI offers as "all my sections"
 * or "one section" (POST /api/test-sessions `section_ps_id`).
 *
 * Empty, not an error, when the session has no email or the roster has
 * nothing for it: a teacher whose sections have not synced yet is a
 * support question, not a broken request.
 */
export async function GET() {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const email = normalizeEmail(auth.session.email);
  if (!email) return NextResponse.json({ sections: [] });

  const db = getDb();
  const [sections, enrolled] = await Promise.all([
    sectionsCurrentlyTaughtBy(db, email),
    studentsInTeachersSections(db, email),
  ]);
  const counts = new Map<string, number>();
  for (const { section } of enrolled) {
    counts.set(section.ps_id, (counts.get(section.ps_id) ?? 0) + 1);
  }
  return NextResponse.json({
    sections: sections.map((s) => ({
      ps_id: s.ps_id,
      course_code: s.course_code,
      course_name: s.course_name,
      period_expression: s.period_expression,
      school_id: s.school_id,
      term_id: s.term_id,
      student_count: counts.get(s.ps_id) ?? 0,
    })),
  });
}
