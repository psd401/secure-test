import { asc, eq } from "drizzle-orm";
import { ItemBundleSchema, type ItemBundle } from "@secure-test/schema";
import type { getDb } from "@/db/client";
import { items, ITEM_TYPES, type AssessmentRow, type ItemType } from "@/db/schema";
import { exportItemSets } from "@/lib/api/itemSetsBundle";
import { assertNever } from "@/lib/assertNever";
import { collectBundleAssets } from "@/lib/api/bundleAssets";
import { IncompleteItemError, assertItemsAreBundleable } from "@/lib/api/itemIntegrity";

// Slice C (2026-09-01): the export bundle builder, lifted verbatim out of
// GET /api/assessments/[id]/export so staff-to-staff sharing can copy an
// assessment through the SAME lossless wire format the backup download
// uses (share → export bundle → importBundleForOwner for the recipient).
// The route keeps its HTTP shape; every early return here carries the
// status it used to send.

export type ExportBundleResult =
  | { ok: true; bundle: ItemBundle; bundledCount: number }
  | {
      ok: false;
      status: 409 | 500;
      error: string;
      item_id?: string;
      detail?: string;
    };

export async function buildExportBundle(
  db: ReturnType<typeof getDb>,
  assessmentRow: AssessmentRow,
  ownerSub: string,
  includeHiddenRubrics: boolean,
): Promise<ExportBundleResult> {
  const id = assessmentRow.id;
  const itemRows = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, id))
    .orderBy(asc(items.position));

  // Slice 46: the DB `type` column is plain text, so a forged/legacy row
  // can carry a type the exporter doesn't know. That used to silently
  // export as short_text (dropping its real fields); now it fails loudly
  // before anything is emitted.
  for (const row of itemRows) {
    if (!(ITEM_TYPES as readonly string[]).includes(row.type)) {
      console.error(
        `export: unknown item type "${row.type}" on item ${row.id} (assessment ${id})`,
      );
      return { ok: false, status: 500, error: "unknown_item_type", item_id: row.id };
    }
  }

  // Slice 70: an item that cannot produce a valid bundle is reported by id.
  // Without this the schema parse at the end of this route threw an unhandled
  // ZodError, so a teacher pressing Export got a bare 500 naming nothing.
  try {
    assertItemsAreBundleable(itemRows);
  } catch (err) {
    if (err instanceof IncompleteItemError) {
      return {
        ok: false,
        status: 409,
        error: "incomplete_item",
        item_id: err.itemId,
        detail: err.detail,
      };
    }
    throw err;
  }

  // All item types are part of the wire format (@secure-test/schema).
  // Emit each with its type-appropriate fields; the assertNever default
  // makes this switch fail typecheck when ITEM_TYPES grows without a
  // branch here (slice 46). x-skipped-items header is kept for backward
  // compat with any existing tooling that watches it, but is always 0.
  const exported = itemRows.map((row) => {
    const choices = Array.isArray(row.choices)
      ? (row.choices as { id: string; text: string }[])
      : [];
    const correctIds = Array.isArray(row.correct_choice_ids)
      ? (row.correct_choice_ids as string[])
      : [];

    // Slice 36: scoring_method rides the bundle on every type — emitted
    // only when the teacher picked explicitly, keeping older bundles
    // byte-stable (same convention as the essay config fields).
    const scoring = row.config?.scoring_method
      ? { scoring_method: row.config.scoring_method }
      : {};
    const type = row.type as ItemType;
    switch (type) {
      case "multiple_choice_single":
        return {
          type: "multiple_choice_single" as const,
          id: row.id,
          stem: row.stem,
          choices,
          correct_choice_id: correctIds[0],
          ...scoring,
        };
      case "multiple_choice_multi":
        return {
          type: "multiple_choice_multi" as const,
          id: row.id,
          stem: row.stem,
          choices,
          correct_choice_ids: correctIds,
          ...scoring,
        };
      case "essay": {
        // Slice 32: emit metadata only when set so older bundles stay
        // byte-stable.
        const config = row.config ?? {};
        return {
          type: "essay" as const,
          id: row.id,
          stem: row.stem,
          ...(config.max_word_count != null
            ? { max_word_count: config.max_word_count }
            : {}),
          ...(config.placeholder ? { placeholder: config.placeholder } : {}),
          // B8: mirror the preview renderer's during_test gate. Omitted
          // outright rather than shipped with a "hidden" flag — the bundle is
          // a file on the student's machine, so a flag only holds if every
          // future client honors it. See INCLUDE_HIDDEN_RUBRICS_PARAM above.
          ...(config.rubric &&
          (includeHiddenRubrics ||
            config.rubric.student_visibility?.during_test)
            ? { rubric: config.rubric }
            : {}),
          ...scoring,
        };
      }
      case "short_text":
        return {
          type: "short_text" as const,
          id: row.id,
          stem: row.stem,
          // 2026-09-01: a keyless short_text stores "" — emit no key rather
          // than an empty string the wire schema's min(1) would reject.
          correct_answer: row.correct_answer || undefined,
          ...scoring,
        };
      case "match":
        // Slice 47: the pair list lives in config and IS the answer key.
        return {
          type: "match" as const,
          id: row.id,
          stem: row.stem,
          pairs: row.config?.pairs ?? [],
          ...scoring,
        };
      case "order":
        // Slice 48: the sequence lives in config, in correct order (the key).
        return {
          type: "order" as const,
          id: row.id,
          stem: row.stem,
          sequence: row.config?.sequence ?? [],
          ...scoring,
        };
      case "hotspot":
        // Slice 49: image + regions + key live in config. Emit the image
        // ref only when set (draft hotspots have none).
        return {
          type: "hotspot" as const,
          id: row.id,
          stem: row.stem,
          ...(row.config?.image_asset_id
            ? { image_asset_id: row.config.image_asset_id }
            : {}),
          regions: row.config?.regions ?? [],
          correct_region_ids: row.config?.correct_region_ids ?? [],
          ...scoring,
        };
      case "drawing_upload":
        // Slice 50: authoring-only metadata; emit keys only when set.
        return {
          type: "drawing_upload" as const,
          id: row.id,
          stem: row.stem,
          ...(row.config?.prompt_asset_id
            ? { prompt_asset_id: row.config.prompt_asset_id }
            : {}),
          ...(row.config?.canvas ? { canvas: row.config.canvas } : {}),
          ...scoring,
        };
      case "table":
        // E3 slice 1: grid + keys live in config; the teacher bundle carries
        // the keys (import reads them back). Optional fields emitted only
        // when set, keeping older bundles byte-stable.
        return {
          type: "table" as const,
          id: row.id,
          stem: row.stem,
          columns: row.config?.columns ?? [],
          rows: row.config?.rows ?? [],
          ...(row.config?.corner ? { corner: row.config.corner } : {}),
          ...(row.config?.cell_keys ? { cell_keys: row.config.cell_keys } : {}),
          ...scoring,
        };
      default:
        return assertNever(type, "export: unhandled item type");
    }
  });

  // Slice 15: bundle any image refs in stems / choices as base64
  // alongside the items so an offline consumer (PoC-B) can render
  // `![alt](asset:<uuid>)` without an HTTP session. Owner-scoped — refs
  // to assets the teacher doesn't own simply don't get bundled and
  // remain as raw `asset:<uuid>` text in the exported stem (offline
  // consumers will render them as a missing-image placeholder).
  // Slice 51: the resolution moved to lib/api/bundleAssets so the student
  // delivery bundle resolves the same refs the same way; behaviour here is
  // unchanged, including emitting `assets: {}` when every read misses.
  // E5 slice 1: sets ride the bundle (omitted when there are none, so older
  // golden bundles stay byte-stable); their stimuli's asset refs are bundled
  // like stem refs.
  const itemSets = await exportItemSets(db, id, itemRows, { withSource: true });
  const { assets: bundledAssets, count: bundledCount } = await collectBundleAssets(
    db,
    ownerSub,
    itemRows,
    // Multi-source stimulus slice 2: a figure inside a source is an
    // `asset:` ref like any other, so every source text is scanned too.
    itemSets.flatMap((s) => [s.stimulus, ...s.sources.map((src) => src.text)]),
  );

  // Slice 21: round-trip the accommodations metadata. Skip emit when
  // the arrays are empty so older golden bundles (pre-slice-21) stay
  // byte-stable.
  const allowed = (assessmentRow.allowed_accommodations ?? []) as string[];
  const ca = (assessmentRow.construct_altering ?? []) as string[];

  const bundle = {
    test_id: assessmentRow.id,
    title: assessmentRow.name,
    items: exported,
    ...(itemSets.length > 0 ? { item_sets: itemSets } : {}),
    ...(bundledAssets ? { assets: bundledAssets } : {}),
    ...(allowed.length > 0 ? { allowed_accommodations: allowed } : {}),
    ...(ca.length > 0 ? { construct_altering: ca } : {}),
    // Client paging: only "paged" is worth a field; scroll is the default.
    ...(assessmentRow.student_layout === "paged" ? { student_layout: "paged" as const } : {}),
  };

  // Round-trip through @secure-test/schema as a final correctness check.
  //
  // The catch is the backstop for whatever the explicit checks above do not
  // anticipate. A schema failure here is a bug or a corrupt row either way, but
  // it should leave a log naming the assessment rather than an anonymous 500.
  let validated: ItemBundle;
  try {
    validated = ItemBundleSchema.parse(bundle);
  } catch (err) {
    console.error(`export: bundle failed validation for assessment ${id}:`, err);
    return { ok: false, status: 500, error: "bundle_invalid" };
  }

  return { ok: true, bundle: validated, bundledCount };
}
