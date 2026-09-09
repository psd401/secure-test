import { z } from "zod";

export const ChoiceSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
});

// Slice 36: how the item is scored (docs/phase-3-slices.md). Optional on
// the wire — absence means the type default (MC/short_text → auto, essay →
// human). Cross-field rules (auto is invalid for essay; ai/hybrid require a
// rubric) are NOT enforced here: the bundle layer stays permissive on
// purpose and the importing side clamps, same as accommodations. The
// execution semantics of ai vs hybrid are pinned in slices 38/39.
export const ScoringMethodSchema = z.enum(["auto", "ai", "human", "hybrid"]);

const baseItem = {
  id: z.string().min(1),
  stem: z.string(),
  scoring_method: ScoringMethodSchema.optional(),
};

export const SingleSelectMCItemSchema = z.object({
  type: z.literal("multiple_choice_single"),
  ...baseItem,
  choices: z.array(ChoiceSchema).min(2),
  correct_choice_id: z.string().min(1).optional(),
});

export const MultiSelectMCItemSchema = z.object({
  type: z.literal("multiple_choice_multi"),
  ...baseItem,
  choices: z.array(ChoiceSchema).min(2),
  // 2026-09-01: keyless items are legal drafts (design-tool slice B), so a
  // multi-select may ride the bundle with no correct ids yet.
  correct_choice_ids: z.array(z.string().min(1)),
});

export const ShortTextItemSchema = z.object({
  type: z.literal("short_text"),
  ...baseItem,
  correct_answer: z.string().min(1).optional(),
});

// Slice 33: rubric block on essay items. Authoring + storage only — Phase 3
// AI/human scoring consumes it later (design-tool-plan.md:107,119). One
// unified structure serves all three styles as cardinality variants:
//   - analytic     : N criteria, each with a scale (>= 2 levels)
//   - holistic     : exactly 1 criterion, scale (>= 2 levels)
//   - single_point : N criteria, each with exactly 1 level (the target;
//                    below/above is graded per-student in Phase 3)
// The style-specific cardinality is enforced in superRefine below so a
// single editor/validator/scorer can read every style.
export const RubricLevelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(120),
  // Per-level points; required for a uniform shape (set 0 where a style
  // doesn't use points). Non-negative; decimals allowed.
  points: z.number().nonnegative(),
  descriptor: z.string().max(2000).optional(),
});

export const RubricCriterionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  levels: z.array(RubricLevelSchema).min(1),
});

export const RubricSchema = z
  .object({
    style: z.enum(["analytic", "holistic", "single_point"]),
    criteria: z.array(RubricCriterionSchema).min(1),
    // Slice 33: teacher-controlled student visibility. `during_test` mirrors
    // into the design-tool preview now and rides the bundle to the student
    // client; `with_feedback` is stored now, consumed in Phase 3 (no results
    // to show yet). Both optional → default hidden.
    student_visibility: z
      .object({
        during_test: z.boolean().optional(),
        with_feedback: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine((rubric, ctx) => {
    if (rubric.style === "holistic" && rubric.criteria.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["criteria"],
        message: "holistic rubric must have exactly one criterion",
      });
    }
    rubric.criteria.forEach((c, i) => {
      if (rubric.style === "single_point") {
        if (c.levels.length !== 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["criteria", i, "levels"],
            message: "single_point criteria must have exactly one level (the target)",
          });
        }
      } else if (c.levels.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["criteria", i, "levels"],
          message: "analytic/holistic criteria must have at least two levels",
        });
      }
    });
  });

// Slice 32: long-text / essay item. Authoring only — there is no scoring
// yet (Phase 3). `max_word_count` and `placeholder` are authoring metadata
// the live student client enforces/renders; the design-tool preview is
// no-script (ADR 0009) so it can't demo a live word cap. Both optional and
// emitted only when set, keeping older bundles byte-stable. Slice 33 adds an
// optional `rubric` (see RubricSchema).
export const EssayItemSchema = z.object({
  type: z.literal("essay"),
  ...baseItem,
  max_word_count: z.number().int().positive().optional(),
  placeholder: z.string().max(200).optional(),
  rubric: RubricSchema.optional(),
});

// Phase 4 slice 47: matching item. `pairs` is the answer key — each left
// belongs with its own right. Plain strings v1 (no math/image refs inside
// pairs); the consumer displays rights shuffled/reordered so the authored
// order doesn't give the answer away. Pair ids should be unique (the
// response format keys on them) — enforced at the design-tool write
// boundary, not here: the wire layer stays permissive on purpose, and a
// discriminatedUnion member must remain a plain ZodObject.
export const MatchPairSchema = z.object({
  id: z.string().min(1),
  left: z.string().min(1),
  right: z.string().min(1),
});

