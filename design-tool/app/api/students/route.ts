import { NextResponse } from "next/server";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { students, student_accommodations } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { CreateStudentBody } from "@/lib/api/students";

export async function GET() {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const db = getDb();
  // List the teacher's roster with a per-student live-accommodation
  // count. Soft-removed rows are excluded.
  const rows = await db
    .select({
      id: students.id,
      ssid: students.ssid,
      name: students.name,
      grade: students.grade,
      school: students.school,
      accommodation_count: sql<number>`coalesce(count(${student_accommodations.id}) filter (where ${student_accommodations.removed_at} is null), 0)::int`.as(
        "accommodation_count",
      ),
    })
    .from(students)
    .leftJoin(
      student_accommodations,
      eq(student_accommodations.student_id, students.id),
    )
    .where(eq(students.owner_sub, auth.session.sub))
    .groupBy(students.id)
    .orderBy(asc(students.ssid));
  return NextResponse.json({ students: rows });
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  let body;
  try {
    body = CreateStudentBody.parse(await req.json());
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_body" },
      { status: 400 },
    );
  }
  const db = getDb();
  // Reject duplicates explicitly so the client can distinguish "already
  // exists" from a generic 500. The unique index on (owner_sub, ssid)
  // would 23505 otherwise.
  const existing = await db
    .select({ id: students.id })
    .from(students)
    .where(
      and(
        eq(students.owner_sub, auth.session.sub),
        eq(students.ssid, body.ssid),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return NextResponse.json(
      { ok: false, error: "ssid_already_exists", id: existing[0]!.id },
      { status: 409 },
    );
  }
  const [row] = await db
    .insert(students)
    .values({
      owner_sub: auth.session.sub,
      ssid: body.ssid,
      name: body.name ?? "",
      grade: body.grade ?? null,
      school: body.school ?? null,
    })
    .returning();
  return NextResponse.json({ student: row }, { status: 201 });
}
