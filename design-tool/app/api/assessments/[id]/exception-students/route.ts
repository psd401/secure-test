import { NextResponse } from "next/server";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { student_accommodations, students } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { authorizeAssessment } from "@/lib/api/access";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * U-17 slice 2 (F-1, 13.5): the students an exception can be added for on
 * this test — the ASSESSMENT OWNER's records, plus, for a co-teacher, their
 * own records for children the owner has no record of yet (the overrides
 * route maps such a row to the owner's, creating it). Same shape as
 * `GET /api/students`, which the Exceptions tab used to read — that listed
 * only the CALLER's rows, so a co-teacher's exceptions landed where delivery
 * never looked.
 */
export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "edit");
  if (!access.ok) return access.response;
  const ownerSub = access.assessment.owner_sub;

  const listFor = (sub: string) =>
    db
      .select({
        id: students.id,
        ssid: students.ssid,
        roster_ps_id: students.roster_ps_id,
        name: students.name,
        grade: students.grade,
        school: students.school,
        accommodation_count: sql<number>`coalesce(count(${student_accommodations.id}) filter (where ${student_accommodations.removed_at} is null), 0)::int`.as(
          "accommodation_count",
        ),
      })
      .from(students)
      .leftJoin(student_accommodations, eq(student_accommodations.student_id, students.id))
      .where(and(eq(students.owner_sub, sub), isNull(students.practice_for_sub)))
      .groupBy(students.id)
      .orderBy(asc(students.ssid));

  const owners = await listFor(ownerSub);
  if (auth.session.sub === ownerSub) {
    return NextResponse.json({ students: owners.map(({ roster_ps_id: _r, ...s }) => s) });
  }
  const ownerPs = new Set(owners.map((s) => s.roster_ps_id).filter(Boolean));
  const ownerSsid = new Set(owners.map((s) => s.ssid).filter(Boolean));
  const mine = (await listFor(auth.session.sub)).filter(
    (s) => !(s.roster_ps_id && ownerPs.has(s.roster_ps_id)) && !(s.ssid && ownerSsid.has(s.ssid)),
  );
  return NextResponse.json({
    students: [...owners, ...mine].map(({ roster_ps_id: _r, ...s }) => s),
  });
}
