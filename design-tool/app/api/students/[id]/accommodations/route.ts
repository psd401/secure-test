import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { students, student_accommodations } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { UpsertManualAccommodationBody } from "@/lib/api/students";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Create a manual accommodation row for a student.
// Server-enforces source='manual' so the client can't smuggle a
// tide_import / tide_then_edited origin.
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  let body;
  try {
    body = UpsertManualAccommodationBody.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const db = getDb();

  // Ownership: student must belong to this teacher.
  const [stu] = await db
    .select({ id: students.id, owner_sub: students.owner_sub })
    .from(students)
    .where(eq(students.id, id))
    .limit(1);
  if (!stu) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (stu.owner_sub !== auth.session.sub) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Conflict: a LIVE row already exists for this (student, subject, tool).
  // Soft-removed rows are intentionally NOT blocking — the partial
  // unique index allows the re-insert.
  const existing = await db
    .select()
    .from(student_accommodations)
    .where(
      and(
        eq(student_accommodations.student_id, id),
        eq(student_accommodations.subject, body.subject),
        eq(student_accommodations.tool_id, body.tool_id),
        isNull(student_accommodations.removed_at),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return NextResponse.json(
      { ok: false, error: "already_exists", id: existing[0]!.id },
      { status: 409 },
    );
  }
  const [row] = await db
    .insert(student_accommodations)
    .values({
      student_id: id,
      subject: body.subject,
      tool_id: body.tool_id,
      value: body.value,
      source: "manual",
    })
    .returning();
  return NextResponse.json({ accommodation: row }, { status: 201 });
}
