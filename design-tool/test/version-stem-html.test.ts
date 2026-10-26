import { describe, expect, test } from "bun:test";
import { versionStemHtml } from "@/lib/authoring/versionStemHtml";

const none = new Map();

describe("versionStemHtml", () => {
  test("emphasis and math render; the markers do not show", () => {
    const html = versionStemHtml({ type: "multiple_choice", stem: "_Read_ **this**: $x+1$", config: {} }, none);
    expect(html).toContain("<em>Read</em>");
    expect(html).toContain("<strong>this</strong>");
    expect(html).toContain("katex");
    expect(html).not.toMatch(/\*\*|\$/);
  });

  test("text is escaped", () => {
    expect(versionStemHtml({ type: "short_text", stem: "<script>x</script>", config: {} }, none)).not.toContain("<script>");
  });

  test("a fill-in-the-blank stem shows numbered gaps; a marker naming no blank stays literal", () => {
    const html = versionStemHtml(
      { type: "fill_blank", stem: "The **[[b1]]** sun and [[b1]] and [[zz]].", config: { blanks: [{ id: "b1", kind: "text" }] } },
      none,
    );
    expect(html).toContain('<strong><span aria-label="Blank 1">[1] ____</span></strong>');
    expect(html.match(/aria-label="Blank/g)?.length).toBe(1);
    expect(html).toContain("[[zz]]");
  });
});
