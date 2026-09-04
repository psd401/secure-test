import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, item_sets, items } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { requireDraft } from "@/lib/api/requireDraft";
import { loadOwnedAssessment } from "@/lib/api/loadOwned";
import {
  CreateItemSetBody,
  isContiguousRun,
  loadItemSetsInOrder,
  loadSetMembers,
} from "@/lib/api/itemSets";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// E5 slice 1: the item sets of an assessment, in assessment order.
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
  return NextResponse.json({ item_sets: await loadItemSetsInOrder(id) });
}

// Create a set from one or more items that sit next to each other and belong
// to no other set. Draft-only, like every item write (James 2026-09-01: the
// stimulus is locked after publish, same as a stem).
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  let body;
  try {
    body = CreateItemSetBody.parse(await req.json());
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

  const wanted = new Set(body.item_ids);
  const members = await loadSetMembers(id);
  const chosen = members.filter((m) => wanted.has(m.id));
  if (chosen.length !== wanted.size) {
    return NextResponse.json(
      { ok: false, error: "unknown_item_id" },
      { status: 400 },
    );
  }
  const taken = chosen.find((m) => m.item_set_id !== null);
  if (taken) {
    return NextResponse.json(
      { ok: false, error: "item_already_in_set", item_id: taken.id, item_set_id: taken.item_set_id },
      { status: 409 },
    );
  }
  if (!isContiguousRun(chosen.map((m) => m.position))) {
    return NextResponse.json(
      {
        ok: false,
        error: "items_not_contiguous",
        hint: "A stimulus applies to questions that sit next to each other. Reorder them first.",
      },
      { status: 400 },
    );
  }

  const db = getDb();
  const created = await db.transaction(async (tx) => {
    const [set] = await tx
      .insert(item_sets)
      .values({
        assessment_id: id,
        stimulus_text: body.stimulus_text ?? "",
        layout: body.layout ?? "inline",
      })
      .returning();
    await tx
      .update(items)
      .set({ item_set_id: set!.id, updated_at: new Date() })
      .where(inArray(items.id, [...wanted]));
    await tx
      .update(assessments)
      .set({ updated_at: new Date() })
      .where(eq(assessments.id, id));
    return set!;
  });
  const item_ids = chosen
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((m) => m.id);
  return NextResponse.json({ item_set: created, item_ids }, { status: 201 });
}
