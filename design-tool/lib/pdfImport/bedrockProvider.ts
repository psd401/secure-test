import { converseTextWithMeta } from "@/lib/ai/bedrockConverse";
import {
  PDF_EXTRACT_MAX_TOKENS,
  PDF_EXTRACT_SYSTEM_PROMPT,
  PDF_OCR_USER_PROMPT,
  buildPdfExtractUserPrompt,
  parsePdfExtraction,
} from "./extractCore";
import type {
  PdfExtractRequest,
  PdfExtractResult,
  PdfExtractorProvider,
} from "./types";

// Amazon Bedrock PDF item extractor — AWS SDK Converse + SigV4, same wiring
// as item gen (ADR 0007). Structuring free text into items is
// reasoning-heavy, so the default is the Sonnet 4.6 profile item gen uses;
// override via BEDROCK_PDF_EXTRACT_MODEL. temperature 0 for repeatability.
// Raw candidates are returned as-is; the route validates each through
// CreateItemBody, so a malformed candidate is reported, never persisted.

const DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-6";

export const bedrockPdfExtractor: PdfExtractorProvider = {
  get id() {
    return `bedrock-${process.env.BEDROCK_PDF_EXTRACT_MODEL ?? DEFAULT_MODEL}`;
  },

  async extract(
    req: PdfExtractRequest,
    ownerSub?: string,
  ): Promise<PdfExtractResult> {
    // Scanned path (ADR 0015): attach the PDF as a Converse document block
    // so the model reads the pages visually; same system prompt and JSON
    // contract as the text path.
    const scanned = req.scanned_pdf;
    const { text, stopReason } = await converseTextWithMeta({
      modelId: process.env.BEDROCK_PDF_EXTRACT_MODEL ?? DEFAULT_MODEL,
      systemText: PDF_EXTRACT_SYSTEM_PROMPT,
      userText: scanned ? PDF_OCR_USER_PROMPT : buildPdfExtractUserPrompt(req.text),
      maxTokens: PDF_EXTRACT_MAX_TOKENS,
      temperature: 0,
      ...(scanned
        ? { document: { bytes: scanned, name: req.file_name ?? "document" } }
        : {}),
      errPrefix: "bedrock",
      surface: "pdf-import",
      ownerSub,
    });
    const parsed = parsePdfExtraction(text, "bedrock", {
      truncated: stopReason === "max_tokens",
    });
    return { candidates: parsed.candidates, proposed_sets: parsed.proposedSets };
  },
};
