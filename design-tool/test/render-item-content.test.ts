import { describe, expect, test } from "bun:test";
import {
  renderEmphasis,
  renderItemContent,
  type ResolvedAsset,
} from "../lib/items/renderItemContent";

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";

function resolvedMap(...ids: string[]): Map<string, ResolvedAsset> {
  const m = new Map<string, ResolvedAsset>();
  for (const id of ids) {
    m.set(id.toLowerCase(), { id, content_type: "image/png" });
  }
  return m;
}

describe("renderItemContent — plain text + escaping", () => {
  test("HTML-escapes plain text", () => {
    expect(renderItemContent("a & b < c", new Map())).toBe(
      "a &amp; b &lt; c",
    );
  });
  test("empty input returns empty", () => {
    expect(renderItemContent("", new Map())).toBe("");
  });
});

describe("renderItemContent — image refs", () => {
  test("resolves owned ref to an <img> pointing at the asset route", () => {
    const out = renderItemContent(
      `See ![chart](asset:${UUID_A}) below.`,
      resolvedMap(UUID_A),
    );
    expect(out).toContain(`src="/api/assets/${UUID_A}"`);
    expect(out).toContain('alt="chart"');
    expect(out).toContain('class="item-image"');
  });

  test("renders inline-red placeholder for an unresolved ref", () => {
    const out = renderItemContent(
      `![x](asset:${UUID_B})`,
      resolvedMap(UUID_A),
    );
    expect(out).toContain('class="image-missing"');
    expect(out).toContain("image not found");
    expect(out).not.toContain(`src="/api/assets/${UUID_B}"`);
  });

  test("escapes the alt text", () => {
    const out = renderItemContent(
      `![<script>](asset:${UUID_A})`,
      resolvedMap(UUID_A),
    );
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("renderItemContent — math + image in one stem", () => {
  test("renders KaTeX and <img> side-by-side", () => {
    const out = renderItemContent(
      `Refer to ![diagram](asset:${UUID_A}). What is $x^2$?`,
      resolvedMap(UUID_A),
    );
    expect(out).toContain("class=\"katex\"");
    expect(out).toContain(`src="/api/assets/${UUID_A}"`);
  });

  test("bad LaTeX still renders inline-red even when image refs are present", () => {
    const out = renderItemContent(
      `$\\frac{1$ — see ![x](asset:${UUID_A})`,
      resolvedMap(UUID_A),
    );
    expect(out).toContain("#cc0000");
    expect(out).toContain(`src="/api/assets/${UUID_A}"`);
  });
});

// E6 (2026-09-02): `**bold**` / `_italic_` outside math and image refs.
describe("renderItemContent — emphasis (E6)", () => {
  test("bold and italic become <strong> and <em>, escaped inside", () => {
    expect(renderEmphasis("Which is **NOT** an _abiotic_ factor?")).toBe(
      "Which is <strong>NOT</strong> an <em>abiotic</em> factor?",
    );
    expect(renderEmphasis("**a <b> & _c_**")).toBe("<strong>a &lt;b&gt; &amp; <em>c</em></strong>");
  });

  test("underscores that are not emphasis stay literal", () => {
    expect(renderEmphasis("snake_case_name and H_2O")).toBe("snake_case_name and H_2O");
    expect(renderEmphasis("Fill in: ______ .")).toBe("Fill in: ______ .");
    expect(renderEmphasis("_ not a run _")).toBe("_ not a run _");
    expect(renderEmphasis("a_b_ c")).toBe("a_b_ c");
    expect(renderEmphasis("**")).toBe("**");
    expect(renderEmphasis("****")).toBe("****");
    expect(renderEmphasis("**no\nnewline**")).toBe("**no\nnewline**");
  });

  test("math is never touched: subscripts inside $...$ survive, emphasis outside renders", () => {
    const html = renderItemContent("Solve $x_1 + x_2$ for **x** _now_", new Map());
    expect(html).toContain("<strong>x</strong> <em>now</em>");
    expect(html).toContain("katex");
    expect(html).not.toContain("<em>1 + x</em>");
  });

  test("an image ref between emphasis runs is untouched", () => {
    const html = renderItemContent(`**Figure** ![alt](asset:${UUID_A}) _below_`, resolvedMap(UUID_A));
    expect(html).toBe(
      `<strong>Figure</strong> <img class="item-image" src="/api/assets/${UUID_A}" alt="alt" loading="lazy"> <em>below</em>`,
    );
  });
});
