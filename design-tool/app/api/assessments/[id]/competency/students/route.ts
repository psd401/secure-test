import { NextResponse } from "next/server";
import { and, asc, eq, ilike, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { roster_students } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { authorizeCompetency } from "@/lib/competency/assignments";
import { studentDisplayName } from "@/lib/roster/teacherRoster";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const MAX_RESULTS = 20;

/** `%`, `_` and `\` are LIKE syntax; a name that contains one matches literally. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Find a student to assign (docs/competency-assessment-design.md, slice 2).
 * Assessment staff are nobody's teacher, so /api/roster/students (the
 * caller's own sections) cannot serve them: this searches the active district
 * roster by name, at most 20 rows, behind the same gate as the assignments
 * themselves. `?q=` under two characters returns nothing.
 */
export async function GET(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const access = await authorizeCompetency(db, auth.session, id, "read");
  if (!access.ok) return access.response;

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 80);
  if (q.length < 2) return NextResponse.json({ students: [] });

  // "Last, First" or "First Last" both work: every word must match a name.
  const words = q.split(/[\s,]+/).filter(Boolean).slice(0, 3);
  const rows = await db
    .select()
    .from(roster_students)
    .where(
      and(
        eq(roster_students.is_active, true),
        ...words.map((w) => {
          const pattern = `${likeEscape(w)}%`;
          return or(ilike(roster_students.first_name, pattern), ilike(roster_students.last_name, pattern));
        }),
      ),
    )
    .orderBy(asc(roster_students.last_name), asc(roster_students.first_name))
    .limit(MAX_RESULTS);

  return NextResponse.json({
    students: rows.map((s) => ({
      ps_id: s.ps_id,
      name: studentDisplayName(s),
      grade: s.grade,
      school_id: s.school_id,
    })),
  });
}
