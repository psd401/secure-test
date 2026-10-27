// R-4 round-trip gate (docs/editor-redesign-design.md, Phase 3 slice B): every
// packages/markup golden fixture loads into the new editor's ProseMirror
// schema and saves back to the identical string, and a construct the editor
// cannot hold exactly is REPORTED (the field opens read-only) rather than
// rewritten. Runs headlessly: Tiptap's `getSchema` is pure, and the schema's
// own `nodeFromJSON` → `toJSON` is the normalisation the live editor applies
// (it joins adjacent same-mark text, which is how `**a****b**` would be lost).

import { describe, expect, test } from "bun:test";
import { getSchema, type JSONContent } from "@tiptap/core";
import { parse } from "../../packages/markup/src";
import golden from "../../packages/markup/test/fixtures/golden.json";
import { prng, randomMarkup } from "../../packages/markup/test/fuzz";
import { docToMarkup, markupToDoc } from "@/lib/authoring/markupDoc";
import { markupExtensions } from "@/lib/authoring/markupExtensions";
import { RICH_TEXT_TYPES, usesRichTextField } from "@/lib/authoring/richTextTypes";
import { ITEM_TYPES } from "@/db/schema";

const schema = getSchema(markupExtensions());

/** What the live editor would hold after loading `doc`. */
const throughSchema = (doc: JSONContent): JSONContent => schema.nodeFromJSON(doc).toJSON() as JSONContent;

type Fixture = { name: string; markup: string; blanks?: boolean };
const fixtures = (golden as { fixtures: Fixture[] }).fixtures;

const p = (...content: JSONContent[]): JSONContent => ({
  type: "doc",
  content: [content.length ? { type: "paragraph", content } : { type: "paragraph" }],
});
const text = (t: string, ...marks: string[]): JSONContent =>
  marks.length ? { type: "text", text: t, marks: marks.map((type) => ({ type })) } : { type: "text", text: t };

describe("round-trip gate: golden fixtures", () => {
  for (const f of fixtures) {
    test(f.name, () => {
      const opts = f.blanks ? { blanks: true as const } : {};
      const loaded = markupToDoc(f.markup, opts);
      expect(loaded.representable).toBe(true);
      // The schema accepts the document and holds it unchanged …
      const held = throughSchema(loaded.doc);
      expect(held).toEqual(loaded.doc);
      // … and saving it gives back the stored string, byte for byte.
      expect(docToMarkup(held, opts)).toEqual({ markup: f.markup, exact: true });
    });
  }
});

describe("round-trip gate: random markup", () => {
  test("every string either round-trips exactly or is refused — never rewritten", () => {
    const rand = prng(20261026);
    const runs = Number(process.env.MARKUP_FUZZ ?? 3000);
    let refused = 0;
    for (let i = 0; i < runs; i++) {
      const s = randomMarkup(rand);
      for (const opts of [{}, { blanks: true as const }]) {
        const loaded = markupToDoc(s, opts);
        const held = throughSchema(loaded.doc);
        const saved = docToMarkup(held, opts).markup;
        if (loaded.representable) {
          expect(held).toEqual(loaded.doc);
          expect(saved).toBe(s);
        } else {
          refused++;
        }
      }
    }
    // The refusals are the rare shapes below, not a general failure.
    expect(refused).toBeLessThan(runs * 0.2);
  });
});

describe("unrepresentable constructs open read-only", () => {
  test("two bolds with nothing between (`**a****b**`) would merge", () => {
    expect(parse("**a****b**").filter((n) => n.type === "strong")).toHaveLength(2);
    const loaded = markupToDoc("**a****b**");
    expect(loaded).toMatchObject({ representable: false, reason: "not_round_trip" });
  });

  test("a blank marker inside a formula or alt text (ER-F1 – ER-F3)", () => {
    for (const s of [
      "![a [[b1]] b](asset:11111111-1111-1111-1111-111111111111)",
      "$[[b1]] **a**$ **b**",
      "$\\[[b1]]$",
    ]) {
      expect(markupToDoc(s, { blanks: true })).toMatchObject({
        representable: false,
        reason: "blank_in_math_or_alt",
      });
    }
  });

  test("the same strings outside a fill-in-the-blank stem are fine", () => {
    expect(markupToDoc("$\\[[b1]]$").representable).toBe(true);
  });
});

