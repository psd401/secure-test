import { z } from "zod";
import { ItemResponseSchema } from "./responses.js";
import {
  BundleAssetSchema,
  ChoiceSchema,
  DrawingCanvasSchema,
  HotspotRegionSchema,
  ItemSetSchema,
  RubricSchema,
  SequenceEntrySchema,
  StudentLayoutSchema,
  TableColumnSchema,
  TableRowSchema,
  itemSetIssues,
} from "./items.js";

// Slice 51: the STUDENT-facing wire format, deliberately a different type from
// ItemBundleSchema rather than a filtered view of it.
//
// ItemBundleSchema serves teacher-to-teacher share/backup, so it must carry the
// answer keys (POST /api/assessments/import reads them straight back). A bundle
// that reaches a student's machine must not. One schema cannot be both: the
// safe default for one audience is the lossy default for the other, and the
// export route's own note about hidden rubrics says why a flag is not enough —
// "the bundle is a file on the student's machine, so a flag only holds if every
// future client honors it". Two types means the student path cannot express a
// key at all, rather than relying on a caller to remember to drop it.
//
// What is omitted relative to ItemSchema:
//   multiple_choice_single  correct_choice_id
//   multiple_choice_multi   correct_choice_ids
//   short_text              correct_answer
//   hotspot                 correct_region_ids  (regions stay — needed to render)
//   essay                   rubric only when student_visibility.during_test
//   match / order           see the shape change below
//   table                   cell_keys  (columns / rows / corner stay — needed
//                           to draw the grid; E3 slice 1)
//   ALL                     scoring_method — not a key, but it telegraphs
//                           whether an item is AI- or human-scored.
//
// match and order could not be handled by dropping a field. MatchItemSchema's
// `pairs` puts each left beside its own correct right in one object, and
// OrderItemSchema's `sequence` is by definition the correct order; shuffling
// either array is cosmetic while the association survives. So the delivery
// shape splits them: match carries `lefts` and `rights` as independent arrays,
// order carries `entries`.
//
// Slice 51 populates the ids in those arrays with the authoring ids, which a
// student reading the bundle could still correlate. Closing that needs a
// per-attempt id map held server-side, which needs the session/attempt instance
// that arrives with the student plane. The SHAPE here is already final, so that
// later work swaps opaque ids in without a wire change or a client rewrite.
// Until then: order/match keys are obscured against casual reading, not sealed.

const baseDeliveryItem = {
  id: z.string().min(1),
  stem: z.string(),
};

export const DeliverySingleSelectMCItemSchema = z.object({
  type: z.literal("multiple_choice_single"),
  ...baseDeliveryItem,
  choices: z.array(ChoiceSchema).min(2),
});

export const DeliveryMultiSelectMCItemSchema = z.object({
  type: z.literal("multiple_choice_multi"),
  ...baseDeliveryItem,
  choices: z.array(ChoiceSchema).min(2),
});

export const DeliveryShortTextItemSchema = z.object({
  type: z.literal("short_text"),
  ...baseDeliveryItem,
});

export const DeliveryEssayItemSchema = z.object({
  type: z.literal("essay"),
  ...baseDeliveryItem,
  max_word_count: z.number().int().positive().optional(),
  placeholder: z.string().max(200).optional(),
  // Present only for rubrics the teacher marked visible during the test; the
  // route drops the rest before it ever gets here.
  rubric: RubricSchema.optional(),
});

// `lefts` and `rights` are the same {id, text} shape as choices — reusing
// ChoiceSchema keeps one option type across the format. The client renders
// lefts in order and rights as the pool to match against.
export const DeliveryMatchItemSchema = z.object({
  type: z.literal("match"),
  ...baseDeliveryItem,
  lefts: z.array(ChoiceSchema).min(2),
  rights: z.array(ChoiceSchema).min(2),
});

// Reuses SequenceEntrySchema ({id, label}) — same entry type as authoring; only
// the guarantee about the array's order is dropped.
export const DeliveryOrderItemSchema = z.object({
  type: z.literal("order"),
  ...baseDeliveryItem,
  entries: z.array(SequenceEntrySchema).min(2),
});