export const MatchItemSchema = z.object({
  type: z.literal("match"),
  ...baseItem,
  pairs: z.array(MatchPairSchema).min(2),
});

// Phase 4 slice 48: ordering item. `sequence` is the answer key — entries
// in their correct order. Plain strings v1, same posture as match: entry
// ids should be unique (write-boundary enforced) and consumers display the
// entries shuffled so the authored order doesn't give the answer away.
export const SequenceEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const OrderItemSchema = z.object({
  type: z.literal("order"),
  ...baseItem,
  sequence: z.array(SequenceEntrySchema).min(2),
});

// Phase 4 slice 49: hotspot item. An image (referenced by asset uuid, same
// asset layer as stem image refs) with rectangular regions normalized to
// 0–1 of the image; `correct_region_ids` is the answer key. A hotspot may
// be a DRAFT (no image/regions yet) — the editor creates first, the teacher
// draws regions after — and an unconfigured hotspot is simply unscorable.
// Regions carry no correctness marker visually; only the key knows.
export const HotspotRegionSchema = z.object({
  id: z.string().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
});

export const HotspotItemSchema = z.object({
  type: z.literal("hotspot"),
  ...baseItem,
  image_asset_id: z.string().min(1).nullable().optional(),
  regions: z.array(HotspotRegionSchema).default([]),
  correct_region_ids: z.array(z.string().min(1)).default([]),
});

// Phase 4 slice 50: drawing/upload item — AUTHORING ONLY. There is
// deliberately no drawing response schema yet: student file ingest belongs
// to the student-app plan, so this type ships with prompt metadata only
// (optional reference image + optional canvas dimensions the client will
// enforce) and is human-scored once responses exist.
// Drawing background (docs/drawing-background-design.md, D-1/D-2/D-3):
// ABSENT = a blank canvas, exactly what shipped — no existing drawing
// changes. `grid` = square graph paper; `axes` = the same grid with
// unlabelled x/y axes through the centre. The client paints the paper INTO
// the canvas under the student's strokes, so the saved PNG carries it and
// nothing downstream (teacher view, resume restore) has to know the grid
// exists. Labels, scale, plotted points and auto-scoring are the post-MVP
// graphing suite, not this field.
export const DrawingCanvasBackgroundSchema = z.enum(["grid", "axes"]);

export const DrawingCanvasSchema = z.object({
  width: z.number().int().min(100).max(4000),
  height: z.number().int().min(100).max(4000),
  background: DrawingCanvasBackgroundSchema.optional(),
});

export const DrawingUploadItemSchema = z.object({
  type: z.literal("drawing_upload"),
  ...baseItem,
  prompt_asset_id: z.string().min(1).nullable().optional(),
  canvas: DrawingCanvasSchema.nullable().optional(),
});

// E3 slice 1 (docs/e3-table-item-design.md): a table the student fills in.
// `columns` is the header row, `rows` the labelled first column, and every
// body cell is a blank (D-1). `cell_keys` holds the expected text for any
// subset of cells — row id → column id → plain text (E7(a): never KaTeX in a
// key) — and is the ONE field that can hold an answer; the delivery schema
// has no such field. Labels follow choice-text rules (KaTeX, E6 emphasis);
// a row label may be blank (D-5: a table of N empty trials), a column
// label may not. Ids should be unique — enforced at the design-tool write
// boundary like match / order, the wire layer stays permissive.
export const TableColumnSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const TableRowSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
});

export const TableCellKeysSchema = z.record(
  z.string().min(1),
  z.record(z.string().min(1), z.string().min(1)),
);

export const TableItemSchema = z.object({
  type: z.literal("table"),
  ...baseItem,
  columns: z.array(TableColumnSchema).min(1),
  rows: z.array(TableRowSchema).min(1),
  corner: z.string().optional(),
  cell_keys: TableCellKeysSchema.optional(),
});

