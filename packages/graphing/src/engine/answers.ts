// `ans` — the previous answer, for the scientific and four-function
// calculators (James, 2026-10-24: lay them out like Desmos's, which have an
// ans key). Each `ans` stands for the value of the nearest row above that has
// a number, so `ans × 2` on the next line keeps working from the last result.
// The graphing calculator does not use this: there `ans` would be a·n·s.

import { analyze, DEFAULT_SETTINGS, type Analysis, type Row, type Settings } from "./analyze";

const ANS = /\\operatorname\{ans\}|(?<![A-Za-z\\])ans(?![A-Za-z])/g;

export const NO_ANSWER_ABOVE = "There's no answer above to use yet";

/** A number as LaTeX the parser reads back exactly (no `1e-7`). */
function numberLatex(v: number): string {
  const s = String(v);
  const e = s.indexOf("e");
  const body = e < 0 ? s : `${s.slice(0, e)}\\cdot10^{${Number(s.slice(e + 1))}}`;
  return `\\left(${body}\\right)`;
}

export function analyzeWithAnswers(rows: readonly Row[], settings: Settings = DEFAULT_SETTINGS): Analysis[] {
  if (!rows.some((r) => new RegExp(ANS.source).test(r.latex))) return analyze(rows, settings);
  // Pass 1, top to bottom: each row's value is known before the rows below
  // need it.
  const resolved: Row[] = [];
  const noAnswer = new Set<number>();
  let last: number | null = null;
  rows.forEach((r, i) => {
    let latex = r.latex;
    if (new RegExp(ANS.source).test(latex)) {
      if (last === null) noAnswer.add(i);
      else latex = latex.replace(ANS, numberLatex(last));
    }
    resolved.push({ id: r.id, latex });
    const a = analyze(resolved, settings)[i]!;
    if (!noAnswer.has(i) && a.kind === "value" && typeof a.value === "number" && Number.isFinite(a.value)) last = a.value;
  });
  // Pass 2: every row together, so definitions anywhere still resolve.
  return analyze(resolved, settings).map((a, i) =>
    noAnswer.has(i) ? { kind: "error", message: NO_ANSWER_ABOVE, missing: [] } : a,
  );
}
