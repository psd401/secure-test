import { z } from "zod";

// Slice 42: LLM-assisted PDF item extraction. The provider turns extracted
// PDF text into candidate item objects. Candidates are shaped like the
// CreateItemBody the manual editor / CSV import validate against — the
// route runs each through CreateItemBody so there is ONE validation
// authority (bad candidates are reported, never persisted). Nothing is
// written by extraction: candidates are proposals the teacher reviews and
// edits before adding (propose-then-edit, like AI item gen).

export const PdfExtractRequest = z
  .object({
    text: z.string().max(500_000),
    page_count: z.number().int().positive(),
    // Scanned path (slice 44, ADR 0015): no usable text layer, so the raw
    // PDF bytes ride along and the provider reads the pages directly via a
    // Bedrock Converse document block. `text` may be empty on this path.
    scanned_pdf: z.instanceof(Uint8Array).optional(),
    file_name: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.scanned_pdf && v.text.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "text is required when no scanned_pdf is provided",
        path: ["text"],
      });
    }
  });
export type PdfExtractRequest = z.infer<typeof PdfExtractRequest>;

// The provider returns loosely-typed candidate objects (validated
// downstream via CreateItemBody). Kept as unknown[] so a provider can't
// smuggle an unvalidated write shape past the route.
export interface PdfExtractResult {
  candidates: unknown[];
  /** E5 slice 3: the model's proposed item sets, raw — validated by the
   * route (validateProposedSets) like candidates are. */
  proposed_sets?: unknown[];
}

export interface PdfExtractorProvider {
  /** Stable identifier for logging/telemetry. */
  readonly id: string;
  /** `ownerSub` (docs/rubric-upload-design.md D-7): the ai_usage log field. */
  extract(req: PdfExtractRequest, ownerSub?: string): Promise<PdfExtractResult>;
}
