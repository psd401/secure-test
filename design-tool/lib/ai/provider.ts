import { mockProvider } from "./mockProvider";
import { anthropicItemProvider } from "./anthropicProvider";
import { bedrockItemProvider } from "./bedrockProvider";
import type { ItemGeneratorProvider } from "./types";

// Phase 1.5: Claude Sonnet 4.6 wired two ways alongside the existing mock
// per ADR 0007 — the direct Anthropic API (AI_PROVIDER=anthropic, needs
// ANTHROPIC_API_KEY) and Amazon Bedrock (AI_PROVIDER=bedrock, needs AWS
// credentials + region). The mock is still the default so test DBs and CI
// don't need any key.
//
// To add another vendor (OpenAI, Gemini, Grok):
//   1. Implement ItemGeneratorProvider in lib/ai/<name>Provider.ts.
//   2. Add another branch to the switch below.
//   3. Document the env-var + key plumbing in the .env.local.example.
// See docs/adr/0007-ai-model-selection.md for the model trade-off matrix.
export function getProvider(): ItemGeneratorProvider {
  const requested = process.env.AI_PROVIDER ?? "mock";
  if (requested === "mock") return mockProvider;
  if (requested === "anthropic") return anthropicItemProvider;
  if (requested === "bedrock") return bedrockItemProvider;
  throw new Error(
    `AI_PROVIDER="${requested}" is not implemented yet. ` +
      `Supported values: "mock", "anthropic", "bedrock". To add a new vendor, ` +
      `follow docs/adr/0007-ai-model-selection.md and implement an ` +
      `ItemGeneratorProvider in lib/ai/<provider>.ts.`,
  );
}

export { mockProvider, anthropicItemProvider, bedrockItemProvider };
export type { ItemGeneratorProvider } from "./types";
