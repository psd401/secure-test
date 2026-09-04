import type { Tool } from "@aws-sdk/client-bedrock-runtime";
import { AI_GENERABLE_ITEM_TYPES } from "@/lib/ai/types";
import { converseTool } from "./bedrockConverse";
import {
  ITEM_MAX_TOKENS,
  ITEM_SYSTEM_PROMPT,
  buildUserText,
} from "./itemGenCore";
import type {
  GenerateItemRequest,
  GenerateItemResult,
  ItemGeneratorProvider,
} from "./types";

// Amazon Bedrock item generator (ADR 0007), built on the AWS SDK Converse API
// with SigV4 + tool-forced structured output — emulating the social-stories
// project. Default model is the Sonnet 4.6 `us.` cross-region inference profile;
// override via BEDROCK_ITEM_MODEL. Output is still re-validated by the route's
// CreateItemBody.safeParse, so the tool schema below is permissive and a
// tolerant normalizer maps it to the discriminated-union shape.

const DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-6";

const emitItemTool: Tool = {
  toolSpec: {
    name: "emit_item",
    description: "Return the finished assessment item in structured form.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          type: {
            type: "string",
            // Slice 47: only the AI-generable types — the tool contract must
            // not offer structural types (match) the emit shape can't carry.
            enum: [...AI_GENERABLE_ITEM_TYPES],
            description: "The item type.",
          },
          stem: {
            type: "string",
            description: "The question text; supports $...$ KaTeX math.",
          },
          choices: {
            type: "array",
            description:
              "Answer choices for multiple-choice items; empty for short_text.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Lowercase letter id (a, b, c, d)." },
                text: { type: "string" },
              },
              required: ["id", "text"],
            },
          },
          correct_choice_ids: {
            type: "array",
            description:
              "Ids of the correct choice(s) for MC items; empty for short_text.",
            items: { type: "string" },
          },
          correct_answer: {
            type: "string",
            description:
              "Canonical expected answer for short_text; omit for MC items.",
          },
        },
        required: ["type", "stem", "choices", "correct_choice_ids"],
      },
    },
  },
};

// Claude occasionally serializes a nested tool-input array as a JSON string;
// coerce it back so the API contract stays clean (same guard as social-stories).
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeItem(input: Record<string, unknown>): GenerateItemResult {
  const type = input.type;
  const stem = typeof input.stem === "string" ? input.stem : "";

  if (type === "short_text") {
    return {
      type: "short_text",
      stem,
      choices: [],
      correct_choice_ids: [],
      correct_answer:
        typeof input.correct_answer === "string" ? input.correct_answer : "",
    } as GenerateItemResult;
  }

  const choices = asArray(input.choices).map((raw) => {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return { id: String(o.id ?? ""), text: String(o.text ?? "") };
  });
  const correct_choice_ids = asArray(input.correct_choice_ids).filter(
    (x): x is string => typeof x === "string",
  );

  // Pass `type` through verbatim (the route's CreateItemBody.safeParse rejects
  // any value outside the discriminated union).
  return {
    type,
    stem,
    choices,
    correct_choice_ids,
    correct_answer: null,
  } as GenerateItemResult;
}

export const bedrockItemProvider: ItemGeneratorProvider = {
  // Lazy so tests / runtime can set BEDROCK_ITEM_MODEL after import.
  get id() {
    return `bedrock-${process.env.BEDROCK_ITEM_MODEL ?? DEFAULT_MODEL}`;
  },

  async generateItem(req: GenerateItemRequest): Promise<GenerateItemResult> {
    const input = await converseTool({
      modelId: process.env.BEDROCK_ITEM_MODEL ?? DEFAULT_MODEL,
      systemText: ITEM_SYSTEM_PROMPT,
      userText: buildUserText(req),
      maxTokens: ITEM_MAX_TOKENS,
      tool: emitItemTool,
      errPrefix: "bedrock",
    });
    return normalizeItem(input);
  },
};
