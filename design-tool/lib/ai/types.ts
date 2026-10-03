import { z } from "zod";
import type { ConverseDocument } from "@/lib/ai/bedrockConverse";
import { MAX_RUBRIC_TEXT_CHARS } from "@/lib/ai/rubricExtractor/types";
import { CreateItemBody, StandardsField } from "@/lib/api/items";
import type { ClassInsightsPackInput } from "@/lib/insights/report";

// Slice 47: pinned list instead of z.enum(ITEM_TYPES) so new item types
// don't silently become AI-generable. match/order/hotspot/drawing (and future
// structural types) are authoring-only — the providers' prompts/tools only
// know these three.
//
// E18: `essay` used to be listed here even though NO provider implements it.
// The mock fell through its short_text/MC branches and returned a canned
// multiple_choice_multi — the caller asked for an essay and got a four-option
// MC item. The Bedrock provider put `essay` in its tool enum, so the model was
// invited to emit an essay shape that CreateItemBody then rejected: a 502
// after a paid inference call. The client allowlist in AssessmentEditor.tsx
// never offered essay; the server enum now matches it exactly.
export const AI_GENERABLE_ITEM_TYPES = [
  "multiple_choice_single",
  "multiple_choice_multi",
  "short_text",
] as const;

export const GenerateItemRequest = z.object({
  assessment_id: z.string().uuid(),
  item_type: z.enum(AI_GENERABLE_ITEM_TYPES),
  prompt: z.string().min(1).max(4000),
});
export type GenerateItemRequest = z.infer<typeof GenerateItemRequest>;

// BG slice 3 (docs/batch-item-generation-design.md, D-3 … D-7): batch
// generation. D-7 names FOUR types for v1 — the three above plus essay. The
// single-item list stays at three (E18: its providers have no essay shape);
// the batch prompt carries an essay shape of its own, without a rubric (D-6).
//
// BG slice 6 (D-7, "match next"): match joins the batch list, but NOT "mix" —
// a mix stays the four types above, and match comes only when the teacher
// asks for it by count. Its key is the pair list itself (keyed by structure).
export const BATCH_MIX_ITEM_TYPES = [
  ...AI_GENERABLE_ITEM_TYPES,
  "essay",
] as const;
export const BATCH_GENERABLE_ITEM_TYPES = [...BATCH_MIX_ITEM_TYPES, "match"] as const;
export type BatchGenerableItemType = (typeof BATCH_GENERABLE_ITEM_TYPES)[number];

/** D-3: at most ten proposals per call. */
export const MAX_BATCH_COUNT = 10;
export const MAX_BATCH_OBJECTIVE_CHARS = 500;
export const MAX_BATCH_NOTES_CHARS = 2000;
/** Pasted source material: the rubric upload's text cap (D-4). */
export const MAX_BATCH_RESOURCE_CHARS = MAX_RUBRIC_TEXT_CHARS;

export const BATCH_DIFFICULTIES = ["mixed", "easier", "on_level", "harder"] as const;
export type BatchDifficulty = (typeof BATCH_DIFFICULTIES)[number];

const TypeCount = z.number().int().min(0).max(MAX_BATCH_COUNT).optional();

/** A per-type count map; strict, so another structural type (order, …) is a 400. */
export const BatchTypeCounts = z
  .object({
    multiple_choice_single: TypeCount,
    multiple_choice_multi: TypeCount,
    short_text: TypeCount,
    essay: TypeCount,
    match: TypeCount,
  })
  .strict();
export type BatchTypeCounts = z.infer<typeof BatchTypeCounts>;

// Blank optional text reads as absent, so "objective": "  " is no focus.
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

/**
 * The JSON body. A PDF / DOCX resource arrives as a multipart `file` beside
 * this body (sent as the `request` form field), so the "at least one of
 * target / resource / notes" rule is `hasBatchFocus`, which the route applies
 * once it knows whether a file came with the request.
 */
export const GenerateItemsRequest = z
  .object({
    assessment_id: z.string().uuid(),
    count: z.number().int().min(1).max(MAX_BATCH_COUNT),
    types: z.union([z.literal("mix"), BatchTypeCounts]).default("mix"),
    target: z
      .object({
        standards: StandardsField.optional(),
        objective: OptionalText(MAX_BATCH_OBJECTIVE_CHARS),
      })
      .optional(),
    difficulty: z.enum(BATCH_DIFFICULTIES).default("mixed"),
    notes: OptionalText(MAX_BATCH_NOTES_CHARS),
    resource: z
      .object({ text: z.string().trim().min(1).max(MAX_BATCH_RESOURCE_CHARS) })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.types === "mix") return;
    const sum = Object.values(v.types).reduce<number>((a, n) => a + (n ?? 0), 0);
    if (sum !== v.count) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["types"],
        message: `type counts sum to ${sum}, not count (${v.count})`,
      });
    }
  });
export type GenerateItemsRequest = z.infer<typeof GenerateItemsRequest>;

/** At least one of a standard, an objective, a resource or notes. */
export function hasBatchFocus(req: GenerateItemsRequest, hasFile: boolean): boolean {
  return (
    hasFile ||
    req.resource !== undefined ||
    req.notes !== undefined ||
    req.target?.objective !== undefined ||
    (req.target?.standards?.length ?? 0) > 0
  );
}

