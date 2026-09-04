import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, item_sets, items } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { requireDraftStatus } from "@/lib/api/requireDraft";
import { loadOwnedItemSet, loadSetMembers } from "@/lib/api/itemSets";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string; setId: string; itemId: string }>;
}

// E5 slice 1: detach a question from its stimulus. Only an end of the block
// may leave (a middle one would split the set); when the last one leaves the
// set is deleted (James 2026-09-01: auto-delete, not a readiness gap).
export async function DELETE(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id, setId, itemId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(setId) || !UUID_RE.test(itemId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const owned = await loadOwnedItemSet(id, setId, auth.session.sub);
  if (owned.status !== 200) {
    return NextResponse.json(
      { ok: false, error: owned.status === 404 ? "not_found" : "forbidden" },
      { status: owned.status },
    );
  }
  const lock = requireDraftStatus(owned.parentStatus);
  if (lock) return lock;

  const members = await loadSetMembers(id);
  const block = members.filter((m) => m.item_set_id === setId);
  const item = block.find((m) => m.id === itemId);
  if (!item) {
    return NextResponse.json({ ok: false, error: "item_not_in_set" }, { status: 404 });
  }
  const lo = Math.min(...block.map((m) => m.position));
  const hi = Math.max(...block.map((m) => m.position));
  if (block.length > 1 && item.position !== lo && item.position !== hi) {
    return NextResponse.json(
      {
        ok: false,
        error: "would_split_set",
        hint: "Detach the first or last question of the group, or reorder first.",
      },
      { status: 409 },
    );
  }

  const db = getDb();
  const setDeleted = block.length === 1;
  await db.transaction(async (tx) => {
    await tx
      .update(items)
      .set({ item_set_id: null, updated_at: new Date() })
      .where(eq(items.id, itemId));
    if (setDeleted) await tx.delete(item_sets).where(eq(item_sets.id, setId));
    await tx
      .update(assessments)
      .set({ updated_at: new Date() })
      .where(eq(assessments.id, id));
  });
  return NextResponse.json({ ok: true, item_set_deleted: setDeleted });
}
