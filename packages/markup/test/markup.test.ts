// R-2: the parser reads every golden fixture as the renderers do, and
// serialize(parse(s)) === s for every fixture, for the canonical spelling of
// every construct, and for thousands of random strings built from the
// grammar's own delimiters. The renderers themselves are held to the same
// fixtures in design-tool/test/markup-golden.test.ts.
import { describe, expect, test } from "bun:test";
import { parse, renderedForm, serialize, type MarkupNode } from "../src";
import golden from "./fixtures/golden.json";
import { prng, randomMarkup } from "./fuzz";

const resolvesSet = new Set(golden.resolves);
const resolves = (id: string) => resolvesSet.has(id);

describe("golden fixtures — parser", () => {
  for (const f of golden.fixtures) {
    const options = "blanks" in f && f.blanks ? { blanks: true as const } : {};
    test(f.name, () => {
      const nodes = parse(f.markup, options);
      expect(renderedForm(nodes, { resolves })).toEqual(f.dom as never);
      expect(serialize(nodes)).toBe(f.markup);
    });
  }
});

describe("canonical forms", () => {
  const uuid = "11111111-1111-1111-1111-111111111111";
  const cases: [string, MarkupNode[]][] = [
    ["**b**", [{ type: "strong", children: [{ type: "text", value: "b" }] }]],
    ["_i_", [{ type: "em", children: [{ type: "text", value: "i" }] }]],
    ["$x$", [{ type: "math", tex: "x", display: false }]],
    ["$$x$$", [{ type: "math", tex: "x", display: true }]],
    ["\\$", [{ type: "escape" }]],
    [`![a](asset:${uuid})`, [{ type: "image", alt: "a", id: uuid }]],
    [
      "**a _b_**",
      [
        {
          type: "strong",
          children: [
            { type: "text", value: "a " },
            { type: "em", children: [{ type: "text", value: "b" }] },
          ],
        },
      ],
    ],
  ];
  for (const [markup, nodes] of cases) {
    test(`${JSON.stringify(markup)} parses to its node and serializes back`, () => {
      expect(parse(markup)).toEqual(nodes);
      expect(serialize(nodes)).toBe(markup);
    });
  }

  test("[[id]] is a blank only in a fill-in-the-blank stem", () => {
    expect(parse("[[b1]]")).toEqual([{ type: "text", value: "[[b1]]" }]);
    expect(parse("[[b1]]", { blanks: true })).toEqual([{ type: "blank", id: "b1" }]);
    expect(serialize([{ type: "blank", id: "b1" }])).toBe("[[b1]]");
  });

  test("a blank list keeps a marker naming no blank as text", () => {
    expect(parse("[[b1]] [[zz]]", { blanks: ["b1"] })).toEqual([
      { type: "blank", id: "b1" },
      { type: "text", value: " [[zz]]" },
    ]);
  });

  test("a marker inside a formula falls back to segment-by-segment, as the server does", () => {
    const nodes = parse("$x [[b1]]$ **y**", { blanks: true });
    expect(renderedForm(nodes)).toEqual(["$x ", { blank: "b1" }, "$ ", { b: ["y"] }]);
    expect(serialize(nodes)).toBe("$x [[b1]]$ **y**");
  });

  test("a stem that already holds U+E000 still round-trips", () => {
    const s = "a\uE000 [[b1]] **c**";
    expect(serialize(parse(s, { blanks: true }))).toBe(s);
  });

  test("an upper-case scheme is kept for the round trip", () => {
    const s = `![a](Asset:${uuid.toUpperCase()})`;
    expect(parse(s)).toEqual([{ type: "image", alt: "a", id: uuid.toUpperCase(), scheme: "Asset" }]);
    expect(serialize(parse(s))).toBe(s);
  });

  test("empty and non-string input parse to nothing", () => {
    expect(parse("")).toEqual([]);
    expect(parse(undefined as unknown as string)).toEqual([]);
  });
});

describe("round trip — random markup", () => {
  test("serialize(parse(s)) === s for 5,000 random strings, plain and blank mode", () => {
    const rand = prng(20261025);
    for (let k = 0; k < 5000; k++) {
      const s = randomMarkup(rand);
      expect(serialize(parse(s))).toBe(s);
      expect(serialize(parse(s, { blanks: true }))).toBe(s);
    }
  });

  test("parsing is stable: parse(serialize(parse(s))) equals parse(s)", () => {
    const rand = prng(7);
    for (let k = 0; k < 1000; k++) {
      const s = randomMarkup(rand);
      const once = parse(s);
      expect(parse(serialize(once))).toEqual(once);
    }
  });
});
