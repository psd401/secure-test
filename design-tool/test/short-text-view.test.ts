// Roadmap 4b-f (2026-09-14, docs/math-entry-design.md §Follow-ups): the tex a
// teacher-side surface builds from a short-text answer has to be the SAME tex
// the client's `formulaTex` builds, or the two sides show different pictures of
// the same answer. These cases are the client's own (AssessmentPage.swift) plus
// the half-typed `\frac{` that slice S-4 made fall back to plain text.
import { describe, expect, test } from "bun:test";
import {
  renderShortTextAnswer,
  shortTextTex,
} from "../lib/reporting/shortTextView";

describe("shortTextTex", () => {
  test("wraps the typed answer in \\mathrm", () => {
    expect(shortTextTex("4^2")).toBe("\\mathrm{4^2}");
    expect(shortTextTex("H_2O")).toBe("\\mathrm{H_2O}");
  });

  test("a whitespace run becomes \\ (a real space inside \\mathrm)", () => {
    expect(shortTextTex("3.2 x 10^5")).toBe("\\mathrm{3.2\\ x\\ 10^5}");
    expect(shortTextTex("  1   +  2  ")).toBe("\\mathrm{1\\ +\\ 2}");
  });

  test("the student's own dollars are stripped, never treated as delimiters", () => {
    expect(shortTextTex("$x$")).toBe("\\mathrm{x}");
  });

  test("TeX control characters are escaped", () => {
    expect(shortTextTex("100%")).toBe("\\mathrm{100\\%}");
    expect(shortTextTex("a#b&c~d")).toBe("\\mathrm{a\\#b\\&c\\~d}");
  });

  test("empty and whitespace-only give the empty string", () => {
    expect(shortTextTex("")).toBe("");
    expect(shortTextTex("   ")).toBe("");
  });
});

describe("renderShortTextAnswer", () => {
  test("math that parses comes back as KaTeX HTML", () => {
    const html = renderShortTextAnswer("4^2");
    expect(html).toContain('class="katex"');
    expect(html).toContain("mathrm");
    // The exponent is laid out, not printed as `4^2`.
    expect(html).not.toContain("4^2");
  });

  test("a half-typed \\frac{ falls back to escaped plain text", () => {
    const html = renderShortTextAnswer("\\frac{");
    expect(html).toBe('<span class="short-text-plain">\\frac{</span>');
  });

  test("the fallback escapes HTML — never returns raw input", () => {
    const html = renderShortTextAnswer("\\frac{<script>x</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("a blank answer renders nothing (the page prints its own placeholder)", () => {
    expect(renderShortTextAnswer("")).toBe('<span class="short-text-plain"></span>');
  });
});