// Wire format spans the item types. Old fixtures (PoC-B's
// items.json predates this slice and omits `type`) are accepted via
// preprocess that defaults to multiple_choice_single — keeps round-trip
// compatibility for any consumer that hasn't been re-generated yet.
export const ItemSchema = z.preprocess(
  (val) => {
    if (
      val !== null &&
      typeof val === "object" &&
      !("type" in (val as Record<string, unknown>))
    ) {
      return { type: "multiple_choice_single", ...(val as Record<string, unknown>) };
    }
    return val;
  },
  z.discriminatedUnion("type", [
    SingleSelectMCItemSchema,
    MultiSelectMCItemSchema,
    ShortTextItemSchema,
    EssayItemSchema,
    MatchItemSchema,
    OrderItemSchema,
    HotspotItemSchema,
    DrawingUploadItemSchema,
    TableItemSchema,
  ]),
);

// Slice 15: bundles MAY ship binary asset blobs alongside the items so
// stems that contain `![alt](asset:<uuid>)` refs render in offline /
// PoC-B-style consumers that can't dereference asset: through an HTTP
// session. Each entry is keyed by the same uuid used in the stem ref.
// `content_type` mirrors the design-tool's `assets.content_type`
// column; `base64` is the standard padded base64 encoding of the raw
// bytes (no `data:` prefix — the consumer constructs that).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BundleAssetSchema = z.object({
  content_type: z.string().min(1).max(128),
  base64: z.string().min(1),
});

// E5 slice 1 (docs/stimulus-design.md): an item set is one stimulus — a
// passage, a figure, a data table — shared by one or more items, referenced
// by id. `stimulus` follows stem content rules (KaTeX + `![alt](asset:uuid)`
// refs, so the same `assets` map serves it). A set has no position of its
// own: its items must sit next to each other in `items` order and the set
// sits where its first item sits. Both bundles carry the same shape — a
// stimulus is student-facing by definition (James, 2026-09-01).
// Multi-source stimulus slice 2 (docs/multi-source-stimulus-design.md): one
// labelled source of a multi-source set — a poem, an article, a chart's
// excerpt. `text` follows stem content rules exactly as `stimulus` does, so
// the same asset map and the same KaTeX / emphasis renderers serve it. Named
// StimulusSource, not ItemSetSource: that name is already taken by the E12
// teacher-only per-student link below and the two are unrelated.
export const StimulusSourceSchema = z.object({
  label: z.string().trim().min(1).max(80),
  text: z.string().max(20000),
});
export type StimulusSource = z.infer<typeof StimulusSourceSchema>;

// D-2: `side_by_side` is a third value the teacher picks, never inferred
// from the source count. A client that predates it falls back to inline.
export const ItemSetLayoutSchema = z.enum(["inline", "own_page", "side_by_side"]);
export const ItemSetSchema = z.object({
  id: z.string().min(1),
  stimulus: z.string().max(20000),
  layout: ItemSetLayoutSchema.default("inline"),
  // Multi-source stimulus slice 2: the sources printed under the
  // introduction, in document order. Both bundles carry them — a source is
  // student-facing by definition, like the stimulus itself. Bundles written
  // before this slice parse with `sources: []`.
  sources: z.array(StimulusSourceSchema).max(12).default([]),
  item_ids: z.array(z.string().min(1)).min(1),
});
export type ItemSet = z.infer<typeof ItemSetSchema>;
export type ItemSetLayout = z.infer<typeof ItemSetLayoutSchema>;

// E12 slice 1 (design-tool docs/e12-per-student-stimulus-design.md): the
// TEACHER bundle may say a set's stimulus is each student's own saved
// answer to a question elsewhere — ids of that assessment and question as
// the exporting design tool knows them. The importing side keeps the link
// only when the same owner owns that assessment; otherwise it is dropped
// (the link is not portable across owners, by construction). Per ADR 0016
// this stays out of the student bundle, which carries no teacher links.
export const ItemSetSourceSchema = z.object({
  assessment_id: z.string().min(1),
  item_id: z.string().min(1),
});
export const TeacherItemSetSchema = ItemSetSchema.extend({
  source: ItemSetSourceSchema.optional(),
});
export type TeacherItemSet = z.infer<typeof TeacherItemSetSchema>;

/**
 * Cross-checks shared by ItemBundleSchema and DeliveryBundleSchema: every
 * set item exists, belongs to one set only, and the set's items are one
 * contiguous block in `items` order. Returns human-readable issues.
 */
