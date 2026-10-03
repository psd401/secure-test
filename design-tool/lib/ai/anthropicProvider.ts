import { anthropicClient } from "./anthropicClient";
import {
  ITEM_MAX_TOKENS,
  buildUserText,
  itemSystemBlocks,
  parseItemText,
} from "./itemGenCore";
import { BATCH_MAX_TOKENS, BATCH_SYSTEM_PROMPT, buildBatchUserText, parseBatchArray } from "./itemBatchCore";
import {
  SUGGEST_MAX_TOKENS,
  SUGGEST_SYSTEM_PROMPT,
  buildSuggestUserText,
  parseSuggestArray,
} from "./standardsSuggestCore";
import { extractFirstText, wrapProviderError } from "./sdkResponse";
import { parseReportObject, type ClassInsightsPackInput } from "@/lib/insights/report";
import {
  CLASS_INSIGHTS_MAX_TOKENS,
  CLASS_INSIGHTS_SYSTEM_PROMPT,
  buildClassInsightsUserText,
} from "@/lib/insights/reportPrompt";
import type {
  BatchGenerateInput,
  GenerateItemRequest,
  GenerateItemResult,
  ItemGeneratorProvider,
  SuggestStandardsInput,
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

  // BG slice 3. The Messages API reads a PDF as a base64 document block; it
  // has no DOCX block, so a DOCX resource is refused on this (dev-only) path —
  // Bedrock is the deployed provider and reads both.
  async generateItems(input: BatchGenerateInput): Promise<unknown[]> {
    const client = anthropicClient("AI_PROVIDER=anthropic");
    const model = process.env.ANTHROPIC_ITEM_MODEL ?? DEFAULT_MODEL;
    const doc = input.resource && "document" in input.resource ? input.resource.document : undefined;
    if (doc && (doc.format ?? "pdf") !== "pdf") {
      throw new Error(`anthropic_document_format_unsupported: ${doc.format}`);
    }

    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: BATCH_MAX_TOKENS,
        system: BATCH_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              ...(doc
                ? [
                    {
                      type: "document" as const,
                      source: {
                        type: "base64" as const,
                        media_type: "application/pdf" as const,
                        data: Buffer.from(doc.bytes).toString("base64"),
                      },
                    },
                  ]
                : []),
              { type: "text" as const, text: buildBatchUserText(input) },
            ],
          },
        ],
      });
    } catch (err) {
      wrapProviderError(err, "anthropic");
    }

    return parseBatchArray(extractFirstText(response.content, "anthropic"), "anthropic", {
      truncated: response.stop_reason === "max_tokens",
    });
  },

  // BG slice 5: one Messages turn for up to 40 untagged items.
  async suggestStandards(input: SuggestStandardsInput): Promise<unknown[]> {
    const client = anthropicClient("AI_PROVIDER=anthropic");
    const model = process.env.ANTHROPIC_ITEM_MODEL ?? DEFAULT_MODEL;
    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: SUGGEST_MAX_TOKENS,
        system: SUGGEST_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildSuggestUserText(input) }],
      });
    } catch (err) {
      wrapProviderError(err, "anthropic");
    }
    return parseSuggestArray(extractFirstText(response.content, "anthropic"), "anthropic", {
      truncated: response.stop_reason === "max_tokens",
    });
  },

  // Class insights slice 2 (dev path): one Messages turn on the evidence pack.
  async generateClassInsights(pack: ClassInsightsPackInput): Promise<unknown> {
    const client = anthropicClient("AI_PROVIDER=anthropic");
    const model = process.env.ANTHROPIC_ITEM_MODEL ?? DEFAULT_MODEL;
    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: CLASS_INSIGHTS_MAX_TOKENS,
        system: CLASS_INSIGHTS_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildClassInsightsUserText(pack) }],
      });
    } catch (err) {
      wrapProviderError(err, "anthropic");
    }
    return parseReportObject(extractFirstText(response.content, "anthropic"), "anthropic", {
      truncated: response.stop_reason === "max_tokens",
    });
  },
};
