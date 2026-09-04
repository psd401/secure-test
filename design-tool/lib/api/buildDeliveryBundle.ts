import { asc, eq } from "drizzle-orm";
import { DeliveryBundleSchema } from "@secure-test/schema";
import {
  items,
  ITEM_TYPES,
  type AssessmentRow,
  type ItemRow,
  type ItemType, item_sets } from "@/db/schema";
import type { getDb } from "@/db/client";
import { assertNever } from "@/lib/assertNever";
import { collectBundleAssets } from "@/lib/api/bundleAssets";
import { exportItemSets } from "@/lib/api/itemSetsBundle";
import { applySourcesToSets } from "@/lib/api/setSources";
import { collectSavedAnswers } from "@/lib/api/savedResponses";
import { assertItemsAreBundleable } from "@/lib/api/itemIntegrity";
import type { EffectiveAccommodations } from "@/lib/accommodations/effective";
import { MATCH_LEFT, MATCH_RIGHT, opaqueId } from "@/lib/api/opaqueIds";

type Db = ReturnType<typeof getDb>;

/**
 * Slice 62: extracted from the delivery route so the route and the fixture
 * generator build the identical bundle.
 *
 * The generator used to call the route directly, which stopped being possible
 * once the route required a student principal. A generator that reimplemented
 * the mapping instead would drift from the thing it is supposed to be a fixture
 * OF, which is the one property that made the fixture worth having.
 */
export class UnknownItemTypeError extends Error {
  constructor(readonly itemId: string, readonly itemType: string) {
    super(`unknown item type "${itemType}" on item ${itemId}`);
    this.name = "UnknownItemTypeError";
  }
}

