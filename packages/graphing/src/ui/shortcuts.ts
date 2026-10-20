// Words MathLive turns into symbols as they are typed. MathLive's own table
// is for general mathematics (∑, ∫, ℝ, `ch` for cosh, `log` with a base
// slot); a school graphing calculator wants only what its parser reads, and
// nothing that fires inside an ordinary product like `c·h`.

export const INLINE_SHORTCUTS: Record<string, string> = {
  pi: "\\pi",
  tau: "\\tau",
  theta: "\\theta",
  alpha: "\\alpha",
  beta: "\\beta",
  gamma: "\\gamma",
  delta: "\\delta",
  lambda: "\\lambda",
  mu: "\\mu",
  phi: "\\phi",
  sigma: "\\sigma",
  omega: "\\omega",
  sqrt: "\\sqrt{#?}",
  cbrt: "\\sqrt[3]{#?}",
  sin: "\\sin",
  cos: "\\cos",
  tan: "\\tan",
  sec: "\\sec",
  csc: "\\csc",
  cot: "\\cot",
  arcsin: "\\arcsin",
  arccos: "\\arccos",
  arctan: "\\arctan",
  sinh: "\\sinh",
  cosh: "\\cosh",
  tanh: "\\tanh",
  ln: "\\ln",
  // Base 10, as on a school calculator; log_b is typed with an underscore.
  log: "\\log",
  exp: "\\exp",
  ">=": "\\ge",
  "<=": "\\le",
};
