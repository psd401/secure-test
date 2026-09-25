import { z } from "zod";

// Safeguarding alerts slice 1 (docs/safeguarding-alerts-design.md): the
// hand-in screener. ONE model call per eligible essay / short-text answer
// answers both questions the note asks (S-1 proposal 1) — is this a
// first-person wellbeing disclosure, and does it try to instruct the AI
// scorer — so the injection check costs nothing extra over the wellbeing
// check alone. Mirrors the guardrail provider pattern (../types.ts): a
// deterministic mock for tests, a Bedrock Haiku provider behind an env var,
// and `null` (off) as the default.

export const WELLBEING_CATEGORIES = [
  "suicidal_ideation",
  "self_harm",
  "abuse",
  "none",
] as const;
export type WellbeingCategory = (typeof WELLBEING_CATEGORIES)[number];

export const ScreeningResult = z.object({
  wellbeing: z.object({
    category: z.enum(WELLBEING_CATEGORIES),
    confidence: z.number().min(0).max(1),
    evidence: z.string(),
  }),
  injection: z.object({
    detected: z.boolean(),
    evidence: z.string(),
  }),
});
export type ScreeningResult = z.infer<typeof ScreeningResult>;

export interface ScreeningInput {
  /** The item's stem — the question the student answered. */
  prompt: string;
  /** The student's answer text. */
  text: string;
}

export interface ScreeningProvider {
  /** Stable detector id stored on the alert row, e.g. `haiku-2026-09-25`. */
  readonly id: string;
  screen(input: ScreeningInput): Promise<ScreeningResult>;
}
