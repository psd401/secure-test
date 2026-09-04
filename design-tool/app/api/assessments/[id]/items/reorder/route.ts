import { NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, items } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { requireDraft } from "@/lib/api/requireDraft";
import { ReorderBody } from "@/lib/api/items";
import { splitSetInOrder } from "@/lib/api/itemSets";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const POSITION_OFFSET = 1_000_000;

export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  let body;
  try {
    body = ReorderBody.parse(await req.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid_body";
    return NextResponse.json(
      { ok: false, error: "invalid_body", detail: message },
      { status: 400 },
    );
  }
  const db = getDb();
  const [assessmentRow] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, id))
    .limit(1);
  if (!assessmentRow) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (assessmentRow.owner_sub !== auth.session.sub) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const draftGuard = requireDraft(assessmentRow);
  if (draftGuard) return draftGuard;

  // Validate that ordered_ids matches the assessment's items exactly (same
  // set, same length). This prevents accidental data loss from a stale
  // client.
  const existing = await db
    .select({ id: items.id, item_set_id: items.item_set_id })
    .from(items)
    .where(eq(items.assessment_id, id));
  const existingIds = new Set(existing.map((r) => r.id));
  if (existing.length !== body.ordered_ids.length) {
    return NextResponse.json(
      { ok: false, error: "ordered_ids_length_mismatch" },
      { status: 400 },
    );
  }
  for (const orderedId of body.ordered_ids) {
    if (!existingIds.has(orderedId)) {
      return NextResponse.json(
        { ok: false, error: "ordered_ids_contains_unknown" },
        { status: 400 },
      );
    }
  }
  // E5 slice 1: a set's items must stay one block — the set sits where its
  // first item sits, and the client, preview and delivery all order by
  // item position. Refuse rather than silently regroup.
  const split = splitSetInOrder(
    body.ordered_ids,
    new Map(existing.map((r) => [r.id, r.item_set_id])),
  );
  if (split) {
    return NextResponse.json(
      {
        ok: false,
        error: "reorder_would_split_set",
        item_set_id: split,
        hint: "Questions that share a stimulus move together. Detach one first to move it on its own.",
      },
      { status: 400 },
    );
  }

  await db.transaction(async (tx) => {
    // Two-pass write to dodge the unique (assessment_id, position)
    // constraint mid-shuffle: bump every item out of the contended range,
    // then write the final positions.
    await tx
      .update(items)
      .set({ position: sql`${items.position} + ${POSITION_OFFSET}` })
      .where(
        and(
          eq(items.assessment_id, id),
          inArray(items.id, body.ordered_ids),
        ),
      );
    for (let i = 0; i < body.ordered_ids.length; i++) {
      const itemId = body.ordered_ids[i]!;
      await tx
        .update(items)
        .set({ position: i, updated_at: new Date() })
        .where(eq(items.id, itemId));
    }
    await tx
      .update(assessments)
      .set({ updated_at: new Date() })
      .where(eq(assessments.id, id));
  });

  return NextResponse.json({ ok: true });
}