// Fisher-Yates. match `rights` and order `entries` ship shuffled so the
// authored order is not itself the answer. This is obfuscation, not secrecy:
// the ids in those arrays are still the authoring ids, so a student reading the
// bundle can correlate them. Sealing that needs a per-attempt id map held
// server-side, which needs the attempt instance from the student plane. The
// wire shape is already final, so that work swaps ids without touching clients.
function shuffled<T>(input: readonly T[]): T[] {
  const out = [...input];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

// scoring_method is emitted on no branch: it is not an answer key, but it
// telegraphs whether an item is AI- or human-scored, which the student has no
// need for. The assertNever default makes this switch fail typecheck if
// ITEM_TYPES grows without a branch here.
function mapItemForDelivery(row: ItemRow, attemptId: string) {
  const choices = Array.isArray(row.choices)
    ? (row.choices as { id: string; text: string }[])
    : [];
  const config = row.config ?? {};
  const type = row.type as ItemType;
  switch (type) {
    case "multiple_choice_single":
      return {
        type: "multiple_choice_single" as const,
        id: row.id,
        stem: row.stem,
        choices,
      };
    case "multiple_choice_multi":
      return {
        type: "multiple_choice_multi" as const,
        id: row.id,
        stem: row.stem,
        choices,
      };
    case "short_text":
      // correct_answer dropped entirely — no replacement field.
      return {
        type: "short_text" as const,
        id: row.id,
        stem: row.stem,
      };
    case "essay":
      return {
        type: "essay" as const,
        id: row.id,
        stem: row.stem,
        ...(config.max_word_count != null
          ? { max_word_count: config.max_word_count }
          : {}),
        ...(config.placeholder ? { placeholder: config.placeholder } : {}),
        // Mirrors the export route's B8 gate, minus the teacher opt-in:
        // there is no include_hidden_rubrics on the student path. Level
        // descriptors routinely spell out what a correct answer contains.
        ...(config.rubric?.student_visibility?.during_test
          ? { rubric: config.rubric }
          : {}),
      };
    case "match": {
      // The pair list IS the key: each object holds a left beside its own
      // correct right. Split into two independent arrays so the association is
      // not carried by the structure — and slice 64: both sides carry
      // per-attempt opaque ids, so the arrays cannot be re-paired by reading
      // the identifiers either.
      const pairs = config.pairs ?? [];
      return {
        type: "match" as const,
        id: row.id,
        stem: row.stem,
        lefts: pairs.map((p) => ({
          id: opaqueId(attemptId, row.id, p.id, MATCH_LEFT),
          text: p.left,
        })),
        rights: shuffled(
          pairs.map((p) => ({
            id: opaqueId(attemptId, row.id, p.id, MATCH_RIGHT),
            text: p.right,
          })),
        ),
      };
    }
    case "order":
      // The sequence IS the key: it is stored in correct order, and entry ids
      // are assigned in that order, so their natural ordering is the answer
      // too. Shuffling handles the first; opaque ids handle the second.
      return {
        type: "order" as const,
        id: row.id,
        stem: row.stem,
        entries: shuffled(
          (config.sequence ?? []).map((e) => ({
            id: opaqueId(attemptId, row.id, e.id),
            label: e.label,
          })),
        ),
      };
    case "hotspot":
      // regions stay (the client must draw them); correct_region_ids goes.
      return {
        type: "hotspot" as const,
        id: row.id,
        stem: row.stem,
        ...(config.image_asset_id ? { image_asset_id: config.image_asset_id } : {}),
        regions: config.regions ?? [],
      };
    case "drawing_upload":
      // Authoring-only type; it has no key to drop.
      return {
        type: "drawing_upload" as const,
        id: row.id,
        stem: row.stem,
        ...(config.prompt_asset_id ? { prompt_asset_id: config.prompt_asset_id } : {}),
        ...(config.canvas ? { canvas: config.canvas } : {}),
      };
    case "table":
      // E3 slice 1: the grid ships (columns, rows, corner); cell_keys does
      // not. Row and column ids are structure, not the key — nothing to
      // seal, the response addresses cells by them.
      return {
        type: "table" as const,
        id: row.id,
        stem: row.stem,
        columns: config.columns ?? [],
        rows: config.rows ?? [],
        ...(config.corner ? { corner: config.corner } : {}),
      };
    default:
      return assertNever(type, "delivery: unhandled item type");
  }
}

export async function buildDeliveryBundle(
  db: Db,
  assessment: AssessmentRow,
  accommodations: EffectiveAccommodations,
  /** Anchors the per-attempt opaque ids on match and order items (slice 64). */
  attemptId: string,
  /** E12 slice 2: whose saved answers seed source-backed stimuli. */
  studentId: string,
): Promise<{ bundle: unknown; bundledCount: number }> {
  const itemRows = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, assessment.id))
    .orderBy(asc(items.position));

  // Same posture as the export route (slice 46): the DB `type` column is plain
  // text, so a forged or legacy row can carry a type this switch does not know.
  // Fail before emitting anything rather than shipping it as the wrong type —
  // on the student path that could mean shipping a field that is a key.
  for (const row of itemRows) {
    if (!(ITEM_TYPES as readonly string[]).includes(row.type)) {
      throw new UnknownItemTypeError(row.id, row.type);
    }
  }

  // Slice 70: same check the export route makes. On this path the stakes are
  // higher — an unhandled throw here means a student who joined correctly sees
  // "this test could not be opened" with nothing anywhere naming the item.
  assertItemsAreBundleable(itemRows);

  const delivered = itemRows.map((row) => mapItemForDelivery(row, attemptId));
  // E5 slice 1: stimuli are student-facing; same shape as the teacher bundle,
  // item ids are the same uuids on both sides.
  const plainSets = await exportItemSets(db, assessment.id, itemRows);
  // E12 slice 2: a set backed by a source question shows this student's own
  // saved answer (lib/api/setSources.ts); the source link itself never rides
  // the student bundle.
  const sourceRows = await db
    .select({ id: item_sets.id, source_item_id: item_sets.source_item_id })
    .from(item_sets)
    .where(eq(item_sets.assessment_id, assessment.id));
  const itemSets = await applySourcesToSets(
    db,
    plainSets,
    new Map(sourceRows.map((r) => [r.id, r.source_item_id])),
    studentId,
    attemptId,
  );
  const { assets: bundledAssets, count: bundledCount } = await collectBundleAssets(
    db,
    assessment.owner_sub,
    itemRows,
    itemSets.map((s) => s.stimulus),
  );

  // Client paging follow-up (D-4), extended by P-1: which of these questions
  // this attempt has already answered — a row in `responses` for the attempt —
  // AND what those answers were. Only this assessment's items count (an E12
  // outline written in place is keyed by another assessment's question and is
  // not a question here). One query, one pass, so a mark can never arrive
  // without its value. All three keys are emitted only when non-empty, so a
  // fresh attempt's bundle is unchanged.
  const { answeredItemIds, savedResponses, savedUploads } = await collectSavedAnswers(
    db,
    attemptId,
    itemRows,
  );

  const bundle = {
    test_id: assessment.id,
    title: assessment.name,
    items: delivered,
    ...(answeredItemIds.length > 0 ? { answered_item_ids: answeredItemIds } : {}),
    ...(Object.keys(savedResponses).length > 0
      ? { saved_responses: savedResponses }
      : {}),
    ...(Object.keys(savedUploads).length > 0 ? { saved_uploads: savedUploads } : {}),
    ...(itemSets.length > 0 ? { item_sets: itemSets } : {}),
    ...(bundledAssets ? { assets: bundledAssets } : {}),
    ...(Object.keys(accommodations.enabled).length > 0
      ? { accommodations: accommodations.enabled }
      : {}),
    ...(accommodations.constructAltering.length > 0
      ? { construct_altering: accommodations.constructAltering }
      : {}),
    // Slice 69: emitted only when true. Absence means locked, so a client that
    // has not heard of this flag stays closed rather than open.
    ...(assessment.allow_clipboard ? { allow_clipboard: true } : {}),
    // Client paging: emitted only as "paged"; absence means one scrolling
    // page, which is what every client before the field did anyway.
    ...(assessment.student_layout === "paged" ? { layout: "paged" as const } : {}),
  };

  // DeliveryBundleSchema has no field that can hold an answer key, so this also
  // proves the mapping above did not smuggle one through.
  return { bundle: DeliveryBundleSchema.parse(bundle), bundledCount };
}
