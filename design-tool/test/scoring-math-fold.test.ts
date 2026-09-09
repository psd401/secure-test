// Roadmap 4b slice 1a (2026-09-08, docs/math-entry-design.md): the scorer's
// fold learns the math keypad's notation. The keypad inserts the Unicode
// character wherever one exists and LaTeX only for `\frac` / `\sqrt` / `^` /
// `_`; the teacher's key stays plain text (E7(a)). Every row below is a
// keypad-shaped student answer against the plain key a teacher would type,
// plus the limits the fold does NOT paper over (it equates notation, not
// value). Pure functions only — no DB, so this file runs without
// DATABASE_URL; the DB-backed scorer tests live in scoring-auto.test.ts.
import { describe, expect, test } from "bun:test";
import type { ItemRow } from "../db/schema";
import {
  foldFormula,
  normalizeShortText,
  scoreResponse,
  shortTextMatches,
  tableCellMatches,
} from "../lib/scoring/auto";

describe("shortTextMatches — keypad notation vs a plain key (4b slice 1a)", () => {
  test.each([
    // [label, student answer (keypad-shaped), teacher key (plain)]
    ["fraction: \\frac{1}{2} ≡ 1/2", "\\frac{1}{2}", "1/2"],
    ["fraction: \\dfrac is the same command", "\\dfrac{1}{2}", "1/2"],
    ["fraction: a multi-atom side keeps its parentheses", "\\frac{x+1}{2}", "(x+1)/2"],
    ["fraction: a teacher's (1)/(2) drops its single-atom parens", "\\frac{1}{2}", "(1)/(2)"],
    ["fraction: a scientific-notation numerator is one atom", "\\frac{10^{5}}{2}", "10^5/2"],
    ["fraction: one level of nesting", "\\frac{\\frac{1}{2}}{3}", "(1/2)/3"],
    ["exponent: braces go, the caret stays", "10^{-4}", "10^-4"],
    ["subscript: H_{2}O ≡ H2O", "H_{2}O", "H2O"],
    ["root: \\sqrt{2} ≡ sqrt(2)", "\\sqrt{2}", "sqrt(2)"],
    ["root: \\sqrt{2} ≡ √2", "\\sqrt{2}", "√2"],
    ["root: sqrt 2 (no parentheses) ≡ √2", "√2", "sqrt 2"],
    ["root: √(2) drops its single-atom parens", "√(2)", "√2"],
    ["root: a multi-atom radicand keeps them", "\\sqrt{x+1}", "√(x+1)"],
    ["times: 3.2 × 10^{5} ≡ 3.2 x 10^5", "3.2 × 10^{5}", "3.2 x 10^5"],
    ["times: 2×3 ≡ 2x3", "2×3", "2x3"],
    ["times: \\times", "3\\times4", "3×4"],
    ["times: \\cdot", "3\\cdot4", "3×4"],
    ["times: the middle dot", "3·4", "3×4"],
    ["times: an asterisk", "3*4", "3×4"],
    ["divided by: \\div", "6\\div2", "6÷2"],
    ["plus or minus: \\pm", "5\\pm2", "5±2"],
    ["plus or minus: \\plusminus (the K-12 macro)", "5\\plusminus2", "5±2"],
    ["plus or minus: +/-", "5+/-2", "5±2"],
    ["plus or minus: +-", "5+-2", "5±2"],
    ["≤: \\le", "x\\le5", "x≤5"],
    ["≤: \\leq is not half-eaten by \\le", "x\\leq5", "x≤5"],
    ["≤: <=", "x≤5", "x<=5"],
    ["≥: \\ge", "x\\ge5", "x≥5"],
    ["≥: \\geq", "x\\geq5", "x≥5"],
    ["≥: >=", "x≥5", "x>=5"],
    ["≠: \\ne", "x\\ne5", "x≠5"],
    ["≠: \\neq", "x\\neq5", "x≠5"],
    ["≠: !=", "x≠5", "x!=5"],
    ["degrees: 45°C ≡ 45^\\circ C", "45°C", "45^\\circ C"],
    ["degrees: ^{\\circ}", "45°C", "45^{\\circ}C"],
    ["degrees: \\degree (the K-12 macro)", "45°C", "45\\degree C"],
    ["Greek: π ≡ \\pi", "π", "\\pi"],
    ["Greek: Δh ≡ \\Delta H (case is folded)", "Δh", "\\Delta H"],
    ["Greek: Σ ≡ \\Sigma", "Σ", "\\Sigma"],
    ["Greek: ω ≡ \\omega", "ω", "\\omega"],
    ["Greek: a \\var… variant folds onto its base letter", "ε", "\\varepsilon"],
    ["Greek: \\pi is not eaten out of \\varpi", "π", "\\varpi"],
    ["Unicode superscript: x² ≡ x^2", "x²", "x^2"],
    ["Unicode superscript: a negative run 10⁻⁴ ≡ 10^{-4}", "10⁻⁴", "10^{-4}"],
    ["Unicode subscript: H₂O ≡ H2O", "H₂O", "H2O"],
    ["→ is in the trigger set (the fold drops the spacing)", "a → b", "a→b"],
    ["∞ is in the trigger set", "1 ∞", "1∞"],
    ["the fold is symmetric — a teacher may key in keypad notation", "1/2", "\\frac{1}{2}"],
  ] as const)("%s", (_label, response, key) => {
    expect(shortTextMatches(response, key)).toBe(true);
  });
});

