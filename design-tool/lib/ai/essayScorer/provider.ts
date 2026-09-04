import { bedrockEssayScorer } from "./bedrockProvider";
import { mockEssayScorer } from "./mockProvider";
import type { EssayScorerProvider } from "./types";

// Slice 38: env-switched essay scorer, mirroring lib/ai/provider.ts and
// the math translator. Mock stays the default so tests/CI/dev need no AWS
// credentials. Only bedrock is wired as the real path (ADR 0014's
// AWS-bubble constraint); a direct-Anthropic provider was deliberately
// not added.

export function getEssayScorerProvider(): EssayScorerProvider {
  const requested = process.env.ESSAY_SCORER_PROVIDER ?? "mock";
  if (requested === "mock") return mockEssayScorer;
  if (requested === "bedrock") return bedrockEssayScorer;
  throw new Error(
    `ESSAY_SCORER_PROVIDER="${requested}" is not implemented. ` +
      `Supported values: "mock", "bedrock".`,
  );
}

export { mockEssayScorer, bedrockEssayScorer };
export type {
  EssayScorerProvider,
  ScoreEssayRequest,
  ScoreEssayResult,
} from "./types";
