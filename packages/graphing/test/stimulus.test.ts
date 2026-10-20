import { describe, expect, test } from "bun:test";
import { describeGraph, latexToText } from "../src/engine/describe";
import { renderGraphSvg } from "../src/engine/svg";

describe("latexToText", () => {
  test.each([
    ["y=x^{2}-4", "y = x² − 4"],
    ["y=x^2-4x+3", "y = x² − 4x + 3"],
    ["y=\\frac{1}{2}x+3", "y = (1)/(2)x + 3"],
    ["y=\\sqrt{x}", "y = √(x)"],
    ["y=\\sqrt[3]{x}", "y = 3√(x)"],
    ["x^{2}+y^{2}=16", "x² + y² = 16"],
    ["y\\le\\sin\\left(x\\right)", "y ≤ sin (x)"],
    ["y=2^{x}", "y = 2^(x)"],
    ["\\left(1,2\\right)", "(1,2)"],
    ["y=\\operatorname{\\mathrm{mean}}\\left(1,2\\right)", "y = mean(1,2)"],
    ["y=a\\cdot x", "y = a × x"],
  ])("%s → %s", (latex, text) => expect(latexToText(latex)).toBe(text));
});

describe("describeGraph", () => {
  const view = { xmin: -10, xmax: 10, ymin: -7.5, ymax: 7.5 };
  test("one, two and three expressions", () => {
    expect(describeGraph({ rows: [{ latex: "y=x^{2}-4" }], view })).toBe(
      "A graph of y = x² − 4, with x from −10 to 10 and y from −7.5 to 7.5.",
    );
    expect(describeGraph({ rows: [{ latex: "y=x" }, { latex: "y=-x" }], view })).toBe(
      "A graph of y = x and y = −x, with x from −10 to 10 and y from −7.5 to 7.5.",
    );
    expect(describeGraph({ rows: [{ latex: "y=1" }, { latex: "y=2" }, { latex: "y=3" }], view })).toContain(
      "y = 1, y = 2 and y = 3",
    );
  });

  test("hidden and empty rows are left out; nothing is an empty grid", () => {
    expect(describeGraph({ rows: [{ latex: "y=x", hidden: true }, { latex: " " }], view })).toBe(
      "An empty coordinate grid, with x from −10 to 10 and y from −7.5 to 7.5.",
    );
  });
});

describe("renderGraphSvg", () => {
  const view = { xmin: -10, xmax: 10, ymin: -7.5, ymax: 7.5 };
  const svg = (rows: { latex: string; color?: string; hidden?: boolean }[], title?: string) =>
    renderGraphSvg({ rows, view }, { title });

  test("a self-contained, labelled image", () => {
    const s = svg([{ latex: "y=x^{2}-4" }], "A parabola");
    expect(s.startsWith("<svg ")).toBe(true);
    expect(s.endsWith("</svg>")).toBe(true);
    expect(s).toContain('role="img"');
    expect(s).toContain('aria-label="A parabola"');
    expect(s).toContain("<title>A parabola</title>");
    expect(s).not.toContain("<script");
    expect(s).not.toMatch(/\son\w+=/);
  });

  test("the title is escaped", () => {
    const s = svg([], 'x < 3 & "y" > 2');
    expect(s).toContain("x &lt; 3 &amp; &quot;y&quot; &gt; 2");
    expect(s).not.toContain('"y" > 2');
  });

  test("curves, points, dashed strict inequalities, implicit curves", () => {
    const s = svg([
      { latex: "y=x^{2}-4", color: "#1f5fa8" },
      { latex: "\\left(2,3\\right)", color: "#b42b2b" },
      { latex: "y<x", color: "#2c7a37" },
      { latex: "x^{2}+y^{2}=16", color: "#6a3d9a" },
    ]);
    expect(s).toContain('stroke="#1f5fa8"');
    expect(s).toMatch(/<circle cx="288" cy="108" r="4\.5" fill="#b42b2b"/);
    expect(s).toContain('stroke-dasharray="8 6"');
    expect(s).toContain('fill="#2c7a37" fill-opacity="0.22"');
    expect(s).toContain('stroke="#6a3d9a"');
  });

  test("hidden rows and errors draw nothing; a bad colour falls back", () => {
    const s = svg([{ latex: "y=x", hidden: true }, { latex: "y=" }, { latex: "y=2x", color: "red" }]);
    expect(s.match(/stroke="#[0-9a-f]{6}" stroke-width="2.5"/g)?.length).toBe(1);
    // The third row's colour is unreadable, so it gets the third default.
    expect(s).toContain('stroke="#2c7a37"');
  });

  test("axis labels are there", () => {
    const s = svg([]);
    expect(s).toContain(">5</text>");
    expect(s).toContain(">−5</text>");
  });
});