describe("saving what a teacher typed", () => {
  test("bold and italic from the toolbar", () => {
    const doc = p(text("Which is "), text("abiotic", "strong"), text("? "), text("Pick one", "em"));
    expect(docToMarkup(doc)).toEqual({ markup: "Which is **abiotic**? _Pick one_", exact: true });
  });

  test("italic inside bold", () => {
    const doc = p(text("very ", "strong"), text("hot", "strong", "em"));
    expect(docToMarkup(doc).markup).toBe("**very _hot_**");
  });

  test("spaces at the edge of a bold range move outside it", () => {
    const doc = p(text("a"), text(" bold ", "strong"), text("b"));
    expect(docToMarkup(doc)).toEqual({ markup: "a **bold** b", exact: true });
  });

  test("a whitespace-only bold is plain", () => {
    expect(docToMarkup(p(text("a"), text(" ", "strong"), text("b"))).markup).toBe("a b");
  });

  test("a bold range across a formula closes and reopens around it", () => {
    const doc = p(text("a ", "strong"), { type: "math", attrs: { tex: "x", display: false }, marks: [{ type: "strong" }] }, text(" b", "strong"));
    expect(docToMarkup(doc).markup).toBe("**a** $x$ **b**");
  });

  test("a line break", () => {
    expect(docToMarkup(p(text("one"), { type: "hardBreak" }, text("two"))).markup).toBe("one\ntwo");
  });

  test("a price stays as typed", () => {
    expect(docToMarkup(p(text("It costs $5 or $6."))).markup).toBe("It costs $5 or $6.");
  });

  test("typed dollars that would read as a formula are escaped", () => {
    expect(docToMarkup(p(text("Type $x^2$ here")))).toEqual({ markup: "Type \\$x^2\\$ here", exact: true });
    expect(markupToDoc("Type \\$x^2\\$ here").representable).toBe(true);
  });

  test("typed ** that would read as bold is flagged, not hidden", () => {
    expect(docToMarkup(p(text("5**2 and 3**4")))).toEqual({ markup: "5**2 and 3**4", exact: false });
  });

  test("italic in the middle of a word has no spelling: flagged", () => {
    expect(docToMarkup(p(text("un"), text("happy", "em"))).exact).toBe(false);
  });

  test("an empty field is an empty string", () => {
    expect(docToMarkup(p())).toEqual({ markup: "", exact: true });
    expect(markupToDoc("").doc).toEqual(p());
  });

  test("a picture keeps its id and alt", () => {
    const doc = p(text("See "), { type: "image", attrs: { alt: "map", id: "11111111-1111-1111-1111-111111111111", scheme: null } });
    expect(docToMarkup(doc).markup).toBe("See ![map](asset:11111111-1111-1111-1111-111111111111)");
  });
});

// Review finding (Phase 3): the set once named "multiple_choice", which is not
// an item type, so single-answer multiple choice (the default type) never got
// the new field. Pin the exact membership against the real type list.
describe("which item types use the new field (R-12 on)", () => {
  test("every listed type is a real item type", () => {
    for (const t of RICH_TEXT_TYPES) expect(ITEM_TYPES as readonly string[]).toContain(t);
  });
  test("every item type uses it (Phase 4 slice C); a misspelt type does not", () => {
    const on = ITEM_TYPES.filter((t) => usesRichTextField(t));
    expect(on).toEqual([...ITEM_TYPES]);
    expect(usesRichTextField("multiple_choice")).toBe(false);
  });
});
