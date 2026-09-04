// K-12-flavored KaTeX macros. The single source of truth for both the
// design-tool's SSR renderer (lib/math/renderLatex.ts) and PoC-B's
// inline-JS renderer in TestRunner.swift, which consumes a generated
// Swift constant produced by poc-b-test-loop/client/scripts/vendor-
// katex-macros.mjs. Add macros sparingly — each one is one more thing
// every future implementer has to remember, and removing one is a
// breaking change for every saved stem.

export const K12_MACROS: Readonly<Record<string, string>> = Object.freeze({
  "\\degree": "^\\circ",
  "\\percent": "\\%",
  "\\plusminus": "\\pm",
  "\\half": "\\frac{1}{2}",
  "\\third": "\\frac{1}{3}",
  "\\quarter": "\\frac{1}{4}",
});
