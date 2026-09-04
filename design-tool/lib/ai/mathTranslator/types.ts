import { z } from "zod";

// Math translator request: a natural-language description of an
// expression. The translator returns the corresponding LaTeX (without
// the `$` / `$$` delimiters; the caller decides which to wrap with at
// insertion time). Kept separate from ItemGeneratorProvider (ADR 0007)
// because the use case is different — translating notation isn't
// "authoring an item" and shouldn't share the per-assessment
// allow_llm_authoring gate (ADR TBD).

export const TranslateMathRequest = z.object({
  prompt: z.string().min(1).max(2000),
  /**
   * Hint to the provider about the expected display mode. Doesn't
   * affect the returned LaTeX (no `$` wrapper), but a future real
   * provider could use it to decide between `\dfrac` vs `\frac`,
   * environment choices, etc. Mock provider ignores it.
   */
  display_mode: z.enum(["inline", "display"]).default("inline"),
});
export type TranslateMathRequest = z.infer<typeof TranslateMathRequest>;

export const TranslateMathResult = z.object({
  /** LaTeX expression without surrounding `$` delimiters. */
  latex: z.string().min(1).max(4000),
  /**
   * Provider-supplied confidence hint, 0–1. Optional; real models can
   * surface "I'm not sure" so the editor can flag the proposal more
   * cautiously. The mock provider always returns 1.
   */
  confidence: z.number().min(0).max(1).optional(),
});
export type TranslateMathResult = z.infer<typeof TranslateMathResult>;

export interface MathTranslatorProvider {
  /** Stable identifier persisted in API responses for triage. */
  readonly id: string;
  translate(req: TranslateMathRequest): Promise<TranslateMathResult>;
}
