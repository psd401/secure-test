import { z } from "zod";

// Slice 35: a student's answer to one item, stored in the design-tool's
// `responses.response` jsonb column and (later) carried on the wire from the
// student app. Discriminated by the same `type` literals as ItemSchema —
// `response.type` must equal the answered item's `type`; that invariant is
// enforced at the write boundary (lib/dev/seedAttempts.ts today; the Phase 3
// scoring reads and the future ingest API check it too), not by the column.
// snake_case keys per ADR 0002.
//
// Shape mirrors the item schemas' correct-answer fields:
//   multiple_choice_single.correct_choice_id  → choice_id
//   multiple_choice_multi.correct_choice_ids  → choice_ids
//   short_text.correct_answer                 → text
// An unanswered item simply has no responses row — there is no "empty"
// response variant. `text` may still be "" (a student can submit a blank);
// blank-vs-missing is a scoring policy question (slice 37), not a schema one.

export const SingleChoiceResponseSchema = z.object({
  type: z.literal("multiple_choice_single"),
  choice_id: z.string().min(1),
});

export const MultiChoiceResponseSchema = z.object({
  type: z.literal("multiple_choice_multi"),
  choice_ids: z.array(z.string().min(1)).min(1),
});

export const ShortTextResponseSchema = z.object({
  type: z.literal("short_text"),
  text: z.string(),
});

export const EssayResponseSchema = z.object({
  type: z.literal("essay"),
  text: z.string(),
});

// Phase 4 slice 47: matching. Keys are the item's pair ids (the left
// side); values are the pair id whose RIGHT side the student matched to
// that left. A fully correct response maps every pair id to itself.
export const MatchResponseSchema = z.object({
  type: z.literal("match"),
  matches: z.record(z.string().min(1), z.string().min(1)),
});

// Phase 4 slice 48: ordering. The student's arrangement as sequence-entry
// ids, first to last. Fully correct = the item's authored sequence order.
export const OrderResponseSchema = z.object({
  type: z.literal("order"),
  ordered_ids: z.array(z.string().min(1)).min(1),
});

// Phase 4 slice 49: hotspot. The region id(s) the student marked.
export const HotspotResponseSchema = z.object({
  type: z.literal("hotspot"),
  region_ids: z.array(z.string().min(1)).min(1),
});

// Slice 65: drawing/upload. The response is a REFERENCE to an uploaded file,
// never the bytes — a student's scan or sketch goes to object storage through a
// presigned PUT, and only its id travels in the JSON body. The upload is
// registered server-side before the file exists, so `upload_id` names a row the
// server minted rather than anything the client chose.
//
// This is why the type was absent from this union until now (see the
// DrawingUploadItemSchema note in items.ts): it needed the upload registry, and
// that needed the attempt.
export const DrawingUploadResponseSchema = z.object({
  type: z.literal("drawing_upload"),
  upload_id: z.string().min(1),
});

// E3 slice 1: a table answer is the cells the student filled — row id →
// column id → text, mirroring `cell_keys` on the item. A table with every
// cell blank is the ABSENCE of a response (the match rule), so at least one
// cell must be present; a present cell may still be "" (the student cleared
// it after the client posted it) — blank-vs-missing is scoring's call, as
// for short_text. Cell text is capped: a cell is a number or a phrase, not
// an essay.
export const TableResponseSchema = z.object({
  type: z.literal("table"),
  cells: z
    .record(z.string().min(1), z.record(z.string().min(1), z.string().max(500)))
    .refine(
      (cells) => Object.values(cells).some((row) => Object.keys(row).length > 0),
      { message: "a table response needs at least one cell" },
    ),
});

export const ItemResponseSchema = z.discriminatedUnion("type", [
  SingleChoiceResponseSchema,
  MultiChoiceResponseSchema,
  ShortTextResponseSchema,
  EssayResponseSchema,
  MatchResponseSchema,
  OrderResponseSchema,
  HotspotResponseSchema,
  DrawingUploadResponseSchema,
  TableResponseSchema,
]);

export type SingleChoiceResponse = z.infer<typeof SingleChoiceResponseSchema>;
export type MultiChoiceResponse = z.infer<typeof MultiChoiceResponseSchema>;
export type ShortTextResponse = z.infer<typeof ShortTextResponseSchema>;
export type EssayResponse = z.infer<typeof EssayResponseSchema>;
export type MatchResponse = z.infer<typeof MatchResponseSchema>;
export type OrderResponse = z.infer<typeof OrderResponseSchema>;
export type HotspotResponse = z.infer<typeof HotspotResponseSchema>;
export type DrawingUploadResponse = z.infer<typeof DrawingUploadResponseSchema>;
export type TableResponse = z.infer<typeof TableResponseSchema>;
export type ItemResponse = z.infer<typeof ItemResponseSchema>;
