import type {
  ScreeningInput,
  ScreeningProvider,
  ScreeningResult,
  WellbeingCategory,
} from "./types";

// Sentinel-based mock screener. Deterministic so the screening pass, the
// hand-in hook and the AI-scoring withhold (D-4) are testable without
// Bedrock. Only literal sentinels fire — never ordinary essay text:
//   SG_SUICIDE → suicidal_ideation, SG_SELFHARM → self_harm,
//   SG_ABUSE → abuse, SG_INJECT → injection detected.
// `evidence` is the sentence carrying the sentinel, as the real screener
// quotes the triggering sentence.

const WELLBEING_SENTINELS: Array<[string, Exclude<WellbeingCategory, "none">]> = [
  ["SG_SUICIDE", "suicidal_ideation"],
  ["SG_SELFHARM", "self_harm"],
  ["SG_ABUSE", "abuse"],
];

function sentenceWith(text: string, token: string): string {
  const sentences = text.match(/[^.!?\n]+[.!?]*/g) ?? [text];
  return (sentences.find((s) => s.includes(token)) ?? token).trim();
}

export const mockScreener: ScreeningProvider = {
  id: "mock",
  async screen({ text }: ScreeningInput): Promise<ScreeningResult> {
    const hit = WELLBEING_SENTINELS.find(([token]) => text.includes(token));
    const injected = text.includes("SG_INJECT");
    return {
      wellbeing: hit
        ? { category: hit[1], confidence: 0.95, evidence: sentenceWith(text, hit[0]) }
        : { category: "none", confidence: 0.02, evidence: "" },
      injection: injected
        ? { detected: true, evidence: sentenceWith(text, "SG_INJECT") }
        : { detected: false, evidence: "" },
    };
  },
};
