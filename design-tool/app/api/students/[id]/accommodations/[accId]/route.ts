import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { student_accommodations } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { EditAccommodationValueBody } from "@/lib/api/students";
import { UUID_RE } from "@/lib/uuid";
import { authorizeStudent, notFoundResponse } from "@/lib/api/access";
import type { SessionPayload } from "@/lib/auth/session";

interface RouteContext {
  params: Promise<{ id: string; accId: string }>;
}

/**
 * Load one live accommodation row on a student the caller may edit.
 *
 * The join used to carry the owner comparison; `authorizeStudent` owns that
 * question now (access slice 1, D-3), so a row on someone else's student is a
 * 404 rather than the old 403.
 */
async function loadAccForSession(
  studentId: string,
  accId: string,
  session: SessionPayload,
) {
  const db = getDb();
  const access = await authorizeStudent(db, session, studentId, "own");
  if (!access.ok) return { ok: false as const, response: access.response };
  const [row] = await db
    .select()
    .from(student_accommodations)
    .where(
      and(
        eq(student_accommodations.id, accId),
        eq(student_accommodations.student_id, studentId),
        isNull(student_accommodations.removed_at),
      ),
    )
    .limit(1);
  if (!row) return { ok: false as const, response: notFoundResponse() };
  return { ok: true as const, row };
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
  const owned = await loadAccForSession(id, accId, auth.session);
  if (!owned.ok) return owned.response;

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
  const owned = await loadAccForSession(id, accId, auth.session);
  if (!owned.ok) return owned.response;
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