export const DeliveryHotspotItemSchema = z.object({
  type: z.literal("hotspot"),
  ...baseDeliveryItem,
  image_asset_id: z.string().min(1).nullable().optional(),
  regions: z.array(HotspotRegionSchema).default([]),
});

export const DeliveryDrawingUploadItemSchema = z.object({
  type: z.literal("drawing_upload"),
  ...baseDeliveryItem,
  prompt_asset_id: z.string().min(1).nullable().optional(),
  canvas: DrawingCanvasSchema.nullable().optional(),
});

// E3 slice 1: the grid without its keys. There is no field here that can
// hold a cell's expected text, so a caller that forgets to drop `cell_keys`
// has it stripped rather than shipped (the test in delivery.test.ts).
export const DeliveryTableItemSchema = z.object({
  type: z.literal("table"),
  ...baseDeliveryItem,
  columns: z.array(TableColumnSchema).min(1),
  rows: z.array(TableRowSchema).min(1),
  corner: z.string().optional(),
});

// No z.preprocess type-defaulting here. ItemSchema carries that for PoC-B
// fixtures that predate the `type` field; a delivery bundle has no legacy
// producers, so an untyped item is a bug and should fail loudly.
export const DeliveryItemSchema = z.discriminatedUnion("type", [
  DeliverySingleSelectMCItemSchema,
  DeliveryMultiSelectMCItemSchema,
  DeliveryShortTextItemSchema,
  DeliveryEssayItemSchema,
  DeliveryMatchItemSchema,
  DeliveryOrderItemSchema,
  DeliveryHotspotItemSchema,
  DeliveryDrawingUploadItemSchema,
  DeliveryTableItemSchema,
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// E12 slice 1: a set whose stimulus should be this student's own earlier
// answer but no saved answer exists yet — the client turns the stimulus
// block into a writing area (design D-4). The resolved text, when it
// exists, simply rides `stimulus`; the student bundle never names the
// source (ADR 0016).
export const DeliveryItemSetSchema = ItemSetSchema.extend({
  source_missing: z.boolean().optional(),
  // E12 slice 3: where the client posts the outline the student writes in
  // place (the source question's id — an identifier only, never a key),
  // and the text they have written there so far, so the area is editable.
  // Present whenever the set is source-backed and the answer did not come
  // from the source assessment itself.
  inline_item_id: z.string().min(1).optional(),
  inline_text: z.string().optional(),
});
export type DeliveryItemSet = z.infer<typeof DeliveryItemSetSchema>;

export const DeliveryBundleSchema = z
  .object({
    test_id: z.string().min(1),
    title: z.string(),
    items: z.array(DeliveryItemSchema),
    // E5 slice 1: stimuli and which items share them. Student-facing by
    // definition, so the same shape as the teacher bundle; optional so a
    // client that predates it keeps parsing.
    item_sets: z.array(DeliveryItemSetSchema).optional(),
    // Same base64 blob map as ItemBundleSchema — a student client is the
    // offline consumer this was built for.
    assets: z.record(z.string(), BundleAssetSchema).optional(),
    // Slice 62: the EFFECTIVE accommodations for the student this bundle was
    // built for — tool_id → setting value — not the assessment's allowed list.
    //
    // A map rather than an array because the value carries meaning: a client
    // told only that `color_contrast` is on still does not know whether to
    // render Black on Rose or Black on White, and `optional_font` is useless
    // without the font. The authoring-side `allowed_accommodations` is the
    // gate that produced this set, and is an authoring concept the student
    // has no use for, so it does not ride along.
    accommodations: z.record(z.string(), z.string()).optional(),
    // The subset of `accommodations` this assessment marks construct-altering.
    construct_altering: z.array(z.string()).optional(),
    // Slice 69: may the student cut, copy or paste during this assessment?
    //
    // Emitted only when TRUE, so the absence of the field means locked — a
    // client that has not heard of this flag stays closed rather than open,
    // which is the correct direction for a default in a secure-testing browser.
    allow_clipboard: z.boolean().optional(),
    // Client paging (docs/client-paging-design.md): emitted only as "paged".
    // Absent means one scrolling page — a client that predates the field
    // renders as it always has.
    layout: StudentLayoutSchema.optional(),
    // Client paging follow-up (D-4): the ids of THIS attempt's questions
    // that already hold a saved answer, so a student who relaunches sees
    // honest marks on the page strip and the review page. Per-student
    // state, never a key; emitted only when there is at least one.
    answered_item_ids: z.array(z.string().min(1)).optional(),
    // P-1 (docs/resume-prefill-design.md): THIS attempt's own saved answers,
    // keyed by item id, so a student who relaunches finds the fields under
    // those marks filled rather than blank. The values are exactly the
    // shapes a student POSTs (ItemResponseSchema), which is the whole point
    // of reusing that union here: the field can hold nothing but a student's
    // own answer, so it cannot become a second route for a key. Fed from the
    // `responses` rows and nowhere else — `items.config` is never read for it
    // (ADR 0016 untouched). Match and order values carry the same per-attempt
    // opaque ids the item's own `lefts` / `rights` / `entries` carry.
    // Emitted only when there is at least one.
    saved_responses: z.record(z.string().min(1), ItemResponseSchema).optional(),
    // The drawing bytes those responses name, keyed by upload id — the same
    // base64 blob shape as `assets`, and inlined for the same reason (an
    // offline-shaped bundle with no second fetch and no host→page channel).
    // Only a `complete`, image/png-or-jpeg, at-most-2 MB upload rides along;
    // beyond that the response is still listed and the client shows the
    // answer as saved without the picture. Emitted only when non-empty.
    saved_uploads: z.record(z.string(), BundleAssetSchema).optional(),
  })
  .superRefine((bundle, ctx) => {
    if (bundle.item_sets) {
      for (const message of itemSetIssues(bundle.items.map((i) => i.id), bundle.item_sets)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["item_sets"], message });
      }
    }
    // Both blob maps are keyed by a server-minted uuid (`assets` by asset id,
    // `saved_uploads` by response_uploads id), so the same check guards both:
    // a key that is not a uuid is a caller inventing identifiers.
    for (const field of ["assets", "saved_uploads"] as const) {
      const blobs = bundle[field];
      if (!blobs) continue;
      for (const key of Object.keys(blobs)) {
        if (!UUID_RE.test(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, key],
            message: `${field === "assets" ? "asset" : "upload"} key must be a uuid; got "${key}"`,
          });
        }
      }
    }
  });

