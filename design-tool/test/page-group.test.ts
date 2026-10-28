// Page groups (2026-10-28): the inferred rule in lib/authoring/pageGroup.ts.
import { describe, expect, test } from "bun:test";
import { isPageGroup } from "../lib/authoring/pageGroup";

describe("isPageGroup", () => {
  test("an empty set over two or more questions is a group", () => {
    expect(isPageGroup({ stimulus_text: "", sources: [] }, 2)).toBe(true);
    expect(isPageGroup({ stimulus_text: "  \n " }, 3)).toBe(true);
    expect(isPageGroup({ stimulus: "" }, 2)).toBe(true);
  });

  test("a set of one, text, a source or a source link makes it a stimulus", () => {
    expect(isPageGroup({ stimulus_text: "" }, 1)).toBe(false);
    expect(isPageGroup({ stimulus_text: "Read." }, 2)).toBe(false);
    expect(isPageGroup({ stimulus_text: "", sources: [{ label: "A", text: "" }] }, 2)).toBe(false);
    expect(isPageGroup({ stimulus_text: "", source_item_id: "x" }, 2)).toBe(false);
    expect(isPageGroup({ stimulus: "", source: { stem: "s", assessment_name: "a" } }, 2)).toBe(false);
  });
});
