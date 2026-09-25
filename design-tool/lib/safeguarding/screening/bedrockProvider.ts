import { converseText } from "@/lib/ai/bedrockConverse";
import {
  SCREENING_MAX_TOKENS,
  SCREENING_PROMPT_VERSION,
  SCREENING_SYSTEM_PROMPT,
  buildScreeningUserMessage,
} from "./prompt";
import {
  ScreeningResult,
  type ScreeningInput,
  type ScreeningProvider,
} from "./types";

// Safeguarding alerts slice 1: the Bedrock screener — Claude Haiku 4.5 (D-10,
// after spike S-2) through the shared Converse helper, temperature 0 so the
// same answer screens the same way twice. Override the model with
// SAFEGUARDING_SCREENER_MODEL (e.g. Nova 2 Lite, S-2's fallback).

const DEFAULT_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const ERR = "safeguarding_screener";

/** The one Converse call, injectable so tests need no AWS. */
export type ScreenerConverse = (opts: {
  modelId: string;
  systemText: string;
  userText: string;
}) => Promise<string>;

const defaultConverse: ScreenerConverse = (opts) =>
  converseText({
    ...opts,
    maxTokens: SCREENING_MAX_TOKENS,
    temperature: 0,
    errPrefix: ERR,
    surface: "safeguarding-screen",
  });

/**
 * The note's rule: `evidence` must be an exact substring of the answer, or it
 * is dropped — an alert must never show a teacher a sentence the student did
 * not write. Compared trimmed; the trimmed quote is what is kept.
 */
export function keepEvidenceIfQuoted(evidence: string, text: string): string {
  const quote = evidence.trim();
  return quote.length > 0 && text.includes(quote) ? quote : "";
}

/** Outermost `{…}` → JSON → Zod. Throws `safeguarding_screener: …` on failure. */
export function parseScreeningResult(raw: string): ScreeningResult {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`${ERR}: model did not return JSON`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error(`${ERR}: model did not return valid JSON`);
  }
  const parsed = ScreeningResult.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${ERR}: model JSON failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function makeBedrockScreener(
  converse: ScreenerConverse = defaultConverse,
): ScreeningProvider {
  return {
    id: `haiku-${SCREENING_PROMPT_VERSION}`,
    async screen(input: ScreeningInput): Promise<ScreeningResult> {
      const raw = await converse({
        modelId: process.env.SAFEGUARDING_SCREENER_MODEL || DEFAULT_MODEL,
        systemText: SCREENING_SYSTEM_PROMPT,
        userText: buildScreeningUserMessage(input),
      });
      const result = parseScreeningResult(raw);
      return {
        wellbeing: {
          ...result.wellbeing,
          evidence: keepEvidenceIfQuoted(result.wellbeing.evidence, input.text),
        },
        injection: {
          ...result.injection,
          evidence: keepEvidenceIfQuoted(result.injection.evidence, input.text),
        },
      };
    },
  };
}

export const bedrockScreener: ScreeningProvider = makeBedrockScreener();
