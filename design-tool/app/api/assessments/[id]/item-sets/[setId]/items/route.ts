import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, items } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { requireDraftStatus } from "@/lib/api/requireDraft";
import { AttachItemBody, loadOwnedItemSet, loadSetMembers } from "@/lib/api/itemSets";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string; setId: string }>;
}

// E5 slice 1: attach the question just before or just after the set's block
// ("Join the stimulus above"). Anything else would break contiguity.
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id, setId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(setId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  let body;
  try {
    body = AttachItemBody.parse(await req.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid_body";
    return NextResponse.json(
      { ok: false, error: "invalid_body", detail: message },
      { status: 400 },
    );
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
  const item = members.find((m) => m.id === body.item_id);
  if (!item) {
    return NextResponse.json({ ok: false, error: "unknown_item_id" }, { status: 400 });
  }
  if (item.item_set_id === setId) {
    return NextResponse.json({ ok: true, item_set_id: setId, already: true });
  }
  if (item.item_set_id !== null) {
    return NextResponse.json(
      { ok: false, error: "item_already_in_set", item_set_id: item.item_set_id },
      { status: 409 },
    );
  }
  const block = members.filter((m) => m.item_set_id === setId).map((m) => m.position);
  const lo = Math.min(...block);
  const hi = Math.max(...block);
  if (item.position !== lo - 1 && item.position !== hi + 1) {
    return NextResponse.json(
      {
        ok: false,
        error: "item_not_adjacent",
        hint: "Only the question just before or just after this stimulus's group can join it. Reorder first.",
      },
      { status: 409 },
    );
  }

  const db = getDb();
  await db.transaction(async (tx) => {
    await tx
      .update(items)
      .set({ item_set_id: setId, updated_at: new Date() })
      .where(eq(items.id, item.id));
    await tx
      .update(assessments)
      .set({ updated_at: new Date() })
      .where(eq(assessments.id, id));
  });
  return NextResponse.json({ ok: true, item_set_id: setId });
}
