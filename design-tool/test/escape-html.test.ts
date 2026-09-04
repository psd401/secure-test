import { describe, expect, test } from "bun:test";
import { escapeHtml } from "../lib/escapeHtml";

// The XSS chokepoint. This lived as three byte-identical private copies in
// renderLatex / renderHtml / renderItemContent with no test of its own — the
// behavior was only covered indirectly, per render surface.
describe("escapeHtml", () => {
  test("escapes all five significant characters", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml('"')).toBe("&quot;");
    expect(escapeHtml("'")).toBe("&#39;");
  });

  test("escapes & first so replacements are not double-escaped", () => {
    // If & were escaped last, "<" would become "&amp;lt;" and render as
    // literal "&lt;" instead of "<".
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  test("neutralizes a script tag", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  test("neutralizes attribute-context breakouts", () => {
    expect(escapeHtml('" onerror="alert(1)')).toBe(
      "&quot; onerror=&quot;alert(1)",
    );
    expect(escapeHtml("' onerror='alert(1)")).toBe(
      "&#39; onerror=&#39;alert(1)",
    );
  });

  test("leaves ordinary text untouched", () => {
    expect(escapeHtml("")).toBe("");
    expect(escapeHtml("What is 2 + 2?")).toBe("What is 2 + 2?");
    expect(escapeHtml("café — naïve")).toBe("café — naïve");
  });

  test("escapes every occurrence, not just the first", () => {
    expect(escapeHtml("<<>>")).toBe("&lt;&lt;&gt;&gt;");
    expect(escapeHtml("a&b&c")).toBe("a&amp;b&amp;c");
  });

  test("output contains no unescaped significant characters", () => {
    const nasty = `<img src=x onerror="alert('&')">`;
    const out = escapeHtml(nasty);
    for (const ch of ["<", ">", '"', "'"]) {
      expect(out).not.toContain(ch);
    }
  });
});
