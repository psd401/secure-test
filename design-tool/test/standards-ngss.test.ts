// Slice 1b of docs/batch-item-generation-design.md: the NGSS performance
// expectations. The PDF is not committed, so the parser is tested on small
// hand-written page strings and the committed intermediate JSON / catalog
// entries on their measured shape.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import catalogJson from "../lib/standards/catalog.json";
import { NGSS_CODE, parseNgss, type NgssEntry } from "../lib/standards/ngss";
import {
  counterparts,
  gradeBands,
  lookup,
  resolveForReporting,
  search,
  tagFor,
  type StandardEntry,
} from "../lib/standards/catalog";

const catalog = catalogJson as StandardEntry[];
const ngss = catalog.filter((e) => e.scheme === "ngss");
const intermediate = JSON.parse(
  readFileSync(join(import.meta.dir, "../lib/standards/sources/ngss-performance-expectations.json"), "utf8"),
) as NgssEntry[];

describe("ngss catalog entries", () => {
  test("208 performance expectations, one per code, all science", () => {
    expect(ngss.length).toBe(208);
    expect(intermediate.length).toBe(208);
    expect(new Set(ngss.map((e) => e.code)).size).toBe(208);
    expect(ngss.every((e) => e.subject === "science")).toBe(true);
    for (const e of ngss) expect(NGSS_CODE.test(`${e.code}. x`)).toBe(true);
  });

  test("grade bands and domains from the code", () => {
    expect(gradeBands("science")).toEqual(["K", "1", "2", "3", "4", "5", "K-2", "3-5", "MS", "HS"]);
    const by = (key: "grade_band" | "domain") => {
      const m: Record<string, number> = {};
      for (const e of ngss) m[e[key]] = (m[e[key]] ?? 0) + 1;
      return m;
    };
    expect(by("grade_band")).toEqual({
      K: 10, "1": 9, "2": 11, "3": 15, "4": 14, "5": 13, "K-2": 3, "3-5": 3, MS: 59, HS: 71,
    });
    expect(Object.keys(by("domain")).sort()).toEqual([
      "Earth and Space Science", "Engineering Design", "Life Science", "Physical Science",
    ]);
    expect(lookup("ngss:MS-PS1-2")!.domain).toBe("Physical Science");
    expect(lookup("ngss:HS-ETS1-1")!.domain).toBe("Engineering Design");
    expect(lookup("ngss:3-5-ETS1-1")!.grade_band).toBe("3-5");
  });

  test("a known expectation carries its text, clarification and boundary", () => {
    const e = lookup("ngss:MS-PS1-2")!;
    expect(e.text.startsWith("Analyze and interpret data on the properties of substances before and after the substances interact to determine if a chemical reaction has occurred.")).toBe(true);
    expect(e.clarification!.startsWith("Examples of reactions could include burning sugar")).toBe(true);
    expect(e.assessment_boundary!.startsWith("Assessment is limited to analysis of the following properties")).toBe(true);
    expect(e.engineering).toBeUndefined();
    expect(tagFor(e)).toBe("ngss:MS-PS1-2");
  });

  test("engineering marker is stripped from the text and kept as a flag", () => {
    const eng = ngss.filter((e) => e.engineering);
    expect(eng.length).toBe(29);
    expect(eng.every((e) => !e.text.includes("*"))).toBe(true);
    expect(lookup("ngss:K-PS2-2")!.engineering).toBe(true);
  });

  test("no PDF artifacts survive in any field", () => {
    for (const e of ngss) {
      for (const v of [e.text, e.clarification ?? "", e.assessment_boundary ?? ""]) {
        expect(v).not.toMatch(/[[\]*]|\s{2}|Statement:/);
      }
      expect(e.text.endsWith(".")).toBe(true);
    }
    // the two pages with stray letter spacing were repaired
    expect(lookup("ngss:MS-LS3-2")!.clarification).toContain("Punnett squares");
    expect(lookup("ngss:MS-ESS1-3")!.clarification).toContain("Earth-based instruments");
    expect(lookup("ngss:HS-PS1-2")!.clarification!.startsWith("Examples of chemical reactions")).toBe(true);
  });

  test("no crosswalk links: counterparts empty, reporting resolves to itself", () => {
    const e = lookup("ngss:MS-PS1-2")!;
    expect(counterparts("ngss:MS-PS1-2")).toEqual([]);
    expect(resolveForReporting("ngss:MS-PS1-2")).toBe(e);
  });

  test("search with subject science", () => {
    const hits = search("chemical reaction", { subject: "science", limit: 500 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.subject === "science" && h.scheme === "ngss")).toBe(true);
    expect(search("MS-PS1-2", { subject: "science" })[0]!.code).toBe("MS-PS1-2");
    expect(search("", { subject: "science", gradeBand: "MS", limit: 500 }).length).toBe(59);
    expect(search("MS-PS1-2", { subject: "math" })).toEqual([]);
  });
});