export type DeliverySingleSelectMCItem = z.infer<typeof DeliverySingleSelectMCItemSchema>;
export type DeliveryMultiSelectMCItem = z.infer<typeof DeliveryMultiSelectMCItemSchema>;
export type DeliveryShortTextItem = z.infer<typeof DeliveryShortTextItemSchema>;
export type DeliveryEssayItem = z.infer<typeof DeliveryEssayItemSchema>;
export type DeliveryMatchItem = z.infer<typeof DeliveryMatchItemSchema>;
export type DeliveryOrderItem = z.infer<typeof DeliveryOrderItemSchema>;
export type DeliveryHotspotItem = z.infer<typeof DeliveryHotspotItemSchema>;
export type DeliveryDrawingUploadItem = z.infer<typeof DeliveryDrawingUploadItemSchema>;
export type DeliveryTableItem = z.infer<typeof DeliveryTableItemSchema>;
export type DeliveryItem = z.infer<typeof DeliveryItemSchema>;
export type DeliveryBundle = z.infer<typeof DeliveryBundleSchema>;
// P-1: the two prefill maps, named so a builder or a client can hold one
// without spelling out the optional-field indirection every time.
export type DeliverySavedResponses = NonNullable<DeliveryBundle["saved_responses"]>;
export type DeliverySavedUploads = NonNullable<DeliveryBundle["saved_uploads"]>;
