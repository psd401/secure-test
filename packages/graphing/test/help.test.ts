import { describe, expect, test } from "bun:test";
import { caretStructure, helpSections, structureHint, structureOf } from "../src/ui/help";

const text = (mode: Parameters<typeof helpSections>[0], sqrtKey = true) =>
  helpSections(mode, sqrtKey).flatMap((s) => [s.title, ...s.items]).join(" ");

/** Flesch–Kincaid grade level, with a vowel-group syllable estimate. */
function gradeLevel(passage: string): number {
  const sentences = passage.split(/[.!?]+/).filter((s) => /[a-z]/i.test(s)).length;
  const words = passage.match(/[a-z][a-z']*/gi) ?? [];
  const syllables = words.reduce((n, w) => {
    const groups = w.toLowerCase().replace(/e$/, "").match(/[aeiouy]+/g);
    return n + Math.max(1, groups?.length ?? 1);
  }, 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
}

describe("calculator help", () => {
  test("each calculator's help names only what it has", () => {
    const four = text("four_function", false);
    expect(four).toContain("a/b makes a fraction");
    expect(four).not.toMatch(/√|Degrees|graph|abc/i);
    expect(text("four_function", true)).toContain("√ makes a square root");

    const sci = text("scientific");
    expect(sci).toContain("ⁿ√");
    expect(sci).toContain("Degrees");
    expect(sci).not.toMatch(/press S|Graph hides/i);

    const gr = text("graphing");
    expect(gr).toContain("press S");
    expect(gr).toContain("Graph hides");
    expect(gr).not.toContain("ans means");
  });

  test("every calculator says how to leave a power and how to close", () => {
    for (const m of ["four_function", "scientific", "graphing"] as const) {
      expect(text(m)).toContain("press → to move back out");
      expect(text(m)).toContain("Esc");
    }
  });

  test("reads at a middle-school level (grade 8 or below)", () => {
    for (const m of ["four_function", "scientific", "graphing"] as const) {
      expect(gradeLevel(text(m))).toBeLessThanOrEqual(8);
    }
    for (const s of ["exponent", "subscript", "fraction", "root"] as const) {
      expect(gradeLevel(structureHint(s))).toBeLessThanOrEqual(8);
    }
  });
});

describe("the exponent hint", () => {
  test("names the structure from the atom that closes it", () => {
    expect(structureOf("^{10}")).toBe("exponent");
    expect(structureOf("_2")).toBe("subscript");
    expect(structureOf("\\frac{3}{4}")).toBe("fraction");
    expect(structureOf("\\sqrt{2}")).toBe("root");
    expect(structureOf("\\sqrt[3]{8}")).toBe("root");
    expect(structureOf("\\left(1+2\\right)")).toBeNull();
    expect(structureOf("+")).toBeNull();
  });

  // Offsets as MathLive 0.111.1 reported them in a real browser (2026-10-24).
  const field = (rows: [number, string][], position: number) => ({
    position,
    lastOffset: rows.length - 1,
    getElementInfo: (q: number) => ({ depth: rows[q]![0], latex: rows[q]![1] }),
  });
  const power: [number, string][] = [[0, ""], [0, "x"], [1, ""], [1, "1"], [1, "0"], [0, "^{10}"], [0, "+"], [0, "1"]];
  const brackets: [number, string][] = [[0, ""], [1, ""], [1, "1"], [1, "+"], [1, "2"], [0, "\\left(1+2\\right)"], [0, "+"], [0, "1"]];

  test("inside x^{10} it is the power; outside, nothing", () => {
    expect(caretStructure(field(power, 3))).toBe("exponent");
    expect(caretStructure(field(power, 6))).toBeNull();
    expect(caretStructure(field(power, 1))).toBeNull();
  });

  test("inside brackets there is no hint", () => {
    expect(caretStructure(field(brackets, 3))).toBeNull();
  });
});
