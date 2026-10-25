// The calculator's own help (James, 2026-10-24): a student in a locked test
// cannot open a web page, so the instructions live inside the calculator and
// show only what this calculator has. Written for a middle-school reader —
// short sentences, everyday words; `test/help.test.ts` keeps the grade level
// in check. The teacher help page (`/help.html`, "Give students a
// calculator") repeats the same text.
//
// Also here: the exponent hint. Leaving an exponent, fraction or root takes
// the → key, which students may not guess (James, 2026-10-24), so while the
// caret is inside one a line under the list says how to get out.

import type { Mode } from "./presets";

export interface HelpSection {
  title: string;
  items: string[];
}

export function helpSections(mode: Mode, sqrtKey: boolean): HelpSection[] {
  const graphing = mode === "graphing";
  const sections: HelpSection[] = [];

  sections.push({
    title: "Type a problem",
    items: graphing
      ? [
          "Type an equation, like y = 2x + 1. It shows on the graph.",
          "Type a number problem, like 3 × 4. The answer shows under it.",
          "Press Enter or ↵ to start a new line.",
        ]
      : [
          "Type a problem, like 3 × 4. The answer shows under it.",
          "Press Enter or ↵ to start a new line.",
          "ans means the answer on the line above. Try ans + 1.",
        ],
  });

  const keys: string[] = [];
  if (mode === "four_function") {
    keys.push("Use ( and ) to group parts of a problem.");
    keys.push(sqrtKey ? "√ makes a square root." : "a/b makes a fraction.");
    keys.push("⌫ deletes one thing. clear empties the line.");
    keys.push("↶ undoes your last step. ↷ puts it back.");
  } else {
    keys.push("a² squares a number. aᵇ makes any power.");
    keys.push("√ makes a square root. a/b makes a fraction.");
    if (mode === "scientific") keys.push("ⁿ√ makes any root, like a cube root.");
    keys.push("The abc and func tabs have letters and more functions.");
    keys.push("⌫ deletes one thing.");
  }
  sections.push({ title: "Use the keys", items: keys });

  sections.push(
    mode === "four_function"
      ? {
          title: sqrtKey ? "Get out of a root" : "Get out of a fraction",
          items: [`After you type in a ${sqrtKey ? "root" : "fraction"}, press → to move back out.`],
        }
      : {
          title: "Get out of a fraction or power",
          items: [
            "After you type in a fraction, power or root, press → to move back out.",
            "One digit in a power, like x², moves you out by itself.",
          ],
        },
  );

  if (mode !== "four_function") {
    sections.push({
      title: "Angles",
      items: ["Degrees and Radians at the top choose how angles are measured."],
    });
  }

  if (graphing) {
    sections.push({
      title: "Use the graph",
      items: [
        "Graph hides or shows the graph.",
        "Drag the graph to move it. Pinch or use + and − to zoom.",
        "Click a curve to see the points where it crosses.",
        "Click the graph, then press S to hear it in words.",
        "Press T to walk along a curve with the arrow keys.",
        "Press H to hear the curve as sound.",
      ],
    });
  }

  sections.push({
    title: "Close it",
    items: [
      "Press Esc or × to close the calculator.",
      "Tab can move you out of the calculator. If you can't see where you are typing, press Esc.",
    ],
  });
  return sections;
}

export type Structure = "exponent" | "subscript" | "fraction" | "root";

/**
 * What a structure's LaTeX is, from MathLive's `getElementInfo(...).latex`
 * for the atom that closes it (`^{10}`, `_2`, `\frac{3}{4}`, `\sqrt{2}`).
 * Brackets (`\left( … \right)`) and anything else give null: a closing
 * bracket is typed, so no hint is needed.
 */
export function structureOf(latex: string): Structure | null {
  const s = latex.trim();
  if (s.startsWith("^")) return "exponent";
  if (s.startsWith("_")) return "subscript";
  if (/^\\(d|t)?frac\b/.test(s)) return "fraction";
  if (s.startsWith("\\sqrt")) return "root";
  return null;
}

export function structureHint(s: Structure): string {
  const where = { exponent: "the power", subscript: "the small number below", fraction: "the fraction", root: "the root" }[s];
  return `You're in ${where}. Press → to move back out.`;
}

/** The smallest structure around the caret, read through MathLive's public API. */
export function caretStructure(field: {
  position: number;
  lastOffset: number;
  getElementInfo(offset: number): { depth?: number; latex?: string } | undefined;
}): Structure | null {
  const at = field.position;
  const depth = field.getElementInfo(at)?.depth ?? 0;
  if (depth === 0) return null;
  // The first offset after the caret that sits shallower is the atom that
  // closes the innermost structure around it.
  for (let q = at + 1; q <= field.lastOffset; q++) {
    const info = field.getElementInfo(q);
    if ((info?.depth ?? 0) < depth) return structureOf(info?.latex ?? "");
  }
  return null;
}
