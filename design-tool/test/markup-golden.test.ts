// Editor redesign Phase 1 (R-2, docs/editor-redesign-design.md): the golden
// markup fixtures (packages/markup/test/fixtures/golden.json) against BOTH
// renderers that exist today —
//
//   - the server's renderItemContent (and renderAroundBlanks for a
//     fill-in-the-blank stem), compared BYTE FOR BYTE with the fixture's
//     expected tree written out as the HTML the server emits;
//   - the client's bridge-mode renderer.js, run in the client harness's DOM
//     shim (test/helpers/clientRenderer.ts), its tree read back into the same
//     form.
//
// Then a differential pass over random markup: each renderer against the
// markup package's parse, so a disagreement between the two renderers shows
// up as one of them leaving the parser. Disagreements found are recorded as
// findings in the design note's §Progress and pinned here — Phase 1 changes no
// rendered output.
import { describe, expect, test } from "bun:test";
import katex from "katex";
import { parse, renderedForm, type RenderedNode } from "../../packages/markup/src";
import golden from "../../packages/markup/test/fixtures/golden.json";
import { prng, randomMarkup } from "../../packages/markup/test/fuzz";
import { escapeHtml } from "@/lib/escapeHtml";
import { renderAroundBlanks } from "@/lib/items/renderAroundBlanks";
import { renderItemContent, type ResolvedAsset } from "@/lib/items/renderItemContent";
import { K12_MACROS } from "@/lib/math/macros";
import { markerIds, renderStemsInClient } from "./helpers/clientRenderer";

const RESOLVED = new Map<string, ResolvedAsset>(
  golden.resolves.map((id) => [id, { id, content_type: "image/png" }]),
);
const resolves = (id: string) => RESOLVED.has(id);

// The test's own slot markup for a blank; renderAroundBlanks takes any.
const slot = (id: string) => `<span class="fill-gap" data-blank="${id}"></span>`;

/** A rendered tree written as the HTML renderItemContent emits for it. */
function serverHtml(nodes: readonly RenderedNode[]): string {
  return nodes
    .map((n) => {
      if (typeof n === "string") return escapeHtml(n);
      if ("b" in n) return `<strong>${serverHtml(n.b)}</strong>`;
      if ("i" in n) return `<em>${serverHtml(n.i)}</em>`;
      // renderItemContent's renderMath options, repeated: KaTeX is the same
      // library on both sides, so the fixture records the TeX, not its markup.
      if ("math" in n || "display" in n) {
        const display = "display" in n;
        return katex.renderToString(display ? n.display : n.math, {
          displayMode: display,
          throwOnError: false,
          errorColor: "#cc0000",
          macros: { ...K12_MACROS },
          output: "html",
          strict: "ignore",
          trust: false,
        });
      }
      if ("img" in n) {
        return `<img class="item-image" src="/api/assets/${n.img.id}" alt="${escapeHtml(n.img.alt)}" loading="lazy">`;
      }
      if ("missing" in n) return `<span class="image-missing">[image not found: ${escapeHtml(n.missing)}]</span>`;
      return slot(n.blank);
    })
    .join("");
}

/** The server's HTML for a stem, as the preview builds a fill-in-the-blank one. */
function renderOnServer(markup: string, blanks: boolean): string {
  if (!blanks) return renderItemContent(markup, RESOLVED);
  // renderFillBlankStem's split (lib/preview/renderHtml.ts): a marker's first
  // occurrence becomes a slot; a repeat stays text.
  const placed = new Set<string>();
  const texts: string[] = [];
  const slots: string[] = [];
  let last = 0;
  for (const m of markup.matchAll(/\[\[([A-Za-z0-9_-]{1,40})\]\]/g)) {
    if (placed.has(m[1]!)) continue;
    placed.add(m[1]!);
    texts.push(markup.slice(last, m.index));
    slots.push(slot(m[1]!));
    last = m.index! + m[0].length;
  }
  texts.push(markup.slice(last));
  return renderAroundBlanks(texts, slots, RESOLVED);
}

type Fixture = { name: string; markup: string; blanks?: boolean; dom: RenderedNode[] };
const FIXTURES = golden.fixtures as Fixture[];

describe("golden fixtures — server renderer", () => {
  for (const f of FIXTURES) {
    test(f.name, () => {
      expect(renderOnServer(f.markup, !!f.blanks)).toBe(serverHtml(f.dom));
    });
  }
});

describe("golden fixtures — client renderer (bridge-mode renderer.js, JSC harness shim)", () => {
  const rendered = renderStemsInClient(
    FIXTURES.map((f) => ({ markup: f.markup, blanks: !!f.blanks })),
    golden.resolves,
  );
  FIXTURES.forEach((f, k) => {
    test(f.name, () => {
      expect(rendered[k]!.dom).toEqual(f.dom);
      expect(rendered[k]!.unplaced).toBe(0);
    });
  });
});

