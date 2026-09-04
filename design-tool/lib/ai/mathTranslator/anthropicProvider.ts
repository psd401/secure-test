import { anthropicClient } from "../anthropicClient";
import { extractFirstText, wrapProviderError } from "../sdkResponse";
import { MATH_MAX_TOKENS, finalizeLatex, mathSystemBlocks } from "./mathCore";
import type {
  MathTranslatorProvider,
  TranslateMathRequest,
  TranslateMathResult,
} from "./types";

// Direct Anthropic-API math notation translator. Default model is Claude
// Haiku 4.5 per ADR 0011 (fast, cheap, well-suited to short text-in / short
// LaTeX-out). Overridable via ANTHROPIC_MATH_MODEL.
//
// The prompt, request shaping, and LaTeX clean-up are shared with the Bedrock
// translator via ./mathCore — only the client and model id differ here.

const DEFAULT_MODEL = "claude-haiku-4-5";

export const anthropicMathTranslator: MathTranslatorProvider = {
  // Lazy so tests can configure ANTHROPIC_MATH_MODEL after import.
  get id() {
    return `anthropic-${process.env.ANTHROPIC_MATH_MODEL ?? DEFAULT_MODEL}`;
  },

  async translate(req: TranslateMathRequest): Promise<TranslateMathResult> {
    const client = anthropicClient("MATH_TRANSLATOR_PROVIDER=anthropic");
    const model = process.env.ANTHROPIC_MATH_MODEL ?? DEFAULT_MODEL;

    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: MATH_MAX_TOKENS,
        system: mathSystemBlocks(),
        messages: [{ role: "user", content: req.prompt }],
      });
    } catch (err) {
      wrapProviderError(err, "anthropic");
    }

    return {
      latex: finalizeLatex(extractFirstText(response.content, "anthropic"), "anthropic"),
    };
  },
};
