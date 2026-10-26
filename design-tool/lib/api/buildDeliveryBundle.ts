import { asc, eq } from "drizzle-orm";
import { DeliveryBundleSchema, type CalculatorMode, type CalculatorPreset, type DeliveryBundle } from "@secure-test/schema";
import {
  items,
  ITEM_TYPES,
  type AssessmentRow,
  item_sets } from "@/db/schema";
import type { getDb } from "@/db/client";
import { clientSupportsHighlighting } from "@/lib/items/clientSupport";
import { collectBundleAssets } from "@/lib/api/bundleAssets";
import { exportItemSets } from "@/lib/api/itemSetsBundle";
import { applySourcesToSets } from "@/lib/api/setSources";
import { collectSavedAnswers } from "@/lib/api/savedResponses";
import { assertItemsAreBundleable } from "@/lib/api/itemIntegrity";
import type { EffectiveAccommodations } from "@/lib/accommodations/effective";
import { MATCH_LEFT, MATCH_RIGHT, opaqueId } from "@/lib/api/opaqueIds";
import { deliveredItem } from "@/lib/api/deliveryItem";

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

// The per-item mapping (which fields ship, which keys never do, match / order
// sealing and shuffling) lives in lib/api/deliveryItem.ts — shared with the
// editor's interactive preview (ADR 0019 §4).

export async function buildDeliveryBundle(
  db: Db,
  assessment: AssessmentRow,
  accommodations: EffectiveAccommodations,
  /** Anchors the per-attempt opaque ids on match and order items (slice 64). */
  attemptId: string,
  /** E12 slice 2: whose saved answers seed source-backed stimuli. */
  studentId: string,
  /**
   * Time limit (D-2/D-3): the instant THIS attempt's time runs out, or null
   * when the assessment has no limit. Computed by the caller through
   * `lib/api/attemptDeadline.ts` — this builder is handed the answer rather
   * than the arithmetic, because the same helper decides whether a write is
   * still accepted and the two must not be able to disagree.
   */
  deadline: Date | null = null,
  /**
   * The client's `X-SecureTest-Version` header, null when absent. Gates
   * `allow_highlighting` (lib/items/clientSupport.ts, H-1).
   */
  clientVersion: string | null = null,
): Promise<{ bundle: DeliveryBundle; bundledCount: number }> {
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

  // Graphing calculator (D-7): the per-question "no calculator" mark rides
  // every item type, and only when the test has a calculator to hide.
  const hasCalculator = assessment.calculator_mode !== "none";
  // Slice 64: both sides of a match pair and every order entry carry
  // per-attempt opaque ids (lib/api/opaqueIds.ts).
  const delivered = itemRows.map((row) =>
    deliveredItem(
      row,
      (realId, side) =>
        opaqueId(attemptId, row.id, realId, side === "left" ? MATCH_LEFT : side === "right" ? MATCH_RIGHT : ""),
      hasCalculator,
    ),
  );
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
    // Multi-source stimulus slice 2: source texts carry `asset:` refs too.
    itemSets.flatMap((s) => [s.stimulus, ...s.sources.map((src) => src.text)]),
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
    // Passage highlighting (docs/passage-highlighting-design.md): only when
    // on AND the client reports 2.0+. An older client gets no field and is
    // not refused (H-1) — it renders the test exactly as before.
    ...(assessment.allow_highlighting && clientSupportsHighlighting(clientVersion)
      ? { allow_highlighting: true }
      : {}),
    // Graphing calculator (docs/graphing-calculator-design.md D-7): every
    // student gets it; emitted only when the test has one. The delivery
    // route refuses this bundle to a client older than 2.0.0.
    ...(hasCalculator
      ? {
          calculator: {
            mode: assessment.calculator_mode as CalculatorMode,
            preset: assessment.calculator_preset as CalculatorPreset,
          },
        }
      : {}),
    // Client paging: emitted only as "paged"; absence means one scrolling
    // page, which is what every client before the field did anyway.
    ...(assessment.student_layout === "paged" ? { layout: "paged" as const } : {}),
    // Time limit: BOTH keys or neither. `server_now` is meaningless without a
    // deadline to count down to, and emitting it unconditionally would change
    // every bundle an assessment without a limit has ever produced.
    ...(deadline
      ? {
          time_limit_ends_at: deadline.toISOString(),
          server_now: new Date().toISOString(),
        }
      : {}),
  };

  // DeliveryBundleSchema has no field that can hold an answer key, so this also
  // proves the mapping above did not smuggle one through.
  return { bundle: DeliveryBundleSchema.parse(bundle), bundledCount };
}
