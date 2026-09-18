import { z } from "zod";
import type { NextResponse } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  ITEM_SET_LAYOUTS,
  assessments,
  item_sets,
  items,
  type ItemSetRow,
} from "@/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import {
  authorizeAssessment,
  notFoundResponse,
  type AccessLevel,
} from "@/lib/api/access";

// E5 slice 1 (docs/stimulus-design.md): item sets — one stimulus shared by
// one or more contiguous items. Write shapes, the contiguity rules, and the
// owner-scoped loaders the item-set routes share.

// A stimulus is a passage or a figure caption plus `![alt](asset:uuid)`
// refs, so it may run longer than a stem (10k); 20k is generous for a
// reading passage and still bounded.
export const StimulusText = z.string().max(20000);
export const ItemSetLayoutSchema = z.enum(ITEM_SET_LAYOUTS);

// Multi-source stimulus slice 2 (docs/multi-source-stimulus-design.md): the
// labelled sources under the introduction. Same bounds as the shared wire
// schema (StimulusSourceSchema) so a set the teacher saves and a set that
// arrives by import cannot differ; `sources` is replaced whole on write, like
// `stimulus_text`, because a source has no id to address it by (D-1).
export const StimulusSources = z
  .array(z.object({ label: z.string().trim().min(1).max(80), text: StimulusText }))
  .max(12);

export const CreateItemSetBody = z.object({
  /** The items to group, in any order; they must be contiguous in the
   * assessment order and in no other set. */
  item_ids: z.array(z.string().uuid()).min(1),
  stimulus_text: StimulusText.optional(),
  sources: StimulusSources.optional(),
  layout: ItemSetLayoutSchema.optional(),
});
export type CreateItemSetBody = z.infer<typeof CreateItemSetBody>;

export const UpdateItemSetBody = z
  .object({
    stimulus_text: StimulusText.optional(),
    sources: StimulusSources.optional(),
    layout: ItemSetLayoutSchema.optional(),
    // E12 slice 1: the essay / short-text question elsewhere whose saved
    // answer each student sees as this stimulus; null clears it.
    source_item_id: z.string().uuid().nullable().optional(),
  })
  .refine(
    (b) =>
      b.stimulus_text !== undefined ||
      b.sources !== undefined ||
      b.layout !== undefined ||
      b.source_item_id !== undefined,
    { message: "nothing to update" },
  );
export type UpdateItemSetBody = z.infer<typeof UpdateItemSetBody>;

/** Item types whose saved answer can seed a later stimulus (E12). */
export const SOURCE_ITEM_TYPES = new Set(["essay", "short_text"]);

export type SourceItemCheck =
  | { ok: true }
  | { ok: false; status: 400 | 404; error: "source_not_found" | "source_type_not_allowed" | "source_in_this_assessment" };

/**
 * E12 slice 1: may `sourceItemId` seed a stimulus in `assessmentId`? The
 * question must exist in an assessment the SAME owner owns (a foreign or
 * missing one reads as not found — no existence leak), be an essay or
 * short-text question, and live in a different assessment.
 */
export async function checkSourceItem(
  db: ReturnType<typeof getDb>,
  sourceItemId: string,
  session: SessionPayload,
  assessmentId: string,
): Promise<SourceItemCheck> {
  const [row] = await db
    .select({ type: items.type, assessment_id: items.assessment_id })
    .from(items)
    .where(eq(items.id, sourceItemId))
    .limit(1);
  if (!row) return { ok: false, status: 404, error: "source_not_found" };
  // The item's own assessment answers the access question (access slice 1,
  // D-3) — a source question in an assessment the caller cannot reach is
  // reported as missing, exactly as the old inline owner comparison did.
  const access = await authorizeAssessment(db, session, row.assessment_id, "edit");
  if (!access.ok) return { ok: false, status: 404, error: "source_not_found" };
  if (!SOURCE_ITEM_TYPES.has(row.type)) return { ok: false, status: 400, error: "source_type_not_allowed" };
  if (row.assessment_id === assessmentId) return { ok: false, status: 400, error: "source_in_this_assessment" };
  return { ok: true };
}

