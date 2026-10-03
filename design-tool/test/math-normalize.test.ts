import { describe, expect, test } from "bun:test";
import { normalizeDigitLedMath, normalizeProposalMath } from "@/lib/ai/mathNormalize";
import { renderLatex } from "@/lib/math/renderLatex";
import { validateBatchProposals } from "@/lib/ai/itemBatchCore";

const isMath = (s: string) => renderLatex(s).includes("katex");

// Finding BG-E1: the slice 7 re-run's raw runs (Bedrock, 2026-10-02).
describe("normalizeDigitLedMath (BG-E1)", () => {
  test.each([
    ["$5x + 3 = 28$", "${5x + 3 = 28}$"],
    ["$3(x + 4) = 21$", "${3(x + 4) = 21}$"],
    ["$2x + 9 < 25$", "${2x + 9 < 25}$"],
    ["$30(h + 45) = 135$", "${30(h + 45) = 135}$"],
    ["$2.5$", "${2.5}$"],
    ["$7$", "${7}$"],
  ])("wraps %s", (input, expected) => {
    expect(normalizeDigitLedMath(input)).toBe(expected);
    expect(isMath(normalizeDigitLedMath(input))).toBe(true);
  });

  test("wraps each run in a sentence and keeps the prose", () => {
    expect(normalizeDigitLedMath("Solve $4x + 9 = 33$, then check $2x < 18$.")).toBe(
      "Solve ${4x + 9 = 33}$, then check ${2x < 18}$.",
    );
  });

  test.each([
    "It costs $5 to $10.",
    "Prices run $5-$10 a pound.",
    "Apples are $3.50/$4 a bag.",
    "Marcus earns $12.50 per hour and wants $200.",
    "A ticket is $8 and a drink is $3.",
    "Save \\$12.50 now",
    "$$5x + 3 = 28$$",
  ])("leaves %s alone", (input) => {
    expect(normalizeDigitLedMath(input)).toBe(input);
  });

  test("leaves runs M-1 already renders", () => {
    for (const s of ["$3.5 \\times 10^{4}$", "$y = 30x$", "${3x + 7 = 22}$", "$x^2$"]) {
      expect(normalizeDigitLedMath(s)).toBe(s);
    }
  });
});

describe("normalizeProposalMath", () => {
  test("rewrites stem, choices and pairs, never the key", () => {
    const out = normalizeProposalMath({
      type: "short_text",
      stem: "Solve $5x + 3 = 28$.",
      correct_answer: "$5$",
      choices: [{ id: "a", text: "$12h < 90$" }],
      pairs: [{ id: "p1", left: "$3x + 7 = 22$", right: "$5$" }],
    });
    expect(out.stem).toBe("Solve ${5x + 3 = 28}$.");
    expect(out.choices[0]!.text).toBe("${12h < 90}$");
    expect(out.pairs[0]).toEqual({ id: "p1", left: "${3x + 7 = 22}$", right: "${5}$" });
    expect(out.correct_answer).toBe("$5$");
  });

  test("the batch validator applies it", () => {
    const { proposals } = validateBatchProposals(
      [
        {
          type: "match",
          stem: "Match each equation to its solution.",
          pairs: [
            { left: "$3x + 7 = 22$", right: "$5$" },
            { left: "$2x + 9 = 3$", right: "$-3$" },
          ],
        },
      ],
      { count: 1, types: { match: 1 }, standards: [] },
    );
    const pairs = (proposals[0] as { pairs: { left: string; right: string }[] }).pairs;
    expect(pairs[0]).toMatchObject({ left: "${3x + 7 = 22}$", right: "${5}$" });
    expect(pairs[1]!.right).toBe("$-3$");
  });
});
