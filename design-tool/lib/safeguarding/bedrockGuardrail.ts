import {
  ApplyGuardrailCommand,
  type ApplyGuardrailCommandOutput,
  type GuardrailAssessment,
} from "@aws-sdk/client-bedrock-runtime";
import { bedrockClient, wrapBedrockError } from "@/lib/ai/bedrockConverse";
import type {
  GuardrailFinding,
  GuardrailProvider,
  GuardrailResult,
  GuardrailStage,
  GuardrailSurface,
} from "./types";

// Slice 29: real safeguarding via Amazon Bedrock Guardrails (ADR 0012).
// Uses the standalone ApplyGuardrail API rather than Converse's inline
// guardrailConfig so it is provider-agnostic — the same check runs over
// the mock/anthropic/bedrock AI providers' input and output. Shares the
// SigV4 client + error wrapper with the item/math providers
// (lib/ai/bedrockConverse.ts); the guardrail itself is provisioned in AWS
// (ADR 0012) and identified by GUARDRAIL_ID / GUARDRAIL_VERSION.

const DEFAULT_VERSION = "DRAFT";

// Best-effort mapping of the verbose Bedrock assessment into our compact
// finding shape. A blocked verdict always carries at least one finding
// (see check()), so missing a niche policy here only loses detail, never
// the block itself.
function extractFindings(out: ApplyGuardrailCommandOutput): GuardrailFinding[] {
  const findings: GuardrailFinding[] = [];
  for (const a of out.assessments ?? ([] as GuardrailAssessment[])) {
    for (const t of a.topicPolicy?.topics ?? []) {
      findings.push({ type: "denied_topic", detail: t.name });
    }
    for (const f of a.contentPolicy?.filters ?? []) {
      findings.push({ type: "content_filter", detail: f.type });
    }
    for (const p of a.sensitiveInformationPolicy?.piiEntities ?? []) {
      // NEVER `p.match` — that is the literal detected PII (the SSN, the
      // email). Findings are persisted to guardrail_events AND returned to
      // the browser in the 422 body, so the PII filter would durably record
      // and re-emit the exact data it exists to suppress. `p.type` is the
      // entity category (e.g. US_SOCIAL_SECURITY_NUMBER) — all a triager
      // needs. `redactFindings` in guard.ts enforces this a second time.
      findings.push({ type: "pii", detail: p.type });
    }
    for (const _w of a.wordPolicy?.customWords ?? []) {
      // No `detail`. `customWords` reports only `match` — the literal text from
      // the checked input — and unlike piiEntities there is no category field
      // to substitute. Emitting it would contradict the GuardrailFinding
      // contract (detail is a policy label, never a match), and these findings
      // are both persisted to guardrail_events AND returned to the browser in
      // the 422 body. The word list is district-configured, so a district that
      // blocks e.g. student names would otherwise have those names echoed back
      // by the very filter meant to catch them. Triage context is not lost:
      // `text_snippet` still carries the surrounding text for this finding
      // type (see SNIPPET_SUPPRESSING_FINDING_TYPES in guard.ts).
      findings.push({ type: "blocked_word" });
    }
  }
  return findings;
}

export const bedrockGuardrail: GuardrailProvider = {
  id: "bedrock-guardrail",
  async check(
    text: string,
    ctx: { stage: GuardrailStage; surface: GuardrailSurface },
  ): Promise<GuardrailResult> {
    const guardrailIdentifier = process.env.GUARDRAIL_ID;
    if (!guardrailIdentifier) {
      throw new Error(
        "GUARDRAIL_ID is not set (required for GUARDRAIL_PROVIDER=bedrock)",
      );
    }
    const guardrailVersion = process.env.GUARDRAIL_VERSION ?? DEFAULT_VERSION;

    let response: ApplyGuardrailCommandOutput;
    try {
      response = await bedrockClient().send(
        new ApplyGuardrailCommand({
          guardrailIdentifier,
          guardrailVersion,
          source: ctx.stage === "input" ? "INPUT" : "OUTPUT",
          content: [{ text: { text } }],
        }),
      );
    } catch (err) {
      wrapBedrockError(err, "bedrock_guardrail");
    }

    if (response.action === "GUARDRAIL_INTERVENED") {
      const findings = extractFindings(response);
      // Guarantee a triage signal even if the assessment shape changes.
      if (findings.length === 0) findings.push({ type: "guardrail_intervened" });
      return { action: "block", findings };
    }
    return { action: "allow", findings: [] };
  },
};
