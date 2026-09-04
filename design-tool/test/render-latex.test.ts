import { describe, expect, test } from "bun:test";
import { K12_MACROS, renderLatex } from "../lib/math/renderLatex";

describe("renderLatex — plain text", () => {
  test("HTML-escapes plain text with no math", () => {
    expect(renderLatex("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  test("empty string returns empty", () => {
    expect(renderLatex("")).toBe("");
  });

  test("non-string returns empty", () => {
    expect(renderLatex(undefined as unknown as string)).toBe("");
  });
});

describe("renderLatex — inline math", () => {
  test("$x^2$ produces a KaTeX inline span", () => {
    const out = renderLatex("If $x^2 = 9$ then x is ±3.");
    expect(out).toContain("If ");
    expect(out).toContain("class=\"katex\"");
    expect(out).toContain(" then x is ±3.");
  });

  test("matches `$` only when paired — single `$` is left as text", () => {
    // No matching close → not treated as math.
    const out = renderLatex("price is $5");
    expect(out).toContain("price is $5");
    expect(out).not.toContain("class=\"katex\"");
  });

  test("respects backslash-escaped dollars (\\$ stays a literal $)", () => {
    const out = renderLatex("\\$5 and \\$10");
    expect(out).toBe("$5 and $10");
  });
});

describe("renderLatex — display math", () => {
  test("$$...$$ uses displayMode", () => {
    const out = renderLatex("$$\\int_0^1 x\\,dx$$");
    expect(out).toContain("class=\"katex-display\"");
  });
});

describe("renderLatex — error handling", () => {
  test("broken LaTeX renders inline-red (KaTeX errorColor) without throwing", () => {
    const out = renderLatex("$\\frac{1$");
    // KaTeX emits an inline span with color: #cc0000 for the bad
    // expression; we don't bail out with an exception.
    expect(out).toContain("#cc0000");
    expect(out).not.toContain("Uncaught");
  });
});

describe("renderLatex — K-12 macros", () => {
  test("\\degree renders as the degree symbol", () => {
    const out = renderLatex("$45\\degree$");
    expect(out).toContain("class=\"katex\"");
    // The output HTML contains the circ glyph; we just check it doesn't
    // fall back to an error span.
    expect(out).not.toContain("#cc0000");
  });

  test("\\half expands to a fraction", () => {
    const out = renderLatex("$\\half$");
    expect(out).toContain("class=\"katex\"");
    expect(out).toContain("frac");
  });

  // E16: K12_MACROS is Object.freeze'd (correctly — it is a shared export),
  // but KaTeX writes user-defined macros straight into whatever object it is
  // handed. Passing the frozen export made every \def / \gdef / \newcommand
  // stem throw "Attempting to define property on object that is not
  // extensible" — a TypeError that throwOnError:false does NOT cover — so the
  // stem rendered as an error while PoC-B's fresh-object path rendered it
  // fine. Copy at the render boundary instead.
  test.each([
    ["\\def", String.raw`$\def\vv{v}\vv = 3$`],
    ["\\gdef", String.raw`$\gdef\ww{w}\ww = 4$`],
    ["\\newcommand", String.raw`$\newcommand{\zz}{z}\zz = 5$`],
  ])("a user-defined macro via %s renders as math, not an error", (_label, input) => {
    const out = renderLatex(input);
    expect(out).toContain('class="katex"');
    expect(out).not.toContain("#cc0000");
    expect(out).not.toContain("math-error");
  });

  test("K12_MACROS is not mutated by a \\gdef stem", () => {
    const before = Object.keys(K12_MACROS).sort();
    renderLatex(String.raw`$\gdef\leaky{q}\leaky$`);
    expect(Object.keys(K12_MACROS).sort()).toEqual(before);
  });

  test("a \\gdef macro does not leak into a later stem", () => {
    renderLatex(String.raw`$\gdef\leaky{q}\leaky$`);
    // \leaky must be unknown here — if the macros object were shared and
    // mutable, KaTeX would resolve it and render clean math instead.
    const out = renderLatex(String.raw`$\leaky$`);
    expect(out).toContain("#cc0000");
  });
});

describe("renderLatex — mixed content ordering", () => {
  test("text + math + text + math + text round-trips in order", () => {
    const out = renderLatex("a $x$ b $y$ c");
    // Three text runs each in order; can detect by index
    const a = out.indexOf("a ");
    const xMath = out.indexOf("class=\"katex\"");
    const b = out.indexOf(" b ");
    const yMath = out.indexOf("class=\"katex\"", xMath + 1);
    const c = out.lastIndexOf(" c");
    expect(a).toBeLessThan(xMath);
    expect(xMath).toBeLessThan(b);
    expect(b).toBeLessThan(yMath);
    expect(yMath).toBeLessThan(c);
  });
});
