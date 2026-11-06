// Withheld AI feedback (2026-11-06, beta teacher report). When the district
// guardrail's OUTPUT check stops the AI's written feedback on an essay or
// short answer, the score itself is still proposed — with every feedback
// string blanked and the filter categories that fired recorded — so the
// teacher reviews a score instead of starting from nothing. The trigger was
// AWS's managed PROFANITY list, which blocks the word "Nazi" in feedback on
// a history answer.
//
// Pure and type-only on imports: the scoring queue (a client component)
// reads `describeWithheldFilters` too.

import type { GuardrailFinding } from "@/lib/safeguarding/types";
import type { ScoreEssayResult } from "@/lib/ai/essayScorer/types";

/** Stored on the score's `rationale` jsonb as `feedback_withheld`. */
export interface WithheldFeedback {
  /** Filter category labels (e.g. PROFANITY, HATE) — never matched text. */
  filters: string[];
}

/**
 * The category labels of a block's findings, de-duplicated in order. The
 * findings have already been through `redactFindings`, so `detail` is a
 * policy label or absent; a finding without one falls back to its type.
 */
export function withheldFilterLabels(findings: GuardrailFinding[]): string[] {
  const labels: string[] = [];
  for (const f of findings) {
    const label = f.detail ?? f.type;
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** The result with every feedback string blanked; points, levels and
 * confidence kept. `overall_rationale: ""` is below the model-output schema's
 * `min(1)` (essayScorer/types.ts) on purpose: that schema checks the model's
 * reply only (scoreCore's parse); stored rationale is never re-parsed with
 * it, and readers treat empty feedback as none. */
export function withholdFeedback(result: ScoreEssayResult): ScoreEssayResult {
  return {
    ...result,
    overall_rationale: "",
    criterion_scores: result.criterion_scores.map((c) => ({ ...c, rationale: "" })),
  };
}

const FILTER_NAMES: Record<string, string> = {
  PROFANITY: "profanity word list",
  HATE: "hate",
  VIOLENCE: "violence",
  SEXUAL: "sexual content",
  INSULTS: "insults",
  MISCONDUCT: "misconduct",
  PROMPT_ATTACK: "prompt attack",
  blocked_word: "district word list",
  guardrail_intervened: "unspecified",
};

/** Teacher-facing names for the filters, e.g. "profanity word list, hate". */
export function describeWithheldFilters(filters: readonly string[]): string {
  const names = filters.map((f) => FILTER_NAMES[f] ?? f.toLowerCase().replaceAll("_", " "));
  return names.length > 0 ? names.join(", ") : "unspecified";
}
