// The graphing engine (docs/graphing-calculator-design.md D-4): pure
// functions only — no DOM — so the same code runs in the student page, the
// JSC harness and the design tool's server.

export type { Node, Relation, Statement } from "./ast";
export { freeVariables } from "./ast";
export { BUILTINS, type FunctionGroup } from "./builtins";
export { analyze, DEFAULT_SETTINGS, type Analysis, type Curve, type Row, type Settings } from "./analyze";
export { analyzeWithAnswers, NO_ANSWER_ABOVE } from "./answers";
export { CompileError } from "./compile";
export { formatNumber, formatNumberLatex } from "./format";
export { ParseError, parse } from "./parser";
export { clean, extrema, intersections, pointsOfInterest, zeros, type Poi, type PoiKind } from "./poi";
export { sampleCurve, type Polyline, type SampleOptions } from "./sample";
export { describeGraph, latexToText, type GraphForWords } from "./describe";
export { panFor, spokenNumber, summarizeCurve, summarizeGraph, sweep, toneFor, type Tone } from "./summary";

import type { Curve } from "./analyze";

/** The curve's function with its restriction applied (NaN outside it). */
export function restricted(c: Curve): (t: number) => number {
  const { f, restrict, of } = c;
  if (!restrict) return f;
  return (t) => {
    const v = f(t);
    const ok = of === "y" ? restrict(t, v) : restrict(v, t);
    return ok ? v : NaN;
  };
}
