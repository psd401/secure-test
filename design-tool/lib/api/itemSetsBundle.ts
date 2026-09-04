import { eq, inArray } from "drizzle-orm";
import type { TeacherItemSet } from "@secure-test/schema";
import type { getDb } from "@/db/client";
import { item_sets, items, type ItemRow, type ItemSetLayout } from "@/db/schema";

type Db = ReturnType<typeof getDb>;

// E5 slice 1: the item_sets entry both bundles emit — the teacher export and
// the student delivery carry the SAME shape, because a stimulus is
// student-facing by definition. Item ids are the row uuids on both sides
// (mapItemForDelivery keeps `id: row.id`). Sets are ordered by their first
// item's position and each set lists its items in position order; a set with
// no items in `itemRows` (cannot happen after the auto-delete rule, but a
// forged row could) is dropped rather than emitted empty.
// E12 slice 1: `withSource` adds the teacher-only `source` link (the source
// question's assessment and item ids). The teacher export passes it; the
// delivery bundle and the preview never do (ADR 0016 — no teacher links in
// the student format).
export async function exportItemSets(
  db: Db,
  assessmentId: string,
  itemRows: readonly ItemRow[],
  opts: { withSource?: boolean } = {},
): Promise<TeacherItemSet[]> {
  const rows = await db
    .select()
    .from(item_sets)
    .where(eq(item_sets.assessment_id, assessmentId));
  if (rows.length === 0) return [];
  const membersOf = new Map<string, ItemRow[]>();
  for (const item of [...itemRows].sort((a, b) => a.position - b.position)) {
    if (!item.item_set_id) continue;
    const list = membersOf.get(item.item_set_id) ?? [];
    list.push(item);
    membersOf.set(item.item_set_id, list);
  }
  const sourceIds = opts.withSource
    ? rows.map((r) => r.source_item_id).filter((v): v is string => typeof v === "string")
    : [];
  const sourceAssessment = new Map<string, string>();
  if (sourceIds.length > 0) {
    const src = await db
      .select({ id: items.id, assessment_id: items.assessment_id })
      .from(items)
      .where(inArray(items.id, sourceIds));
    for (const r of src) sourceAssessment.set(r.id, r.assessment_id);
  }
  return rows
    .map((set) => ({ set, members: membersOf.get(set.id) ?? [] }))
    .filter(({ members }) => members.length > 0)
    .sort((a, b) => a.members[0]!.position - b.members[0]!.position)
    .map(({ set, members }) => {
      const srcAssessment = set.source_item_id ? sourceAssessment.get(set.source_item_id) : undefined;
      return {
        id: set.id,
        stimulus: set.stimulus_text,
        layout: set.layout as ItemSetLayout,
        item_ids: members.map((m) => m.id),
        ...(opts.withSource && set.source_item_id && srcAssessment
          ? { source: { assessment_id: srcAssessment, item_id: set.source_item_id } }
          : {}),
      };
    });
}
