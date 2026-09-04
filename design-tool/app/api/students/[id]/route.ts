import { NextResponse } from "next/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { students, student_accommodations } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { UpdateStudentBody } from "@/lib/api/students";
import { UUID_RE } from "@/lib/uuid";
import { loadOwnedStudent } from "@/lib/api/loadOwned";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const owned = await loadOwnedStudent(id, auth.session.sub);
  if (owned.status === 404) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (owned.status === 403) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const includeRemoved =
    new URL(req.url).searchParams.get("include_removed") === "1";
  const db = getDb();
  const accs = await db
    .select()
    .from(student_accommodations)
    .where(
      includeRemoved
        ? eq(student_accommodations.student_id, id)
        : and(
            eq(student_accommodations.student_id, id),
            isNull(student_accommodations.removed_at),
          ),
    )
    .orderBy(
      asc(student_accommodations.subject),
      asc(student_accommodations.tool_id),
    );
  return NextResponse.json({ student: owned.row, accommodations: accs });
}

export async function PATCH(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  let body;
  try {
    body = UpdateStudentBody.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const owned = await loadOwnedStudent(id, auth.session.sub);
  if (owned.status === 404) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (owned.status === 403) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const db = getDb();
  const [updated] = await db
    .update(students)
    .set({ ...body, updated_at: new Date() })
    .where(eq(students.id, id))
    .returning();
  return NextResponse.json({ student: updated });
}

export async function DELETE(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const owned = await loadOwnedStudent(id, auth.session.sub);
  if (owned.status === 404) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (owned.status === 403) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const db = getDb();
  // FK cascade drops student_accommodations rows automatically.
  await db.delete(students).where(eq(students.id, id));
  return new NextResponse(null, { status: 204 });
}
