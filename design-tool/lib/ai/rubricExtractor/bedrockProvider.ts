import { converseTextWithMeta } from "@/lib/ai/bedrockConverse";
import {
  RUBRIC_DOCUMENT_USER_PROMPT,
  RUBRIC_EXTRACT_MAX_TOKENS,
  RUBRIC_EXTRACT_SYSTEM_PROMPT,
  buildRubricExtractUserPrompt,
  parseRubricExtraction,
} from "./extractCore";
import type {
  RubricExtractRequest,
  RubricExtractResult,
  RubricExtractorProvider,
} from "./types";

// Amazon Bedrock rubric extractor — AWS SDK Converse + SigV4, the same
// wiring as the PDF importer (ADR 0007). Reading a rubric table is
// structure-heavy, so the default is the Sonnet 4.6 profile; override via
// BEDROCK_RUBRIC_EXTRACT_MODEL. temperature 0 for repeatability. The raw
// object is returned as-is; normalizeRubric + RubricSchema decide whether
// it is usable.

const DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-6";

export const bedrockRubricExtractor: RubricExtractorProvider = {
  get id() {
    return `bedrock-${process.env.BEDROCK_RUBRIC_EXTRACT_MODEL ?? DEFAULT_MODEL}`;
  },

  async extract(
    req: RubricExtractRequest,
    ownerSub?: string,
  ): Promise<RubricExtractResult> {
    // D-1: a PDF / DOCX rubric rides as a Converse document block so the
    // model sees the table layout; Markdown and pasted text go as text.
    const doc = req.document;
    const { text, stopReason } = await converseTextWithMeta({
      modelId: process.env.BEDROCK_RUBRIC_EXTRACT_MODEL ?? DEFAULT_MODEL,
      systemText: RUBRIC_EXTRACT_SYSTEM_PROMPT,
      userText: doc
        ? RUBRIC_DOCUMENT_USER_PROMPT
        : buildRubricExtractUserPrompt(req.text ?? ""),
      maxTokens: RUBRIC_EXTRACT_MAX_TOKENS,
      temperature: 0,
      ...(doc
        ? {
            document: {
              bytes: doc.bytes,
              format: doc.format,
              name: doc.name || req.file_name || "rubric",
            },
          }
        : {}),
      errPrefix: "bedrock",
      surface: "rubric-extract",
      ownerSub,
    });
    return {
      rubric: parseRubricExtraction(text, "bedrock", {
        truncated: stopReason === "max_tokens",
      }),
    };
  },
};
