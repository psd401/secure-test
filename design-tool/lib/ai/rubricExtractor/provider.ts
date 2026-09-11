import { bedrockRubricExtractor } from "./bedrockProvider";
import { mockRubricExtractor } from "./mockProvider";
import type { RubricExtractorProvider } from "./types";

// Rubric upload slice 1: env-switched rubric extractor, mirroring the PDF
// importer and the other AI providers. Mock stays the default so tests /
// CI / dev need no AWS; only bedrock is wired as the real path (ADR 0014's
// AWS-bubble constraint).

export function getRubricExtractorProvider(): RubricExtractorProvider {
  const requested = process.env.RUBRIC_EXTRACTOR_PROVIDER ?? "mock";
  if (requested === "mock") return mockRubricExtractor;
  if (requested === "bedrock") return bedrockRubricExtractor;
  throw new Error(
    `RUBRIC_EXTRACTOR_PROVIDER="${requested}" is not implemented. ` +
      `Supported values: "mock", "bedrock".`,
  );
}

export { mockRubricExtractor, bedrockRubricExtractor };
export type { RubricExtractorProvider, RubricExtractRequest } from "./types";
