import type { GenerateItemRequest, GenerateItemResult } from "./types";

// Shared item-generation core for the Anthropic-family providers
// (direct Anthropic API + Amazon Bedrock). Both SDKs expose the same
// Messages API, so the system prompt, request shaping, response parsing,
// and error formatting live here once and each provider supplies only its
// own client + model id. See docs/adr/0007-ai-model-selection.md.
//
// Output shape is enforced TWICE:
//   1. The system prompt below describes the JSON shape per item type.
//   2. The route handler (app/api/ai/generate-item/route.ts) re-validates
//      the proposal through `CreateItemBody.safeParse` before returning it
//      to the editor — provider output cannot smuggle a malformed item
//      past the human review step.
//
// PROMPT CACHING IS NOT ACTIVE ON EITHER PROVIDER. This comment used to claim
// the `cache_control` breakpoint below cut per-call input cost to ~0.1×; it
// does not, and it cannot at this prompt size. Two independent reasons:
//
//   1. The prompt is too short to cache. A cache entry is only created once
//      the cacheable prefix reaches a model-specific minimum — 1024 tokens for
//      Sonnet 4.6, our item-gen model. ITEM_SYSTEM_PROMPT is ~2,030 chars,
//      roughly 500-600 tokens. Below the minimum the breakpoint is silently
//      ignored: no error, just `cache_creation_input_tokens: 0` forever. This
//      applies to the direct Anthropic path too — `itemSystemBlocks()` has
//      always been a no-op, not just the Bedrock path.
//   2. Bedrock never sends a breakpoint at all. `cache_control` is the
//      Messages-API shape; the Converse API used by lib/ai/bedrockConverse.ts
//      wants a separate `cachePoint` block in `system`, which we don't send.
//      Bedrock also has no automatic-caching equivalent.
//
// The breakpoint is left in place deliberately: it costs nothing and starts
// working the moment the prompt crosses the minimum. If this prompt ever grows
// past ~1024 tokens, add the Bedrock `cachePoint` block to close reason 2, and
// verify with `cache_read_input_tokens` on a second identical request rather
// than assuming. Do not re-add a cost-saving claim without that measurement.
// See shared/prompt-caching.md for the per-model minimums.

export const ITEM_MAX_TOKENS = 2048;

export const ITEM_SYSTEM_PROMPT = `You are an assessment item authoring assistant for K-12 teachers in Peninsula School District.

Your job: given a teacher's brief and an item type, return a single, well-crafted assessment item as JSON.

OUTPUT FORMAT: Return ONLY a JSON object — no prose, no markdown fences, no commentary. The exact shape depends on the requested item type:

multiple_choice_single (single correct answer):
{
  "type": "multiple_choice_single",
  "stem": "<question text, supports $...$ KaTeX math>",
  "choices": [
    {"id": "a", "text": "<option text>"},
    {"id": "b", "text": "<option text>"},
    {"id": "c", "text": "<option text>"},
    {"id": "d", "text": "<option text>"}
  ],
  "correct_choice_ids": ["<the single correct id>"],
  "correct_answer": null
}

multiple_choice_multi (two or more correct answers):
{
  "type": "multiple_choice_multi",
  "stem": "<question text>",
  "choices": [
    {"id": "a", "text": "<option>"},
    {"id": "b", "text": "<option>"},
    {"id": "c", "text": "<option>"},
    {"id": "d", "text": "<option>"}
  ],
  "correct_choice_ids": ["<all correct ids>"],
  "correct_answer": null
}

short_text (free-form text response):
{
  "type": "short_text",
  "stem": "<question text>",
  "choices": [],
  "correct_choice_ids": [],
  "correct_answer": "<the canonical expected answer>"
}

REQUIREMENTS:
- "stem" must be a complete, unambiguous question rooted in the teacher's brief.
- "choices" ids are lowercase letters starting at "a" (a, b, c, d). Always include 4 choices for MC items.
- For multiple_choice_multi, include at least 2 correct ids.
- Distractors (wrong choices) must be plausible — represent common misconceptions or near-miss reasoning, not obviously wrong throwaways.
- Math: wrap inline expressions in $...$ (single dollars). Available macros include \\frac, \\sqrt, ^, _, \\cdot, \\div, \\plusminus, \\degree, \\percent, \\half, \\third, \\quarter.
- Keep stems and choices age-appropriate for K-12 students.
- Do NOT add fields beyond the shape above. The downstream system will reject extras.`;

export function buildUserText(req: GenerateItemRequest): string {
  return `Item type: ${req.item_type}\n\nTeacher brief:\n${req.prompt}`;
}

// The Messages-API `system` block, shared by every Anthropic-family provider.
export function itemSystemBlocks() {
  return [
    {
      type: "text" as const,
      text: ITEM_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" as const },
    },
  ];
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Tolerate ```json fences in case the model slips into markdown.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  return JSON.parse(candidate);
}

export function parseItemText(
  text: string,
  errPrefix: string,
): GenerateItemResult {
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch (err) {
    throw new Error(
      `${errPrefix}_returned_invalid_json: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
  // Cast to the union shape; the route revalidates through CreateItemBody.safeParse.
  return parsed as GenerateItemResult;
}
