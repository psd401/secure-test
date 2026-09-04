import { bedrockPdfExtractor } from "./bedrockProvider";
import { mockPdfExtractor } from "./mockProvider";
import type { PdfExtractorProvider } from "./types";

// Slice 42: env-switched PDF item extractor, mirroring the other AI
// providers. Mock stays the default so tests/CI/dev need no AWS. Only
// bedrock is wired as the real path (ADR 0014 AWS-bubble).

export function getPdfExtractorProvider(): PdfExtractorProvider {
  const requested = process.env.PDF_EXTRACTOR_PROVIDER ?? "mock";
  if (requested === "mock") return mockPdfExtractor;
  if (requested === "bedrock") return bedrockPdfExtractor;
  throw new Error(
    `PDF_EXTRACTOR_PROVIDER="${requested}" is not implemented. ` +
      `Supported values: "mock", "bedrock".`,
  );
}

export { mockPdfExtractor, bedrockPdfExtractor };
export type { PdfExtractorProvider, PdfExtractRequest } from "./types";