export function itemSetIssues(
  itemIds: readonly string[],
  sets: readonly { id: string; item_ids: readonly string[] }[],
): string[] {
  const issues: string[] = [];
  const index = new Map(itemIds.map((id, i) => [id, i] as const));
  const claimed = new Map<string, string>();
  for (const set of sets) {
    const positions: number[] = [];
    for (const itemId of set.item_ids) {
      const at = index.get(itemId);
      if (at === undefined) {
        issues.push(`item_sets.${set.id}: item ${itemId} is not in the bundle`);
        continue;
      }
      const owner = claimed.get(itemId);
      if (owner && owner !== set.id) {
        issues.push(`item_sets.${set.id}: item ${itemId} already belongs to set ${owner}`);
      }
      claimed.set(itemId, set.id);
      positions.push(at);
    }
    positions.sort((a, b) => a - b);
    for (let i = 1; i < positions.length; i++) {
      if (positions[i] !== positions[i - 1]! + 1) {
        issues.push(`item_sets.${set.id}: items are not contiguous in the bundle`);
        break;
      }
    }
  }
  return issues;
}

// Client paging (docs/client-paging-design.md, D-1): how the student moves
// through the test — one scrolling page (the default, and everything
// authored before the setting existed) or one question at a time. Absent
// means scroll on both bundles, so older files and older clients keep
// their behaviour by construction.
export const StudentLayoutSchema = z.enum(["scroll", "paged"]);
export type StudentLayout = z.infer<typeof StudentLayoutSchema>;

export const ItemBundleSchema = z.object({
  test_id: z.string().min(1),
  title: z.string(),
  items: z.array(ItemSchema),
  // Client paging: emitted only when `paged`, keeping older bundles byte-stable.
  student_layout: StudentLayoutSchema.optional(),
  // E5 slice 1: optional so every bundle written before it parses unchanged.
  item_sets: z.array(TeacherItemSetSchema).optional(),
  // Map<uuid, asset>. Optional — bundles without image refs omit this.
  // Key shape is validated via .superRefine since z.record's key
  // validator is positional rather than schema-driven.
  assets: z.record(z.string(), BundleAssetSchema).optional(),
  // Slice 21: assessment-level accommodations metadata. Both fields are
  // optional on the wire; the importing side validates IDs against its
  // own catalog and clamps construct_altering to a subset of
  // allowed_accommodations. The bundle layer is permissive on purpose —
  // import code is the chokepoint for catalog drift.
  allowed_accommodations: z.array(z.string()).optional(),
  construct_altering: z.array(z.string()).optional(),
}).superRefine((bundle, ctx) => {
  if (bundle.item_sets) {
    for (const message of itemSetIssues(bundle.items.map((i) => i.id), bundle.item_sets)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["item_sets"], message });
    }
  }
  if (!bundle.assets) return;
  for (const key of Object.keys(bundle.assets)) {
    if (!UUID_RE.test(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assets", key],
        message: `asset key must be a uuid; got "${key}"`,
      });
    }
  }
});

export type Choice = z.infer<typeof ChoiceSchema>;
export type ScoringMethod = z.infer<typeof ScoringMethodSchema>;
export type SingleSelectMCItem = z.infer<typeof SingleSelectMCItemSchema>;
export type MultiSelectMCItem = z.infer<typeof MultiSelectMCItemSchema>;
export type ShortTextItem = z.infer<typeof ShortTextItemSchema>;
export type RubricLevel = z.infer<typeof RubricLevelSchema>;
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;
export type Rubric = z.infer<typeof RubricSchema>;
export type EssayItem = z.infer<typeof EssayItemSchema>;
export type MatchPair = z.infer<typeof MatchPairSchema>;
export type MatchItem = z.infer<typeof MatchItemSchema>;
export type SequenceEntry = z.infer<typeof SequenceEntrySchema>;
export type OrderItem = z.infer<typeof OrderItemSchema>;
export type HotspotRegion = z.infer<typeof HotspotRegionSchema>;
export type HotspotItem = z.infer<typeof HotspotItemSchema>;
export type DrawingCanvasBackground = z.infer<typeof DrawingCanvasBackgroundSchema>;
export type DrawingCanvas = z.infer<typeof DrawingCanvasSchema>;
export type DrawingUploadItem = z.infer<typeof DrawingUploadItemSchema>;
export type TableColumn = z.infer<typeof TableColumnSchema>;
export type TableRow = z.infer<typeof TableRowSchema>;
export type TableCellKeys = z.infer<typeof TableCellKeysSchema>;
export type TableItem = z.infer<typeof TableItemSchema>;
export type Item = z.infer<typeof ItemSchema>;
export type BundleAsset = z.infer<typeof BundleAssetSchema>;
export type ItemBundle = z.infer<typeof ItemBundleSchema>;