/** A requested tag, resolved for the prompt (lib/ai/itemBatchCore.ts). */
export interface TargetStandard {
  /** As stored on the item: `wa2026:M.7.R.RP.2`, or a custom designation. */
  tag: string;
  /** Shown to the model: the code without its scheme, or the custom text. */
  code: string;
  /** Catalog label ("Washington 2026") or null for a custom designation. */
  framework: string | null;
  /** Catalog text; null when the catalog does not know the tag. */
  text: string | null;
  /** NGSS clarification + boundary, or a 2011 tag's linked 2026 standards. */
  extra: string[];
}

/** What the route hands a provider: the request, resolved. */
export interface BatchGenerateInput {
  count: number;
  types: "mix" | BatchTypeCounts;
  standards: TargetStandard[];
  objective?: string;
  difficulty: BatchDifficulty;
  notes?: string;
  resource?: { text: string } | { document: ConverseDocument };
  /** Stems already on the assessment, truncated and capped. */
  existingStems: string[];
}

// The provider returns a payload that is shaped identically to a
// CreateItemBody. We keep the discriminated union as the source of truth
// for what is acceptable so any future provider impl (Anthropic, OpenAI,
// Gemini, ...) gets validated the same way the human-edit POST does.
export type GenerateItemResult = z.infer<typeof CreateItemBody>;

// BG slice 5 (docs/batch-item-generation-design.md, D-2): "Suggest standards"
// for UNTAGGED items. Nothing is applied — the route returns suggestions and
// the teacher accepts each one.
export const SUGGEST_MAX_ITEMS = 40;
export const SUGGEST_MAX_TAGS_PER_ITEM = 3;
export const SUGGEST_REASON_CHARS = 160;
/** Pasted unit standards list (1.2: paste only). */
export const MAX_SUGGEST_UNIT_LIST_CHARS = 20000;
/** The candidate list sent to the model never exceeds this (largest slice today: 160). */
export const SUGGEST_MAX_CANDIDATES = 250;

export const SUGGEST_SUBJECTS = ["math", "ela", "science"] as const;
export const SUGGEST_SCHEMES = ["wa2026", "ccss2010"] as const;

/** 1.4: subject + grade band are required — no free-form suggestions. */
export const SuggestStandardsRequest = z.object({
  assessment_id: z.string().uuid(),
  subject: z.enum(SUGGEST_SUBJECTS),
  grade_band: z.string().trim().min(1).max(20),
  course: OptionalText(80),
  scheme: z.enum(SUGGEST_SCHEMES).optional(),
  unit_list: OptionalText(MAX_SUGGEST_UNIT_LIST_CHARS),
});
export type SuggestStandardsRequest = z.infer<typeof SuggestStandardsRequest>;

/** One catalog standard offered to the model; `tag` is the stored form. */
export interface SuggestCandidate {
  tag: string;
  code: string;
  text: string;
}

/** One untagged item as the model sees it; `ref` is its short id in the prompt. */
export interface SuggestItemInput {
  ref: number;
  id: string;
  type: string;
  stem: string;
  choices: string[];
}

/** What the route hands a provider: the items, the candidate set, the pasted list. */
export interface SuggestStandardsInput {
  items: SuggestItemInput[];
  candidates: SuggestCandidate[];
  /** "Washington 2026" etc., for the prompt. */
  framework: string;
  unitList?: string;
}

export interface ItemGeneratorProvider {
  /**
   * Human-readable provider id used in logs and the response payload, e.g.
   * "mock", "anthropic-sonnet-4-6", "openai-gpt-5-1".
   */
  readonly id: string;
  /**
   * `ownerSub` (docs/rubric-upload-design.md D-7) rides along for the
   * `ai_usage` log line's spend-per-teacher field; providers with nothing
   * to log (the mock) ignore it.
   */
  generateItem(
    req: GenerateItemRequest,
    ownerSub?: string,
  ): Promise<GenerateItemResult>;
  /**
   * BG slice 3: one call, up to ten items. Returns the model's array RAW —
   * `validateBatchProposals` (lib/ai/itemBatchCore.ts) is the one place an
   * element becomes a CreateItemBody, so one malformed element drops alone.
   */
  generateItems(input: BatchGenerateInput, ownerSub?: string): Promise<unknown[]>;
  /**
   * BG slice 5: one call for up to 40 untagged items. Returns the model's
   * array RAW — `validateSuggestions` (lib/ai/standardsSuggestCore.ts) is the
   * one place a code becomes a tag, and drops anything outside the candidates.
   */
  suggestStandards(input: SuggestStandardsInput, ownerSub?: string): Promise<unknown[]>;
  /**
   * Class insights slice 2 (docs/class-insights-design.md): one call on the
   * evidence pack — WITHOUT its hash, and never with names (they stay in the
   * server's pseudonym map). Returns the model's reply object RAW;
   * `fillReport` (lib/insights/report.ts) is the one place a claim is
   * checked, filled or dropped.
   */
  generateClassInsights(pack: ClassInsightsPackInput, ownerSub?: string): Promise<unknown>;
}
