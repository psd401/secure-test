import { describe, expect, test } from "bun:test";
import { analyze } from "../src/engine/analyze";
import { curveColor, luminance } from "../src/ui/graph";
import { ANSWER_COLOR, FIXED_COLOR, KEY_COLOR } from "../src/ui/graphAnswer";
import { PALETTE } from "../src/ui/state";
import { isMode, presetFor, PRESETS } from "../src/ui/presets";
import { fourPage, SCIENTIFIC_PAGE } from "../src/ui/keypad";

const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe("presets", () => {
  test("every mode has full and state_wa", () => {
    for (const mode of ["graphing", "scientific", "four_function"] as const) {
      expect(Object.keys(PRESETS[mode]).sort()).toEqual(["full", "state_wa"]);
    }
  });

  test("unknown names fall back to full", () => {
    expect(presetFor("nope", "graphing")).toBe(PRESETS.graphing.full!);
    expect(presetFor(undefined, "scientific")).toBe(PRESETS.scientific.full!);
  });

  test("the WA state-test configuration", () => {
    const g = presetFor("state_wa", "graphing");
    expect(g.degrees).toBe(true);
    expect(g.disabled.sort()).toEqual(["advancedStats", "geometry", "hyperbolic", "reciprocalTrig"]);
    expect(presetFor("state_wa", "scientific").functions).toBe(false);
    expect(presetFor("state_wa", "four_function").sqrtKey).toBe(false);
    expect(presetFor("full", "four_function").sqrtKey).toBe(true);
  });

  test("four-function disables every function family", () => {
    const s = { degrees: false, disabled: new Set(presetFor("full", "four_function").disabled), functions: false };
    expect(analyze([{ id: "a", latex: "\\sin(3)" }], s)[0]).toMatchObject({ kind: "error" });
    expect(analyze([{ id: "a", latex: "mean(1,2)" }], s)[0]).toMatchObject({ kind: "error" });
    expect(analyze([{ id: "a", latex: "\\frac{3}{4}+\\sqrt{16}" }], s)[0]).toEqual({ kind: "value", value: 4.75 });
    expect(analyze([{ id: "a", latex: "12\\times3\\div4" }], s)[0]).toEqual({ kind: "value", value: 9 });
  });

  test("the state-test four-function has no √ at all, typed or keyed", () => {
    const s = { degrees: false, disabled: new Set(presetFor("state_wa", "four_function").disabled), functions: false };
    expect(analyze([{ id: "a", latex: "\\sqrt{16}" }], s)[0]).toMatchObject({ kind: "error", message: "√ is not available on this calculator" });
    expect(analyze([{ id: "a", latex: "\\frac{3}{4}+2" }], s)[0]).toEqual({ kind: "value", value: 2.75 });
  });

  test("no function definitions where the preset says so", () => {
    const s = { degrees: true, disabled: new Set(presetFor("state_wa", "scientific").disabled), functions: false };
    expect(analyze([{ id: "a", latex: "f(x)=x^2" }], s)[0]).toMatchObject({
      kind: "error",
      message: "Functions can't be defined on this calculator",
    });
    expect(analyze([{ id: "a", latex: "a=3" }], s)[0]).toMatchObject({ kind: "slider" });
  });

  test("isMode", () => {
    expect(isMode("graphing")).toBe(true);
    expect(isMode("abacus")).toBe(false);
    expect(isMode(undefined)).toBe(false);
  });

  const faces = (rows: { label: string }[][]) => rows.map((r) => r.map((k) => k.label));

  test("four-function keypad: the Desmos WA layout (finding FF-1)", () => {
    expect(faces(fourPage(false))).toEqual([
      ["↶", "↷", "clear", "⌫"],
      ["(", ")", "a/b", "÷"],
      ["7", "8", "9", "×"],
      ["4", "5", "6", "−"],
      ["1", "2", "3", "+"],
      ["0", ".", "ans", "↵"],
    ]);
    // Desmos's public calculator has √ where the state test has the fraction.
    expect(faces(fourPage(true))[1]).toEqual(["(", ")", "√", "÷"]);
    for (const label of ["%", "a²", "="]) expect(fourPage(false).flat().map((k) => k.label)).not.toContain(label);
  });

  test("scientific main page: the Desmos WA layout", () => {
    expect(faces(SCIENTIFIC_PAGE)).toEqual([
      ["a²", "aᵇ", "|a|", "7", "8", "9", "÷", "%", "a/b"],
      ["√", "ⁿ√", "π", "4", "5", "6", "×", "←", "→"],
      ["sin", "cos", "tan", "1", "2", "3", "−", "⌫"],
      ["(", ")", ",", "0", ".", "ans", "+", "↵"],
    ]);
  });
});

describe("curve colours on the paper", () => {
  test("the palette is at least 4.5:1 on white and unchanged there", () => {
    for (const c of PALETTE) {
      expect(contrast(c, "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(curveColor(c, "#ffffff")).toBe(c);
    }
  });

  test("on a dark contrast set every colour is lifted to 4.5:1", () => {
    for (const paper of ["#000000", "#1a1a1a", "rgb(0, 0, 51)"]) {
      for (const c of PALETTE) {
        const shown = curveColor(c, paper);
        expect(contrast(shown, paper)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("the Graph it board's answer, key and given colours are lifted too (finding C-1)", () => {
    for (const paper of ["#000000", "#1a1a1a", "rgb(0, 0, 51)"]) {
      for (const c of [ANSWER_COLOR, KEY_COLOR, FIXED_COLOR]) {
        expect(contrast(curveColor(c, paper), paper)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("luminance reads hex and rgb()", () => {
    expect(luminance("#fff")).toBeCloseTo(1, 6);
    expect(luminance("#000000")).toBe(0);
    expect(luminance("rgb(255, 255, 255)")).toBeCloseTo(1, 6);
  });
});
