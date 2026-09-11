import { z } from "zod";
import { CreateItemBody } from "@/lib/api/items";

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

// The provider returns a payload that is shaped identically to a
// CreateItemBody. We keep the discriminated union as the source of truth
// for what is acceptable so any future provider impl (Anthropic, OpenAI,
// Gemini, ...) gets validated the same way the human-edit POST does.
export type GenerateItemResult = z.infer<typeof CreateItemBody>;

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
}
