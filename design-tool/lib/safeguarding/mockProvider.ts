import type {
  GuardrailFinding,
  GuardrailProvider,
  GuardrailResult,
  GuardrailStage,
  GuardrailSurface,
} from "./types";

// Pattern-based mock guardrail. Deterministic so the wrapper, the two AI
// call sites, and (later) the admin review page are testable without an
// AWS Bedrock Guardrail provisioned. A real provider (Bedrock
// ApplyGuardrail, per ADR 0012) replaces this in production — same
// allow/block contract, real content filters / denied topics / PII.
//
// Three deliberately narrow rules so tests are stable and the mock never
// blocks ordinary K-12 math/ELA content by accident:
//   1. The literal sentinel token BLOCKME — an explicit test hook so
//      tests can force a block on either stage without relying on the
//      heuristics below.
//   2. A US SSN shape (NNN-NN-NNNN) — stands in for the PII filter.
//   3. A tiny blocked-term list — stands in for content filters /
//      denied topics. Kept generic on purpose.

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const BLOCKED_TERMS = ["blockme", "selfharm-test", "weapon-test"];

function scan(text: string): GuardrailFinding[] {
  const findings: GuardrailFinding[] = [];
  const lower = text.toLowerCase();
  for (const term of BLOCKED_TERMS) {
    if (lower.includes(term)) {
      findings.push({ type: "blocked_term", detail: term });
    }
  }
  if (SSN_RE.test(text)) {
    findings.push({ type: "pii", detail: "ssn_shape" });
  }
  return findings;
}

export const mockGuardrail: GuardrailProvider = {
  id: "mock",
  async check(
    text: string,
    _ctx: { stage: GuardrailStage; surface: GuardrailSurface },
  ): Promise<GuardrailResult> {
    const findings = scan(text);
    return { action: findings.length > 0 ? "block" : "allow", findings };
  },
};
