// Finding BG-E1 (docs/batch-item-generation-design.md, slice 7 evidence run):
// under rule M-1 a `$` followed by a digit opens math only when the run holds
// a LaTeX command, `^` or `_` (identical in lib/math/renderLatex.ts,
// lib/items/renderItemContent.ts and the client's page JS). Model-written
// math such as `$3x + 7 = 22$` therefore rendered as raw text. Every prompt
// that asks for $...$ math carries this rule; test/math-prompt-rule.test.ts
// renders its examples so the rule and the renderers cannot drift apart.
export const MATH_DOLLAR_EXAMPLES = {
  currency: "\\$12.50",
  digitLedPlain: "${3x + 7 = 22}$",
  digitLedCommand: "$3.5 \\times 10^{4}$",
} as const;

export const MATH_DOLLAR_RULE =
  `Write a dollar amount with a backslash before the sign (${MATH_DOLLAR_EXAMPLES.currency}), never as math. ` +
  `Math that starts with a digit and has no LaTeX command, ^ or _ goes inside \${...}$ ` +
  `(${MATH_DOLLAR_EXAMPLES.digitLedPlain}, \${2(n + 6) = 26}$); math that starts with a digit and has one is fine as $...$ ` +
  `(${MATH_DOLLAR_EXAMPLES.digitLedCommand}).`;
