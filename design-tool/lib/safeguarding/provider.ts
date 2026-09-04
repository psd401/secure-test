import type { GuardrailProvider } from "./types";
import { mockGuardrail } from "./mockProvider";
import { bedrockGuardrail } from "./bedrockGuardrail";

// Provider selector, mirroring lib/ai/provider.ts. Reads GUARDRAIL_PROVIDER
// and returns the matching guardrail, or `null` when safeguarding is off.
//
// Default is "off": a null provider means the wrapper (guard.ts) runs the
// AI call directly with zero extra latency and writes no telemetry, so
// existing behavior and the existing test suite are unchanged until a
// guardrail is deliberately enabled. "mock" is for tests/local demo;
// "bedrock" (slice 29, ADR 0012) is the real Bedrock-Guardrails provider.

export { mockGuardrail, bedrockGuardrail };

export function getGuardrailProvider(): GuardrailProvider | null {
  const requested = process.env.GUARDRAIL_PROVIDER ?? "off";
  if (requested === "off") return null;
  if (requested === "mock") return mockGuardrail;
  if (requested === "bedrock") return bedrockGuardrail;
  throw new Error(
    `Unknown GUARDRAIL_PROVIDER="${requested}"; expected "off", "mock", ` +
      `or "bedrock" (see docs/adr/0012-safeguarding-guardrails.md).`,
  );
}
