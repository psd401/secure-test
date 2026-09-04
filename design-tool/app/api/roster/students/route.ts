import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { normalizeEmail, studentsInTeachersSections } from "@/lib/roster/queries";
import { sectionLabel, studentDisplayName } from "@/lib/roster/teacherRoster";

/**
 * Slice 82: the students the signed-in teacher currently teaches, one row per
 * student with the sections they share — what a sitting-creation UI offers
 * when the teacher picks an explicit list (POST /api/test-sessions
 * `student_ps_ids`). `?section_ps_id=` narrows to one section.
 *
 * Same posture as /api/roster/sections: empty, not an error, when the session
 * has no email or the roster has nothing for it.
 */
export async function GET(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const email = normalizeEmail(auth.session.email);
  if (!email) return NextResponse.json({ students: [] });

  const sectionPsId = new URL(req.url).searchParams.get("section_ps_id");
  const rows = await studentsInTeachersSections(getDb(), email, sectionPsId || null);

  const byPsId = new Map<
    string,
    { ps_id: string; name: string; grade: string | null; sections: { ps_id: string; label: string }[] }
  >();
  for (const { student, section } of rows) {
    const entry = byPsId.get(student.ps_id) ?? {
      ps_id: student.ps_id,
      name: studentDisplayName(student),
      grade: student.grade,
      sections: [],
    };
    entry.sections.push({ ps_id: section.ps_id, label: sectionLabel(section) });
    byPsId.set(student.ps_id, entry);
  }
  const students = [...byPsId.values()].sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ students });
}