export const AttachItemBody = z.object({ item_id: z.string().uuid() });
export type AttachItemBody = z.infer<typeof AttachItemBody>;

/** Sorted positions form one run with no gaps. */
export function isContiguousRun(positions: readonly number[]): boolean {
  if (positions.length === 0) return false;
  const sorted = [...positions].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1]! + 1) return false;
  }
  return true;
}

/**
 * Would this order split a set? Every set's members must appear as one
 * block. Returns the first offending set id, or null when the order keeps
 * every set together. `setOf` maps item id → set id (or null).
 */
export function splitSetInOrder(
  orderedIds: readonly string[],
  setOf: ReadonlyMap<string, string | null>,
): string | null {
  const closed = new Set<string>();
  let current: string | null = null;
  for (const id of orderedIds) {
    const set = setOf.get(id) ?? null;
    if (set !== current) {
      if (set !== null && closed.has(set)) return set;
      if (current !== null) closed.add(current);
      current = set;
    }
  }
  return null;
}

/** The items of one assessment, in order, with the columns the set rules need. */
export async function loadSetMembers(assessmentId: string) {
  const db = getDb();
  return db
    .select({ id: items.id, position: items.position, item_set_id: items.item_set_id })
    .from(items)
    .where(eq(items.assessment_id, assessmentId))
    .orderBy(asc(items.position));
}

/** Load a set and confirm the session owns its assessment (404 / 403 / 200). */
/**
 * Load one item set inside an assessment the caller may edit.
 *
 * The join used to carry the owner comparison; `authorizeAssessment` owns that
 * question now (access slice 1, D-3), so a set in someone else's assessment is
 * a 404 rather than the old 403.
 */
export async function loadItemSetForSession(
  assessmentId: string,
  setId: string,
  session: SessionPayload,
  need: AccessLevel = "own",
): Promise<
  | { ok: true; set: ItemSetRow; parentStatus: string }
  | { ok: false; response: NextResponse }
> {
  const db = getDb();
  const access = await authorizeAssessment(db, session, assessmentId, need);
  if (!access.ok) return { ok: false, response: access.response };
  const [set] = await db
    .select()
    .from(item_sets)
    .where(and(eq(item_sets.id, setId), eq(item_sets.assessment_id, assessmentId)))
    .limit(1);
  if (!set) return { ok: false, response: notFoundResponse() };
  return { ok: true, set, parentStatus: access.assessment.status };
}

/** The sets of one assessment ordered by where their first item sits. */
/** E12: what the editor shows about a set's source question. */
export interface ItemSetSourceSummary {
  item_id: string;
  stem: string;
  assessment_id: string;
  assessment_name: string;
  assessment_status: string;
}

export async function loadItemSetsInOrder(assessmentId: string) {
  const db = getDb();
  const sets = await db
    .select()
    .from(item_sets)
    .where(eq(item_sets.assessment_id, assessmentId));
  if (sets.length === 0) return [];
  const members = await loadSetMembers(assessmentId);
  const firstPos = new Map<string, number>();
  for (const m of members) {
    if (m.item_set_id && !firstPos.has(m.item_set_id)) firstPos.set(m.item_set_id, m.position);
  }
  // E12 slice 2: the source question's stem and its assessment's name and
  // status, so the card can say what it pulls from and readiness can warn
  // when that assessment is still a draft.
  const sourceIds = sets.map((s) => s.source_item_id).filter((v): v is string => typeof v === "string");
  const summaries = new Map<string, ItemSetSourceSummary>();
  if (sourceIds.length > 0) {
    const rows = await db
      .select({
        item_id: items.id,
        stem: items.stem,
        assessment_id: assessments.id,
        assessment_name: assessments.name,
        assessment_status: assessments.status,
      })
      .from(items)
      .innerJoin(assessments, eq(assessments.id, items.assessment_id))
      .where(inArray(items.id, sourceIds));
    for (const r of rows) summaries.set(r.item_id, r);
  }
  return sets
    .slice()
    .sort((a, b) => (firstPos.get(a.id) ?? Infinity) - (firstPos.get(b.id) ?? Infinity))
    .map((s) => ({ ...s, source: s.source_item_id ? (summaries.get(s.source_item_id) ?? null) : null }));
}
