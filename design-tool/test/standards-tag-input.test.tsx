// BG slice 2: the editor's Standards field. No DOM harness here (see
// test/co-teach-ui.test.tsx), so this checks the pure helpers it gates on and
// the static markup of its first render; typing, the list and the filters are
// manual rows in docs/design-tool-manual-checks.md.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StandardsTagInput } from "../components/app/StandardsTagInput";
import { addTag, counterpartLine } from "../lib/standards/tags";

const noop = () => {};

describe("addTag", () => {
  test("adds trimmed, ignores a duplicate, refuses the 11th and an over-long one", () => {
    expect(addTag(["a"], " b ")).toEqual({ ok: true, next: ["a", "b"] });
    expect(addTag(["a"], "a")).toEqual({ ok: true, next: ["a"] });
    expect(addTag([], "  ").ok).toBe(false);
    const ten = Array.from({ length: 10 }, (_, i) => `t${i}`);
    expect(addTag(ten, "t11").ok).toBe(false);
    expect(addTag(ten, "t3")).toEqual({ ok: true, next: ten });
    expect(addTag([], "x".repeat(81)).ok).toBe(false);
  });
});

describe("counterpartLine", () => {
  test("names the other scheme and every linked code", () => {
    expect(counterpartLine([{ code: "7.RP.A.2", scheme: "ccss2010" }])).toBe("2011: 7.RP.A.2");
    expect(
      counterpartLine([
        { code: "ELA.7.R.1", scheme: "wa2026" },
        { code: "ELA.7.R.2", scheme: "wa2026" },
      ]),
    ).toBe("2026: ELA.7.R.1, ELA.7.R.2");
    expect(counterpartLine([])).toBeNull();
  });
});

describe("<StandardsTagInput> first render", () => {
  test("custom and unknown tags render as typed, with a remove button each", () => {
    const html = renderToStaticMarkup(
      <StandardsTagInput value={["Unit 3 target", "ccss2020:X.Y"]} onChange={noop} suggestions={[]} />,
    );
    expect(html).toContain("Unit 3 target");
    expect(html).toContain("ccss2020:X.Y");
    expect(html).toContain('aria-label="Remove Unit 3 target"');
    expect(html).toContain('role="combobox"');
  });

  test("at 10 tags the input is disabled and the hint says why", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `T${i}`);
    const html = renderToStaticMarkup(<StandardsTagInput value={ten} onChange={noop} suggestions={[]} />);
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).toContain("the most a question can carry");
  });

  test("locked (Published): no remove buttons, no filters, input disabled", () => {
    const html = renderToStaticMarkup(
      <StandardsTagInput value={["Unit 3 target"]} onChange={noop} suggestions={[]} disabled />,
    );
    expect(html).not.toContain("Remove Unit 3 target");
    expect(html).not.toContain('aria-label="Subject"');
    expect(html).toMatch(/<input[^>]*disabled/);
  });
});
