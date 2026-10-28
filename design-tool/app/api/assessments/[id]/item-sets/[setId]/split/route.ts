import { NextResponse } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { assessments, item_sets, items } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { requireDraftStatus } from "@/lib/api/requireDraft";
import { loadItemSetForSession } from "@/lib/api/itemSets";
import { JSON_BODY_LIMITS, readJsonBody } from "@/lib/api/jsonBody";
import { isPageGroup } from "@/lib/authoring/pageGroup";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string; setId: string }>;
}

const SplitBody = z.object({ item_id: z.string().regex(UUID_RE) }).strict();

// Page groups (2026-10-28, James: "an atomic split route"): "Start a new page
// here" on a question inside a page group. The questions from `item_id` on
// leave the group in one transaction: two or more of them form a new group,
// one is freed; a head left with one question is freed and the group
// deleted. Only a page group splits — a stimulus set would need its text in
// two places, so its questions leave one end at a time (DELETE .../items).
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id, setId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(setId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const bodyRead = await readJsonBody(req, JSON_BODY_LIMITS.default);
  if (!bodyRead.ok) return bodyRead.response;
  let raw: unknown;
  try {
    raw = bodyRead.parse();
  } catch {
    raw = null;
  }
  const parsed = SplitBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const owned = await loadItemSetForSession(id, setId, auth.session, "own");
  if (!owned.ok) return owned.response;
  const lock = requireDraftStatus(owned.parentStatus);
  if (lock) return lock;

  // PR #146 review: the set row is locked and its members read INSIDE the
  // transaction, so two splits of one group cannot plan from the same
  // membership (the second waits, then sees what the first left).
  const db = getDb();
  type Refusal = { status: number; body: Record<string, unknown> };
  const result = await db.transaction(async (tx): Promise<Refusal | { head_set_id: string | null; tail_set_id: string | null }> => {
    const [set] = await tx.select().from(item_sets).where(eq(item_sets.id, setId)).for("update");
    if (!set) return { status: 404, body: { ok: false, error: "not_found" } };
    const block = await tx
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.assessment_id, id), eq(items.item_set_id, setId)))
      .orderBy(asc(items.position));
    const at = block.findIndex((m) => m.id === parsed.data.item_id);
    if (at < 0) return { status: 404, body: { ok: false, error: "item_not_in_set" } };
    if (!isPageGroup(set, block.length)) {
      return {
        status: 409,
        body: {
          ok: false,
          error: "not_a_page_group",
          hint: "Only questions kept on one page can be split. Take questions out of a stimulus from its first or last question.",
        },
      };
    }
    if (at === 0) {
      return { status: 409, body: { ok: false, error: "already_first", hint: "This question already starts the page." } };
    }
    const head = block.slice(0, at).map((m) => m.id);
    const tail = block.slice(at).map((m) => m.id);
    const now = new Date();
    let tailSetId: string | null = null;
    if (tail.length >= 2) {
      const [created] = await tx
        .insert(item_sets)
        .values({ assessment_id: id, stimulus_text: "", sources: [], layout: "inline" })
        .returning({ id: item_sets.id });
      tailSetId = created!.id;
    }
    await tx.update(items).set({ item_set_id: tailSetId, updated_at: now }).where(inArray(items.id, tail));
    const headKept = head.length >= 2;
    if (!headKept) {
      await tx.update(items).set({ item_set_id: null, updated_at: now }).where(inArray(items.id, head));
      await tx.delete(item_sets).where(eq(item_sets.id, setId));
    }
    await tx.update(assessments).set({ updated_at: now }).where(eq(assessments.id, id));
    return { head_set_id: headKept ? setId : null, tail_set_id: tailSetId };
  });
  if ("status" in result) return NextResponse.json(result.body, { status: result.status });
  return NextResponse.json({ ok: true, ...result });
}
