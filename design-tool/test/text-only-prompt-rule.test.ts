import { describe, expect, test } from "bun:test";
import { BATCH_SYSTEM_PROMPT } from "@/lib/ai/itemBatchCore";
import { ITEM_SYSTEM_PROMPT } from "@/lib/ai/itemGenCore";
import { TEXT_ONLY_RULE } from "@/lib/ai/textOnlyPromptRule";

// Finding F-6 (2026-10-27): a drafted question cited "the diagram below" and
// none existed. Both item-writing prompts say items are text only.
describe("text-only rule (F-6)", () => {
  test("every item-writing prompt carries the rule", () => {
    for (const prompt of [BATCH_SYSTEM_PROMPT, ITEM_SYSTEM_PROMPT]) {
      expect(prompt).toContain(TEXT_ONLY_RULE);
    }
  });
});
