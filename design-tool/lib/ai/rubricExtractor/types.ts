import { z } from "zod";

import type { ConverseDocumentFormat } from "@/lib/ai/bedrockConverse";

// Rubric upload slice 1 (docs/rubric-upload-design.md, D-1/D-2). The
// provider turns a teacher's rubric — pasted text, a Markdown/plain-text
// file, or a PDF / DOCX read as a Converse document block — into ONE raw
// rubric object. Nothing is written: the route normalises + validates the
// raw object through the shared `RubricSchema` and hands the teacher a
// proposal (propose-then-edit, exactly like PDF import).

/** Document formats a rubric may arrive as (D-1). */
export const RUBRIC_DOCUMENT_FORMATS = [
  "pdf",
  "docx",
  "doc",
  "md",
  "txt",
  "html",
  "csv",
  "xlsx",
] as const satisfies readonly ConverseDocumentFormat[];

/** Upper bound on pasted / decoded rubric text (the route enforces it too). */
export const MAX_RUBRIC_TEXT_CHARS = 200_000;

export const RubricExtractRequest = z
  .object({
    /** Pasted text, or a decoded Markdown / plain-text file. */
    text: z.string().max(MAX_RUBRIC_TEXT_CHARS).optional(),
    /** PDF / DOCX read by the model directly (table layout survives). */
    document: z
      .object({
        bytes: z.instanceof(Uint8Array),
        format: z.enum(RUBRIC_DOCUMENT_FORMATS),
        name: z.string(),
      })
      .optional(),
    file_name: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.document && (v.text ?? "").trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "text is required when no document is provided",
        path: ["text"],
      });
    }
  });
export type RubricExtractRequest = z.infer<typeof RubricExtractRequest>;

/**
 * The provider's answer, deliberately raw: the model's JSON object as it
 * came back. `normalizeRubric` is the ONE place it becomes a `Rubric`, so a
 * provider cannot smuggle an unvalidated rubric past the route.
 */
export interface RubricExtractResult {
  rubric: unknown;
}

export interface RubricExtractorProvider {
  /** Stable identifier for logging/telemetry. */
  readonly id: string;
  /** `ownerSub` (docs/rubric-upload-design.md D-7): the ai_usage log field. */
  extract(
    req: RubricExtractRequest,
    ownerSub?: string,
  ): Promise<RubricExtractResult>;
}
