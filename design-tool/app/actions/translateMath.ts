"use server";

import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { getMathTranslatorProvider } from "@/lib/ai/mathTranslator/provider";
import {
  TranslateMathRequest,
  type TranslateMathResult,
} from "@/lib/ai/mathTranslator/types";
import { runGuarded } from "@/lib/safeguarding/guard";

export interface TranslateMathActionResult {
  ok: boolean;
  provider?: string;
  latex?: string;
  confidence?: number;
  error?: string;
  /** Human-readable explanation when error === "guardrail_blocked". */
  note?: string;
}

// Inline math-notation translator. Unlike the ItemGeneratorProvider
// (ADR 0007), this one is NOT gated by assessment.allow_llm_authoring —
// translating "one half" to `\frac{1}{2}` isn't authoring an item,
// it's a notation converter. Session-gated to keep it from being used
// as a free public LaTeX service.

export async function translateMath(
  input: { prompt: string; display_mode?: "inline" | "display" },
): Promise<TranslateMathActionResult> {
  const session = await readStaffSessionFromCookies();
  if (!session) return { ok: false, error: "unauthenticated" };

  const parsed = TranslateMathRequest.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid_input",
    };
  }

  const provider = getMathTranslatorProvider();

  // Safeguarding (slice 28): guardrail the prompt and the returned LaTeX.
  // Default GUARDRAIL_PROVIDER=off makes this a direct pass-through.
  let outcome: Awaited<ReturnType<typeof runGuarded<TranslateMathResult>>>;
  try {
    outcome = await runGuarded({
      surface: "math-translate",
      ownerSub: session.sub,
      inputText: parsed.data.prompt,
      run: () => provider.translate(parsed.data, session.sub),
      outputText: (r) => r.latex,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "provider_failed";
    return { ok: false, error: `provider_failed:${detail}` };
  }

  if (!outcome.ok) {
    return {
      ok: false,
      error: "guardrail_blocked",
      note:
        outcome.stage === "input"
          ? "Your request was blocked by content safeguards. Edit the text and try again."
          : "The translation was withheld by content safeguards.",
    };
  }

  return {
    ok: true,
    provider: provider.id,
    latex: outcome.result.latex,
    confidence: outcome.result.confidence,
  };
}