// A fill-in-the-blank stem whose placed marker sits inside a formula or a
// picture's alt text once the markers are swapped for the sentinel — the one
// class of input on which the renderers are known to disagree (findings ER-F1
// to ER-F3 below). Those inputs are pinned there, and left out of the random
// pass so it keeps watching everything else.
function markerInFormulaOrAlt(markup: string): boolean {
  const seen = new Set<string>();
  const joined = markup.replace(/\[\[([A-Za-z0-9_-]{1,40})\]\]/g, (whole, id: string) => {
    if (seen.has(id)) return whole;
    seen.add(id);
    return "\uE000";
  });
  if (seen.size === 0) return false;
  return parse(joined).some(
    (n) => (n.type === "math" && n.tex.includes("\uE000")) || (n.type === "image" && n.alt.includes("\uE000")),
  );
}

// The filter must leave out only that class: a blank stem with a formula or a
// picture elsewhere stays in the random pass.
test("the random pass leaves out only a marker inside a formula or alt text", () => {
  expect(markerInFormulaOrAlt("$x [[b1]]$")).toBe(true);
  expect(markerInFormulaOrAlt("![a [[b1]]](asset:11111111-1111-1111-1111-111111111111)")).toBe(true);
  expect(markerInFormulaOrAlt("$x$ [[b1]]")).toBe(false);
  expect(markerInFormulaOrAlt("![p](asset:11111111-1111-1111-1111-111111111111) [[b1]]")).toBe(false);
  expect(markerInFormulaOrAlt("$x$")).toBe(false);
});

// Random markup: each renderer against the parser. A mismatch is printed with
// the input, so a new disagreement is a reproducible fixture away.
describe("differential — random markup", () => {
  const rand = prng(20261025);
  const stems: { markup: string; blanks: boolean }[] = [];
  // MARKUP_FUZZ=<n> runs a longer pass locally (40,000 stems were clean on
  // 2026-10-25 outside the pinned class).
  const count = Number(process.env.MARKUP_FUZZ ?? 1500);
  while (stems.length < count) {
    const s = { markup: randomMarkup(rand), blanks: stems.length % 3 === 0 };
    if (s.blanks && markerInFormulaOrAlt(s.markup)) continue;
    stems.push(s);
  }
  const expected = stems.map((s) => renderedForm(parse(s.markup, s.blanks ? { blanks: true } : {}), { resolves }));

  test("the server renderer matches the parser on every input", () => {
    const off = stems.filter((s, k) => renderOnServer(s.markup, s.blanks) !== serverHtml(expected[k]!));
    expect(off.map((s) => s.markup)).toEqual([]);
  });

  test("the client renderer matches the parser on every input", () => {
    const client = renderStemsInClient(stems, golden.resolves);
    const off = stems
      .map((s, k) => ({ ...s, client: client[k]!, parser: expected[k]! }))
      .filter((r) => JSON.stringify(r.client.dom) !== JSON.stringify(r.parser) || r.client.unplaced !== 0);
    expect(off.map((r) => ({ markup: r.markup, blanks: r.blanks, client: r.client, parser: r.parser }))).toEqual([]);
  });
});

// Findings (design note §Progress, 2026-10-25). Each pins what the renderers
// do TODAY, so a change to either shows up here; none is fixed in Phase 1,
// which changes no rendered output. The parser follows the server's general
// rule (segment by segment).
describe("findings — a blank marker inside a formula or an alt text", () => {
  const A = golden.resolves[0]!;

  test("ER-F1: inside alt text — the server keeps it a blank in literal text, the client makes a picture and moves the blank after the sentence", () => {
    const markup = `![a [[b1]] b](asset:${A}) end`;
    const parser = renderedForm(parse(markup, { blanks: true }), { resolves });
    expect(parser).toEqual(["![a ", { blank: "b1" }, ` b](asset:${A}) end`]);
    expect(renderOnServer(markup, true)).toBe(serverHtml(parser));
    const [client] = renderStemsInClient([{ markup, blanks: true }], golden.resolves);
    expect(client!.dom).toEqual([{ img: { alt: "a \uE000 b", id: A } }, " end"]);
    expect(client!.unplaced).toBe(1);
  });

  test("ER-F2: inside a formula — the server re-reads each segment, the client keeps the whole stem's reading", () => {
    const markup = "$[[b1]] **a**$ **b**";
    const parser = renderedForm(parse(markup, { blanks: true }), { resolves });
    expect(parser).toEqual(["$", { blank: "b1" }, " ", { b: ["a"] }, "$ ", { b: ["b"] }]);
    expect(renderOnServer(markup, true)).toBe(serverHtml(parser));
    const [client] = renderStemsInClient([{ markup, blanks: true }], golden.resolves);
    expect(client!.dom).toEqual(["$", { blank: "b1" }, " **a**$ ", { b: ["b"] }]);
  });

  test("ER-F3: after a backslash inside a formula — the server puts the blank inside KaTeX's error markup", () => {
    const markup = "$\\[[b1]]$";
    const html = renderOnServer(markup, true);
    expect(html.startsWith('<span class="katex">')).toBe(true);
    expect(html).toContain(slot("b1"));
    // The client and the parser agree with each other here.
    const parser = renderedForm(parse(markup, { blanks: true }), { resolves });
    expect(parser).toEqual(["$\\", { blank: "b1" }, "$"]);
    const [client] = renderStemsInClient([{ markup, blanks: true }], golden.resolves);
    expect(client!.dom).toEqual(parser);
  });
});

test("markerIds numbers distinct markers in order of first appearance", () => {
  expect(markerIds("[[b2]] [[b1]] [[b2]]")).toEqual(["b2", "b1"]);
});
