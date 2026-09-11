import { NextResponse } from "next/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, items } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { requireDraft } from "@/lib/api/requireDraft";
import { CreateItemBody, itemConfigForWrite } from "@/lib/api/items";
import { rejectUnownedRubricId } from "@/lib/api/rubrics";
import { UUID_RE } from "@/lib/uuid";
import { loadOwnedAssessment } from "@/lib/api/loadOwned";
import { loadItemSetsInOrder } from "@/lib/api/itemSets";

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
  const owned = await loadOwnedAssessment(id, auth.session.sub);
  if (owned.status !== 200) {
    return NextResponse.json(
      { ok: false, error: owned.status === 404 ? "not_found" : "forbidden" },
      { status: owned.status },
    );
  }
  const db = getDb();
  const rows = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, id))
    .orderBy(asc(items.position));
  // E5 slice 1: the sets ride along so the editor loads both in one call;
  // each row carries its item_set_id.
  return NextResponse.json({ items: rows, item_sets: await loadItemSetsInOrder(id) });
}

export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  let body;
  try {
    body = CreateItemBody.parse(await req.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid_body";
    return NextResponse.json(
      { ok: false, error: "invalid_body", detail: message },
      { status: 400 },
    );
  }
  const owned = await loadOwnedAssessment(id, auth.session.sub);
  if (owned.status !== 200) {
    return NextResponse.json(
      { ok: false, error: owned.status === 404 ? "not_found" : "forbidden" },
      { status: owned.status },
    );
  }
  const draftGuard = requireDraft(owned.row);
  if (draftGuard) return draftGuard;
  // Rubric library slice 3: an item may point at a rubric in the caller's
  // OWN library only.
  const rubricGuard = await rejectUnownedRubricId(
    body.type === "essay" ? body.rubric_id : null,
    auth.session.sub,
  );
  if (rubricGuard) return rubricGuard;

  const db = getDb();
  const inserted = await db.transaction(async (tx) => {
    const [last] = await tx
      .select({ position: items.position })
      .from(items)
      .where(eq(items.assessment_id, id))
      .orderBy(desc(items.position))
      .limit(1);
    const nextPos = (last?.position ?? -1) + 1;
    const [row] = await tx
      .insert(items)
      .values({
        assessment_id: id,
        position: nextPos,
        type: body.type,
        stem: body.stem,
        choices: body.choices,
        correct_choice_ids: body.correct_choice_ids,
        correct_answer: body.correct_answer ?? null,
        config: itemConfigForWrite(body),
      })
      .returning();
    await tx
      .update(assessments)
      .set({ updated_at: new Date() })
      .where(and(eq(assessments.id, id)));
    return row;
  });

  return NextResponse.json({ item: inserted }, { status: 201 });
}
