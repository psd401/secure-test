import { anthropicClient } from "./anthropicClient";
import {
  ITEM_MAX_TOKENS,
  buildUserText,
  itemSystemBlocks,
  parseItemText,
} from "./itemGenCore";
import { extractFirstText, wrapProviderError } from "./sdkResponse";
import type {
  GenerateItemRequest,
  GenerateItemResult,
  ItemGeneratorProvider,
} from "./types";

// Direct Anthropic-API item generator. Default model is Claude Sonnet 4.6
// per ADR 0007 (item authoring sweet spot for quality vs. cost).
// Overridable via ANTHROPIC_ITEM_MODEL for cost-tuning or A/B testing.
//
// The prompt, request shaping, response parsing, and error formatting are
// shared with the Bedrock provider via ./itemGenCore — only the client and
// model id differ here.

const DEFAULT_MODEL = "claude-sonnet-4-6";

export const anthropicItemProvider: ItemGeneratorProvider = {
  // Lazy so tests / runtime can set ANTHROPIC_ITEM_MODEL after import.
  get id() {
    return `anthropic-${process.env.ANTHROPIC_ITEM_MODEL ?? DEFAULT_MODEL}`;
  },

  async generateItem(req: GenerateItemRequest): Promise<GenerateItemResult> {
    const client = anthropicClient("AI_PROVIDER=anthropic");
    const model = process.env.ANTHROPIC_ITEM_MODEL ?? DEFAULT_MODEL;

    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: ITEM_MAX_TOKENS,
        system: itemSystemBlocks(),
        messages: [{ role: "user", content: buildUserText(req) }],
      });
    } catch (err) {
      wrapProviderError(err, "anthropic");
    }

    return parseItemText(extractFirstText(response.content, "anthropic"), "anthropic");
  },
};
