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

// MathLive binds Escape in a math field to its LaTeX mode (raw `\frac`-style
// typing, which a student has no use for). Since focus follows the panel
// (2026-10-21) the first expression has focus whenever the calculator opens,
// so that binding cancelled the key before the panel's own Escape could close
// it (finding E-1, 2026-10-24 hand-run). Dropping every Escape binding lets
// the key reach the panel.
export function withoutEscape<T extends { key: string }>(bindings: readonly T[]): T[] {
  return bindings.filter((b) => !/\[Escape\]/i.test(b.key));
}
