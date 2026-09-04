import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { students, student_accommodations } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { EditAccommodationValueBody } from "@/lib/api/students";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string; accId: string }>;
}

async function loadOwnedAcc(studentId: string, accId: string, ownerSub: string) {
  const db = getDb();
  const [joined] = await db
    .select({
      acc: student_accommodations,
      owner_sub: students.owner_sub,
      student_id: students.id,
    })
    .from(student_accommodations)
    .innerJoin(students, eq(student_accommodations.student_id, students.id))
    .where(
      and(
        eq(student_accommodations.id, accId),
        eq(students.id, studentId),
        isNull(student_accommodations.removed_at),
      ),
    )
    .limit(1);
  if (!joined) return { status: 404 as const };
  if (joined.owner_sub !== ownerSub) return { status: 403 as const };
  return { status: 200 as const, row: joined.acc };
}

export async function PATCH(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id, accId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(accId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  let body;
  try {
    body = EditAccommodationValueBody.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const owned = await loadOwnedAcc(id, accId, auth.session.sub);
  if (owned.status === 404) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (owned.status === 403) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // No-op when value is unchanged — keeps edited_at stable so the next
  // TIDE import doesn't see a phantom edit.
  if (owned.row.value === body.value) {
    return NextResponse.json({ accommodation: owned.row });
  }

  // Source transition rule (locked): a tide_import row becomes
  // tide_then_edited when (and only when) the value changes. Already-
  // edited or manual rows keep their source.
  const nextSource =
    owned.row.source === "tide_import" ? "tide_then_edited" : owned.row.source;

  const db = getDb();
  const [updated] = await db
    .update(student_accommodations)
    .set({
      value: body.value,
      source: nextSource,
      edited_at: new Date(),
      // UX pass 2 slice 5 (P2-5): a new edit supersedes any Keep-mine
      // decision; the next import judges the fresh value on its own.
      kept_against_tide_code: null,
    })
    .where(eq(student_accommodations.id, accId))
    .returning();
  return NextResponse.json({ accommodation: updated });
}

export async function DELETE(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id, accId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(accId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const owned = await loadOwnedAcc(id, accId, auth.session.sub);
  if (owned.status === 404) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (owned.status === 403) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  // Tide-origin rows can't be hard-deleted directly. Re-import is the
  // only path that removes them (via soft-delete). Manual rows can be
  // hard-deleted since they have no audit-trail value attached to TIDE.
  if (owned.row.source !== "manual") {
    return NextResponse.json(
      {
        ok: false,
        error: "tide_row_not_deletable",
        hint: "TIDE-origin rows are soft-removed on next import where they're absent. Re-import is the canonical path.",
      },
      { status: 409 },
    );
  }
  const db = getDb();
  await db
    .delete(student_accommodations)
    .where(eq(student_accommodations.id, accId));
  return new NextResponse(null, { status: 204 });
}
