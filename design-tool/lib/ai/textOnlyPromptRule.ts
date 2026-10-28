// Finding F-6 (docs/design-tool-manual-checks.md, run of 2026-10-27): a
// Bedrock-drafted question began "The diagram below shows a forest food
// web…" with no diagram — generated items are text only, nothing is ever
// attached. Every item-writing prompt carries this rule;
// test/text-only-prompt-rule.test.ts checks that it does.
export const TEXT_ONLY_RULE =
  "Items are text only: nothing is attached to them. Never refer to a diagram, picture, graph, chart, table, map or figure " +
  '("the diagram below", "shown above"); put everything a student needs in the words of the stem.';
