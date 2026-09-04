import { mockMathTranslator } from "./mockProvider";
import { anthropicMathTranslator } from "./anthropicProvider";
import { bedrockMathTranslator } from "./bedrockProvider";
import type { MathTranslatorProvider } from "./types";

// Phase 1.5: Claude Haiku 4.5 wired two ways alongside the mock per ADR
// 0011 — the direct Anthropic API (MATH_TRANSLATOR_PROVIDER=anthropic, needs
// ANTHROPIC_API_KEY) and Amazon Bedrock (MATH_TRANSLATOR_PROVIDER=bedrock,
// needs AWS credentials + region). The mock stays the default so the editor
// works without any key.

export function getMathTranslatorProvider(): MathTranslatorProvider {
  const requested = process.env.MATH_TRANSLATOR_PROVIDER ?? "mock";
  if (requested === "mock") return mockMathTranslator;
  if (requested === "anthropic") return anthropicMathTranslator;
  if (requested === "bedrock") return bedrockMathTranslator;
  throw new Error(
    `MATH_TRANSLATOR_PROVIDER="${requested}" is not implemented yet. ` +
      `Supported values: "mock", "anthropic", "bedrock". See ` +
      `docs/adr/0011-math-translator.md for the model-selection path.`,
  );
}

export { mockMathTranslator, anthropicMathTranslator, bedrockMathTranslator };
export type {
  MathTranslatorProvider,
  TranslateMathRequest,
  TranslateMathResult,
} from "./types";
