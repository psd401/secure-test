import { describe, expect, test } from "bun:test";
import { MATH_DOLLAR_EXAMPLES, MATH_DOLLAR_RULE } from "@/lib/ai/mathPromptRule";
import { BATCH_SYSTEM_PROMPT } from "@/lib/ai/itemBatchCore";
import { ITEM_SYSTEM_PROMPT } from "@/lib/ai/itemGenCore";
import { PDF_EXTRACT_SYSTEM_PROMPT } from "@/lib/pdfImport/extractCore";
import { renderLatex } from "@/lib/math/renderLatex";
import { renderItemContent } from "@/lib/items/renderItemContent";

// Finding BG-E1: the prompt rule's examples must render the way the rule says
// under M-1, in both design-tool renderers.
describe("math dollar rule (BG-E1)", () => {
  test("every authoring prompt carries the rule", () => {
    for (const prompt of [BATCH_SYSTEM_PROMPT, ITEM_SYSTEM_PROMPT, PDF_EXTRACT_SYSTEM_PROMPT]) {
      expect(prompt).toContain(MATH_DOLLAR_RULE);
    }
  });

  test("the digit-led examples render as math; the currency example stays a dollar", () => {
    const isMath = (html: string) => html.includes("katex");
    for (const render of [renderLatex, (s: string) => renderItemContent(s, new Map())]) {
      expect(isMath(render(MATH_DOLLAR_EXAMPLES.digitLedPlain))).toBe(true);
      expect(isMath(render(MATH_DOLLAR_EXAMPLES.digitLedCommand))).toBe(true);
      expect(isMath(render(`Costs ${MATH_DOLLAR_EXAMPLES.currency} each`))).toBe(false);
    }
  });

  test("the failure the rule prevents: digit-led math without a command stays raw", () => {
    expect(renderLatex("$3x + 7 = 22$")).not.toContain("katex");
  });
});
