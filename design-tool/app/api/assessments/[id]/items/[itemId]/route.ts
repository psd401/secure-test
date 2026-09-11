import { NextResponse } from "next/server";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, item_sets, items, responses } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { isAnswerKeyOnlyPatch, requireDraftStatus } from "@/lib/api/requireDraft";
import { UpdateItemBody, itemConfigForWrite } from "@/lib/api/items";
import { rejectUnownedRubricId } from "@/lib/api/rubrics";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string; itemId: string }>;
}

async function loadOwnedItem(
  assessmentId: string,
  itemId: string,
  ownerSub: string,
) {
  const db = getDb();
  const [row] = await db
    .select({
      item: items,
      owner: assessments.owner_sub,
      parentStatus: assessments.status,
    })
    .from(items)
    .innerJoin(assessments, eq(assessments.id, items.assessment_id))
    .where(and(eq(items.id, itemId), eq(items.assessment_id, assessmentId)))
    .limit(1);
  if (!row) return { status: 404 as const };
  if (row.owner !== ownerSub) return { status: 403 as const };
  return {
    status: 200 as const,
    item: row.item,
    parentStatus: row.parentStatus,
  };
}

export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id, itemId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(itemId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const owned = await loadOwnedItem(id, itemId, auth.session.sub);
  if (owned.status !== 200) {
    return NextResponse.json(
      { ok: false, error: owned.status === 404 ? "not_found" : "forbidden" },
      { status: owned.status },
    );
  }
  return NextResponse.json({ item: owned.item });
}

export async function PATCH(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id, itemId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(itemId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  let body;
  try {
    body = UpdateItemBody.parse(await req.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid_body";
    return NextResponse.json(
      { ok: false, error: "invalid_body", detail: message },
      { status: 400 },
    );
  }
  const owned = await loadOwnedItem(id, itemId, auth.session.sub);
  if (owned.status !== 200) {
    return NextResponse.json(
      { ok: false, error: owned.status === 404 ? "not_found" : "forbidden" },
      { status: owned.status },
    );
  }
  if (body.type !== owned.item.type) {
    return NextResponse.json(
      { ok: false, error: "type_change_not_supported" },
      { status: 400 },
    );
  }
  // Publish lock (slice 19) with one door: answer-key-only edits
  // (2026-09-01, see isAnswerKeyOnlyPatch). Everything else still 409s.
  if (owned.parentStatus !== "draft" && !isAnswerKeyOnlyPatch(body, owned.item)) {
    return NextResponse.json(
      {
        ok: false,
        error: "assessment_published_editing_locked",
        hint:
          "While published, only the answer key (correct choice, correct answer, " +
          "hotspot region) can change. Set status: 'draft' on the parent " +
          "assessment for other edits.",
      },
      { status: 409 },
    );
  }

  // Rubric library slice 3: an item may point at a rubric in the caller's
  // OWN library only.
  const rubricGuard = await rejectUnownedRubricId(
    body.type === "essay" ? body.rubric_id : null,
    auth.session.sub,
  );
  if (rubricGuard) return rubricGuard;

  const db = getDb();
  const [updated] = await db
    .update(items)
    .set({
      stem: body.stem,
      choices: body.choices,
      correct_choice_ids: body.correct_choice_ids,
      correct_answer: body.correct_answer ?? null,
      config: itemConfigForWrite(body, owned.item.config),
      updated_at: new Date(),
    })
    .where(eq(items.id, itemId))
    .returning();
  await db
    .update(assessments)
    .set({ updated_at: new Date() })
    .where(eq(assessments.id, id));
  return NextResponse.json({ item: updated });
}

export async function DELETE(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id, itemId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(itemId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const owned = await loadOwnedItem(id, itemId, auth.session.sub);
  if (owned.status !== 200) {
    return NextResponse.json(
      { ok: false, error: owned.status === 404 ? "not_found" : "forbidden" },
      { status: owned.status },
    );
  }
  const lock = requireDraftStatus(owned.parentStatus);
  if (lock) return lock;
  const db = getDb();
  // Review fix (2026-08-14): responses.item_id and scores.response_id
  // cascade on delete — deleting an item that students have answered would
  // silently destroy their responses AND final scores (and the app's own
  // 409 hint steers teachers into published→draft→delete). Block it.
  const [respCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(responses)
    .where(eq(responses.item_id, itemId));
  if ((respCount?.n ?? 0) > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "has_responses",
        hint:
          "Students have responded to this item; deleting it would destroy " +
          "their responses and scores, so deletion is blocked.",
      },
      { status: 409 },
    );
  }
  const removedPosition = owned.item.position;
  const setId = owned.item.item_set_id;
  await db.transaction(async (tx) => {
    await tx.delete(items).where(eq(items.id, itemId));
    // E5 slice 1: a set whose last question is gone is deleted with it
    // (James 2026-09-01: auto-delete, not a readiness gap). Removing a
    // middle question keeps the block contiguous — positions collapse below.
    if (setId) {
      const [left] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(items)
        .where(eq(items.item_set_id, setId));
      if ((left?.n ?? 0) === 0) await tx.delete(item_sets).where(eq(item_sets.id, setId));
    }
    // Collapse positions above the removed one so they remain contiguous.
    await tx
      .update(items)
      .set({ position: sql`${items.position} - 1` })
      .where(
        and(eq(items.assessment_id, id), gt(items.position, removedPosition)),
      );
    await tx
      .update(assessments)
      .set({ updated_at: new Date() })
      .where(eq(assessments.id, id));
  });
  return new NextResponse(null, { status: 204 });
}
