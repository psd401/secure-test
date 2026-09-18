import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, items, rubrics } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { UpdateRubricBody } from "@/lib/api/rubrics";
import { UUID_RE } from "@/lib/uuid";
import { authorizeRubric } from "@/lib/api/access";

// Rubric library slice 3 (D-4). Another teacher's rubric is 404 rather than
// 403 — a rubric library is a private shelf and its row ids are not addresses
// anyone else should be able to confirm. Access slice 1 made that posture the
// rule everywhere (`authorizeRubric`, D-3); this surface had it first.

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const access = await authorizeRubric(getDb(), auth.session, id, "own");
  if (!access.ok) return access.response;
  const row = access.rubric;
  return NextResponse.json({ rubric: row });
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
    body = UpdateRubricBody.parse(await req.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid_body";
    return NextResponse.json(
      { ok: false, error: "invalid_body", detail: message },
      { status: 400 },
    );
  }
  const access = await authorizeRubric(getDb(), auth.session, id, "own");
  if (!access.ok) return access.response;
  const db = getDb();
  // Editing the library row deliberately does NOT touch any item that was
  // copied from it (copy-on-apply, D-4): the items keep their own copies and
  // their rubric_id, and nothing is rescored behind a teacher's back.
  const [updated] = await db
    .update(rubrics)
    .set({
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.rubric !== undefined ? { rubric: body.rubric } : {}),
      updated_at: new Date(),
    })
    .where(eq(rubrics.id, id))
    .returning();
  return NextResponse.json({ rubric: updated });
}

export async function DELETE(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const access = await authorizeRubric(getDb(), auth.session, id, "own");
  if (!access.ok) return access.response;
  const db = getDb();
  await db.transaction(async (tx) => {
    // Detach, never edit: an item that was copied from this rubric keeps its
    // `config.rubric` exactly as it is (the copy IS the item's rubric and
    // students may already have been scored against it) and loses only the
    // provenance pointer. Scoped to the owner's own items — rubric_id is
    // only ever written from an owned rubric, and the join keeps it true.
    await tx
      .update(items)
      .set({ config: sql`${items.config} - 'rubric_id'`, updated_at: new Date() })
      .where(
        and(
          sql`${items.config} ->> 'rubric_id' = ${id}`,
          // A list scope, not an ownership check: the detach touches only the
          // caller's own items. Access slice 2 widens the visible set here.
          sql`${items.assessment_id} in (select ${assessments.id} from ${assessments} where ${assessments.owner_sub} = ${auth.session.sub})`,
        ),
      );
    await tx.delete(rubrics).where(eq(rubrics.id, id));
  });
  return new NextResponse(null, { status: 204 });
}
