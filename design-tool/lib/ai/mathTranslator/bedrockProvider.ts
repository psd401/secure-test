import { converseText } from "../bedrockConverse";
import { MATH_MAX_TOKENS, MATH_SYSTEM_PROMPT, finalizeLatex } from "./mathCore";
import type {
  MathTranslatorProvider,
  TranslateMathRequest,
  TranslateMathResult,
} from "./types";

// Amazon Bedrock math notation translator (ADR 0011), built on the AWS SDK
// Converse API with SigV4 — emulating the social-stories project. Plain
// text-in / LaTeX-out (no tool needed). Default model is the Haiku 4.5 `us.`
// cross-region inference profile; override via BEDROCK_MATH_MODEL.
// temperature 0 keeps the conversion deterministic.

const DEFAULT_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

export const bedrockMathTranslator: MathTranslatorProvider = {
  // Lazy so tests can configure BEDROCK_MATH_MODEL after import.
  get id() {
    return `bedrock-${process.env.BEDROCK_MATH_MODEL ?? DEFAULT_MODEL}`;
  },

  async translate(
    req: TranslateMathRequest,
    ownerSub?: string,
  ): Promise<TranslateMathResult> {
    const text = await converseText({
      modelId: process.env.BEDROCK_MATH_MODEL ?? DEFAULT_MODEL,
      systemText: MATH_SYSTEM_PROMPT,
      userText: req.prompt,
      maxTokens: MATH_MAX_TOKENS,
      temperature: 0,
      errPrefix: "bedrock",
      surface: "math-translate",
      ownerSub,
    });
    return { latex: finalizeLatex(text, "bedrock") };
  },
};
