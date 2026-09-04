// Slice 28: safeguarding abstraction. A GuardrailProvider inspects a
// single piece of text (a teacher's authoring prompt, or a model's
// output) and returns an allow/block verdict plus structured findings.
// It mirrors the AI-provider pattern (lib/ai/provider.ts): a mock-default
// implementation keeps the wrapper testable without AWS, and a real
// Bedrock-Guardrails provider (slice 29, ADR 0012) swaps in behind an env
// var. The wrapper in `guard.ts` runs an input check before the model
// call and an output check after it, recording every check to the
// guardrail_events telemetry table.

import type { GUARDRAIL_SURFACES } from "@/db/schema";

/** Which AI surface invoked the check — used for triage in telemetry. */
export type GuardrailSurface = (typeof GUARDRAIL_SURFACES)[number];

/** Whether the text checked was the user input or the model output. */
export type GuardrailStage = "input" | "output";

/** Verdict the provider reaches for a piece of text. */
export type GuardrailAction = "allow" | "block";

/**
 * One reason a check flagged content. `type` is a stable machine code
 * (e.g. "pii", "denied_topic", "blocked_term"); `detail` is an optional
 * human-readable note. Kept deliberately small so it serializes cleanly
 * into the findings jsonb column and the admin review page later.
 *
 * `detail` MUST be a policy/category label, never the matched substring.
 * Findings are persisted to `guardrail_events.findings` and returned to the
 * browser in the guardrail_blocked 422 body, so a match value here would mean
 * the safeguarding layer durably stores and re-emits the sensitive text it was
 * asked to suppress. `redactFindings` in guard.ts is the enforcing chokepoint
 * for finding types listed in `SENSITIVE_FINDING_TYPES`.
 */
export interface GuardrailFinding {
  type: string;
  detail?: string;
}

export interface GuardrailResult {
  action: GuardrailAction;
  findings: GuardrailFinding[];
}

export interface GuardrailProvider {
  /** Stable identifier persisted in telemetry, e.g. "mock", "bedrock". */
  readonly id: string;
  check(
    text: string,
    ctx: { stage: GuardrailStage; surface: GuardrailSurface },
  ): Promise<GuardrailResult>;
}