describe("parseNgss", () => {
  test("a statement wrapped across lines, with both bracket groups", () => {
    const out = parseNgss([
      [
        "MS-PS1 Matter and Its Interactions",
        "MS-PS1-2. Analyze and interpret data on the properties of substances before and after the",
        "substances interact to determine if a chemical reaction has occurred. [Clarification Statement: Examples of",
        "reactions could include burning sugar.] [Assessment Boundary: Assessment is limited to",
        "density and odor.]",
        "The performance expectations above were developed using the following elements.",
      ].join("\n"),
    ]);
    expect(out).toEqual([
      {
        code: "MS-PS1-2",
        text: "Analyze and interpret data on the properties of substances before and after the substances interact to determine if a chemical reaction has occurred.",
        clarification: "Examples of reactions could include burning sugar.",
        assessment_boundary: "Assessment is limited to density and odor.",
      },
    ]);
  });

  test("a bracket wrapped across a page break and a tag split after its first word", () => {
    const out = parseNgss([
      "HS-PS1-1. Use the periodic table as a model to predict the relative properties of elements. [Clarification\nStatement: Examples of properties could include the number of",
      "protons, and trends.]\n[Assessment Boundary: Limited to main group elements.]\nThe performance expectations above were developed using elements.",
    ]);
    expect(out[0]!.clarification).toBe("Examples of properties could include the number of protons, and trends.");
    expect(out[0]!.assessment_boundary).toBe("Limited to main group elements.");
  });

  test("a statement with no brackets, and the engineering asterisk", () => {
    const out = parseNgss([
      "K-PS3-2. Use tools and materials to design and build a structure that will reduce the warming effect of sunlight on an area.*\nK-PS3-1. Make observations to determine the effect of sunlight on Earth’s surface.\nStudents who demonstrate understanding can:",
    ]);
    expect(out.map((e) => e.code)).toEqual(["K-PS3-1", "K-PS3-2"]);
    expect(out[1]!.engineering).toBe(true);
    expect(out[1]!.text.endsWith("an area.")).toBe(true);
    expect(out[0]).toEqual({ code: "K-PS3-1", text: "Make observations to determine the effect of sunlight on Earth’s surface." });
  });

  test("a parenthesized reference is not a PE start", () => {
    const out = parseNgss([
      "MS-PS1-1. Develop models. [Clarification Statement: See also (MS-PS1-2). for more.]\nConnections: Use observations to describe patterns. (MS-PS1-2). Not a start.\nAnd more (HS-PS1-1). text.",
    ]);
    expect(out.map((e) => e.code)).toEqual(["MS-PS1-1"]);
    expect(out[0]!.clarification).toBe("See also (MS-PS1-2). for more.");
  });

  test("a duplicate with identical text is deduplicated", () => {
    const page = "MS-PS1-3. Gather information. [Assessment Boundary: Qualitative only.]";
    expect(parseNgss([page, page]).length).toBe(1);
  });

  test("a duplicate with different text throws", () => {
    expect(() => parseNgss(["MS-PS1-3. Gather information.", "MS-PS1-3. Gather other information."])).toThrow(/twice/);
  });

  test("a statement that never ends fails loudly", () => {
    expect(() => parseNgss(["MS-PS1-3. Gather information without an end"])).toThrow(/period/);
  });

  test("stray letter spacing on a damaged page is repaired from the other pages", () => {
    const clean = "MS-PS1-1. Develop models with emphasis on types of atoms. [Clarification Statement: Emphasis is on models.]";
    const damaged =
      "MS-PS1-2. Analyze data w ith care. [C larification S tatement: E mphasis is on ty pes of data.]";
    const out = parseNgss([clean, damaged]);
    expect(out[1]).toEqual({
      code: "MS-PS1-2",
      text: "Analyze data with care.",
      clarification: "Emphasis is on types of data.",
    });
  });
});
