// Stimulus graphs in the no-script preview / print (D-8): SVG from the engine.
import { describe, expect, test } from "bun:test";
import { renderStimulusGraph } from "../lib/preview/renderHtml";

describe("renderStimulusGraph", () => {
  const g = {
    rows: [{ latex: "y=x^{2}-4" }, { latex: "y=2x-1", hidden: true as const }],
    view: { xmin: -10, xmax: 10, ymin: -7.5, ymax: 7.5 },
    alt: "A parabola <with> \"quotes\"",
  };

  test("a figure with an SVG named by the alt text, a legend and the description", () => {
    const html = renderStimulusGraph(g);
    expect(html.startsWith('<figure class="graph-stimulus"><svg ')).toBe(true);
    expect(html).toContain('aria-label="A parabola &lt;with&gt; &quot;quotes&quot;"');
    expect(html).toContain("<li>y = x² − 4</li>");
    expect(html).not.toContain("2x − 1");
    expect(html).toContain('<p class="graph-alt">A parabola &lt;with&gt; &quot;quotes&quot;</p>');
    expect(html).not.toContain("<script");
  });
});
