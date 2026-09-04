import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, item_sets } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { requireDraftStatus } from "@/lib/api/requireDraft";
import { UpdateItemSetBody, checkSourceItem, loadOwnedItemSet } from "@/lib/api/itemSets";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string; setId: string }>;
}

function bad(status: 404 | 403) {
  return NextResponse.json(
    { ok: false, error: status === 404 ? "not_found" : "forbidden" },
    { status },
  );
}

// E5 slice 1: stimulus text + layout. Locked after publish like a stem.
export async function PATCH(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id, setId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(setId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  let body;
  try {
    body = UpdateItemSetBody.parse(await req.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid_body";
    return NextResponse.json(
      { ok: false, error: "invalid_body", detail: message },
      { status: 400 },
    );
  }
  const owned = await loadOwnedItemSet(id, setId, auth.session.sub);
  if (owned.status !== 200) return bad(owned.status);
  const lock = requireDraftStatus(owned.parentStatus);
  if (lock) return lock;

  const db = getDb();
  // E12 slice 1: a source question must be the owner's, an essay or
  // short-text question, and in another assessment.
  if (typeof body.source_item_id === "string") {
    const check = await checkSourceItem(db, body.source_item_id, auth.session.sub, id);
    if (!check.ok) return NextResponse.json({ ok: false, error: check.error }, { status: check.status });
  }
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(item_sets)
      .set({
        ...(body.stimulus_text !== undefined ? { stimulus_text: body.stimulus_text } : {}),
        ...(body.layout !== undefined ? { layout: body.layout } : {}),
        ...(body.source_item_id !== undefined ? { source_item_id: body.source_item_id } : {}),
        updated_at: new Date(),
      })
      .where(eq(item_sets.id, setId))
      .returning();
    await tx
      .update(assessments)
      .set({ updated_at: new Date() })
      .where(eq(assessments.id, id));
    return row;
  });
  return NextResponse.json({ item_set: updated });
}

// Deleting a set frees its items (items.item_set_id is SET NULL on delete);
// the questions themselves stay.
export async function DELETE(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id, setId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(setId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const owned = await loadOwnedItemSet(id, setId, auth.session.sub);
  if (owned.status !== 200) return bad(owned.status);
  const lock = requireDraftStatus(owned.parentStatus);
  if (lock) return lock;

  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.delete(item_sets).where(eq(item_sets.id, setId));
    await tx
      .update(assessments)
      .set({ updated_at: new Date() })
      .where(eq(assessments.id, id));
  });
  return new NextResponse(null, { status: 204 });
}