describe("shortTextMatches — the limits, pinned (4b slice 1a)", () => {
  test.each([
    // [label, student answer, teacher key] — each of these must NOT match.
    ["a mixed number is not a slash fraction (recorded limit)", "1\\frac{1}{2}", "1 1/2"],
    ["notation, not value: 1/2 is not 0.5", "\\frac{1}{2}", "0.5"],
    ["notation, not value: \\frac{1}{2} is not \\frac{2}{4}", "\\frac{1}{2}", "\\frac{2}{4}"],
    ["the fold does not reorder: 2×3 is not 3×2", "2×3", "3×2"],
    ["degrees-the-word is not a synonym for °", "45°C", "45 degrees"],
    ["the plain path still rejects cellwall", "cellwall", "cell wall"],
    ["D-1.3 is narrow: no digits around the x, so no times sign", "the x axis", "the×axis"],
    ["D-1.3 is narrow: 2x is a variable, not 2×", "2x", "2×"],
    ["an exponent is still not a digit", "10^4", "104"],
    ["parentheses away from a / or √ are kept: (2)(3) is a product, not 23", "(2)(3)^{1}", "23^{1}"],
    ["parentheses away from a / or √ are kept: f(x) stays f(x)", "f(x)^{2}", "fx^{2}"],
  ] as const)("%s", (_label, response, key) => {
    expect(shortTextMatches(response, key)).toBe(false);
  });

  test("no math markup on either side never reaches the fold", () => {
    // A prose key with a plain `x` in it: the plain comparison decides, and
    // the widened trigger set does not fire on ordinary words.
    expect(shortTextMatches("x marks the spot", "x marks the spot")).toBe(true);
    expect(shortTextMatches("xmarks the spot", "x marks the spot")).toBe(false);
    expect(shortTextMatches("cell wall", "cell   WALL")).toBe(true);
  });
});

describe("foldFormula — the canonical form each notation reaches", () => {
  test.each([
    ["\\frac{1}{2}", "1/2"],
    ["\\frac{x+1}{2}", "(x+1)/2"],
    ["1\\frac{1}{2}", "1(1/2)"],
    ["\\sqrt{2}", "√2"],
    ["sqrt(x+1)", "√(x+1)"],
    ["3.2 x 10^5", "3.2×10^5"],
    ["x²", "x^2"],
    ["h₂o", "h2o"],
    ["45^\\circ c", "45°c"],
    ["$\\mathrm{k_2cr_2o_7}$", "k2cr2o7"],
  ] as const)("%s → %s", (input, expected) => {
    expect(foldFormula(normalizeShortText(input))).toBe(expected);
  });
});

// The end-to-end shape: a short-text item with a plain key scores the
// keypad's output, and the table cell rule still delegates to the same fold.
function fakeItem(partial: Partial<ItemRow> & { type: string }): ItemRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    assessment_id: "00000000-0000-0000-0000-000000000002",
    position: 0,
    stem: "stem",
    choices: [],
    correct_choice_ids: [],
    correct_answer: null,
    config: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...partial,
  } as ItemRow;
}

describe("scoreResponse / tableCellMatches with the widened fold", () => {
  test("a short_text item with a plain key scores the keypad's \\frac", () => {
    const item = fakeItem({ type: "short_text", correct_answer: "1/2" });
    expect(scoreResponse(item, { type: "short_text", text: "\\frac{1}{2}" })).toEqual({
      points: 1,
      max_points: 1,
    });
    expect(scoreResponse(item, { type: "short_text", text: "0.5" })).toEqual({
      points: 0,
      max_points: 1,
    });
  });

  test("tableCellMatches still compares decimals as numbers and folds the rest", () => {
    expect(tableCellMatches("1.50", "1.5")).toBe(true);
    expect(tableCellMatches("h₂o", "H2O")).toBe(true);
    expect(tableCellMatches("3.2 × 10^{5}", "3.2 x 10^5")).toBe(true);
    expect(tableCellMatches("104", "10^4")).toBe(false);
  });
});
