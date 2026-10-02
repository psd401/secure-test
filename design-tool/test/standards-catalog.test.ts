// Slice 1 of docs/batch-item-generation-design.md: the standards catalog built
// from OSPI's 2026 workbooks. No database. The count tests fail if the build
// output drifts; the rebuild test fails if the committed JSON was hand edited.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import catalogJson from "../lib/standards/catalog.json";
import crosswalkJson from "../lib/standards/crosswalk.json";
import { buildStandards, serialize } from "../lib/standards/build";
import {
  counterparts,
  courses,
  findByBareCode,
  gradeBands,
  lookup,
  parseTag,
  resolveForReporting,
  search,
  tagFor,
  type StandardEntry,
} from "../lib/standards/catalog";

const catalog = catalogJson as StandardEntry[];
const crosswalk = crosswalkJson as { ccss2010: string; wa2026: string }[];
const count = (scheme: string, subject: string) =>
  catalog.filter((e) => e.scheme === scheme && e.subject === subject).length;

describe("catalog counts", () => {
  test("entries per scheme and subject", () => {
    expect(count("wa2026", "math")).toBe(424);
    expect(count("wa2026", "ela")).toBe(297);
    expect(count("ccss2010", "math")).toBe(385);
    expect(count("ccss2010", "ela")).toBe(868);
    expect(catalog.length).toBe(1974);
  });

  test("crosswalk size and endpoints", () => {
    expect(crosswalk.length).toBe(1500);
    const tags = new Set(catalog.map(tagFor));
    for (const p of crosswalk) {
      expect(tags.has(`ccss2010:${p.ccss2010}`)).toBe(true);
      expect(tags.has(`wa2026:${p.wa2026}`)).toBe(true);
    }
  });

  test("codes are unique within a scheme", () => {
    expect(new Set(catalog.map(tagFor)).size).toBe(catalog.length);
  });

  test("math never splits: no 2011 math code links to more than one 2026 code", () => {
    const links = new Map<string, number>();
    for (const p of crosswalk) {
      const e = lookup(`ccss2010:${p.ccss2010}`)!;
      if (e.subject === "math") links.set(p.ccss2010, (links.get(p.ccss2010) ?? 0) + 1);
    }
    expect(links.size).toBe(384);
    expect([...links.values()].every((n) => n === 1)).toBe(true);
  });

  test("ELA splits exist (a 2011 standard spread over several 2026 standards)", () => {
    const links = new Map<string, number>();
    for (const p of crosswalk) links.set(p.ccss2010, (links.get(p.ccss2010) ?? 0) + 1);
    const split = [...links].filter(([code, n]) => n > 1 && lookup(`ccss2010:${code}`)!.subject === "ela");
    expect(split.length).toBe(213);
  });

  test("grade bands and HS courses", () => {
    expect(gradeBands("math")).toEqual(["K", "1", "2", "3", "4", "5", "6", "7", "8", "HS"]);
    expect(gradeBands("ela")).toEqual(["K", "1", "2", "3", "4", "5", "6", "7", "8", "9-10", "11-12"]);
    expect(courses()).toEqual(["INT 1", "INT 2", "INT 3", "GEO", "ALG 1", "ALG 2", "HS-3rd Cr+"]);
  });

  test("HS math standards are aggregated across courses", () => {
    const hs = catalog.filter((e) => e.scheme === "wa2026" && e.subject === "math" && e.grade_band === "HS");
    expect(hs.length).toBe(160);
    const e = lookup("wa2026:M.HS.DA.DS.1")!;
    expect(e.courses!.length).toBeGreaterThan(0);
    expect(e.courses!.map((c) => c.course)).toContain("INT 1");
    // one entry, several courses
    expect(hs.some((x) => (x.courses?.length ?? 0) > 1)).toBe(true);
    // entry priority = priority in any course
    for (const x of hs) expect(x.priority).toBe(x.courses!.some((c) => c.priority));
    // 2011 and K-8 entries carry no courses
    expect(lookup("wa2026:M.K.DA.DS.1")!.courses).toBeUndefined();
  });
});

describe("crosswalk resolution", () => {
  test("a known 1:1 math pair resolves both ways", () => {
    expect(counterparts("ccss2010:7.RP.A.2").map(tagFor)).toEqual(["wa2026:M.7.R.RP.2"]);
    expect(counterparts("wa2026:M.7.R.RP.2").map(tagFor)).toEqual(["ccss2010:7.RP.A.2"]);
    expect(resolveForReporting("ccss2010:7.RP.A.2")!.code).toBe("M.7.R.RP.2");
    expect(resolveForReporting("wa2026:M.7.R.RP.2")!.code).toBe("M.7.R.RP.2");
  });

  test("a merged ELA 2026 standard has several counterparts", () => {
    const c = counterparts("wa2026:ELA.1.L.2");
    expect(c.length).toBeGreaterThan(1);
    expect(c.every((e) => e.scheme === "ccss2010")).toBe(true);
  });

  test("a split ELA 2011 standard stays under its own code for reporting", () => {
    const code = crosswalk.find(
      (p) => crosswalk.filter((q) => q.ccss2010 === p.ccss2010).length > 1,
    )!.ccss2010;
    const tag = `ccss2010:${code}`;
    expect(counterparts(tag).length).toBeGreaterThan(1);
    expect(resolveForReporting(tag)!.code).toBe(code);
    expect(resolveForReporting(tag)!.scheme).toBe("ccss2010");
  });

  test("a dropped CCSS code resolves to itself", () => {
    expect(counterparts("ccss2010:7.NS.A.3")).toEqual([]);
    expect(resolveForReporting("ccss2010:7.NS.A.3")!.code).toBe("7.NS.A.3");
    expect(counterparts("ccss2010:W.4.9a")).toEqual([]);
  });

  test("a new-in-2026 math standard has no counterpart", () => {
    const e = lookup("wa2026:M.K.DA.DS.1")!;
    expect(e.new_in_2026).toBe(true);
    expect(counterparts("wa2026:M.K.DA.DS.1")).toEqual([]);
    expect(resolveForReporting("wa2026:M.K.DA.DS.1")).toBe(e);
  });

  test("unknown and custom tags resolve to nothing", () => {
    expect(resolveForReporting("wa2026:NOPE")).toBeUndefined();
    expect(resolveForReporting("unit 3 target")).toBeUndefined();
    expect(counterparts("unit 3 target")).toEqual([]);
  });

  test("the OSPI typo 'ELA 11-12.W.3' was repaired, the unknown R.5 dropped", () => {
    expect(counterparts("ccss2010:W.11-12.3a").map((e) => e.code)).toContain("ELA.11-12.W.3");
    expect(lookup("wa2026:ELA.11-12.R.5")).toBeUndefined();
    expect(crosswalk.some((p) => p.wa2026 === "ELA.11-12.R.5")).toBe(false);
  });
});

describe("tags", () => {
  test("format and parse round trip", () => {
    for (const e of [catalog[0]!, catalog[500]!, catalog[catalog.length - 1]!]) {
      expect(parseTag(tagFor(e))).toEqual({ scheme: e.scheme, code: e.code });
    }
    expect(parseTag("ngss:HS-PS1-1")).toEqual({ scheme: "ngss", code: "HS-PS1-1" });
  });

  test("a string without a known scheme is custom", () => {
    expect(parseTag("AP skill 1.A")).toEqual({ custom: "AP skill 1.A" });
    expect(parseTag("foo:bar")).toEqual({ custom: "foo:bar" });
    expect(parseTag(":x")).toEqual({ custom: ":x" });
    expect(lookup("M.7.R.RP.2")).toBeUndefined(); // bare code is not auto-converted
  });

  test("findByBareCode returns matches across schemes", () => {
    expect(findByBareCode("7.RP.A.2").map(tagFor)).toEqual(["ccss2010:7.RP.A.2"]);
    expect(findByBareCode(" M.7.R.RP.2 ").map(tagFor)).toEqual(["wa2026:M.7.R.RP.2"]);
    expect(findByBareCode("nothing")).toEqual([]);
  });
});

describe("search", () => {
  test("code matches rank before text matches", () => {
    const hits = search("7.RP.A.2");
    expect(hits[0]!.code).toBe("7.RP.A.2");
    const textual = search("ratio", { subject: "math", limit: 500 });
    expect(textual.length).toBeGreaterThan(0);
    const codeFirst = search("RP", { subject: "math", scheme: "wa2026", limit: 500 });
    const firstText = codeFirst.findIndex((e) => !e.code.toLowerCase().includes("rp"));
    const lastCode = codeFirst.map((e) => e.code.toLowerCase().includes("rp")).lastIndexOf(true);
    if (firstText !== -1) expect(lastCode).toBeLessThan(firstText);
  });

  test("exact code outranks prefix outranks substring", () => {
    const hits = search("M.7.R.RP.2", { scheme: "wa2026" });
    expect(hits[0]!.code).toBe("M.7.R.RP.2");
  });

  test("case-insensitive, text match, limit", () => {
    expect(search("m.7.r.rp.2")[0]!.code).toBe("M.7.R.RP.2");
    expect(search("SCATTER PLOT", { subject: "math" }).length).toBeGreaterThan(0);
    expect(search("", { limit: 7 }).length).toBe(7);
    expect(search("zzzzzz-not-a-standard")).toEqual([]);
  });

  test("filters", () => {
    for (const e of search("", { subject: "ela", gradeBand: "9-10", scheme: "wa2026", limit: 500 })) {
      expect([e.subject, e.grade_band, e.scheme]).toEqual(["ela", "9-10", "wa2026"]);
    }
    const alg = search("", { course: "ALG 1", limit: 500 });
    expect(alg.length).toBe(50);
    expect(alg.every((e) => e.courses!.some((c) => c.course === "ALG 1"))).toBe(true);
    expect(search("", { subject: "math", gradeBand: "HS", scheme: "ccss2010", limit: 500 }).length).toBe(156);
  });
});

describe("build", () => {
  test("re-running the build reproduces the committed JSON", async () => {
    const dir = join(import.meta.dir, "../lib/standards");
    const read = (f: string) => readFileSync(join(dir, "sources", f));
    const built = await buildStandards({
      math: read("math26-final-adoption-spreadsheet.xlsx"),
      ela: read("ela26-final-adoption-spreadsheet.xlsx"),
    });
    expect(serialize(built.catalog)).toBe(readFileSync(join(dir, "catalog.json"), "utf8"));
    expect(serialize(built.crosswalk)).toBe(readFileSync(join(dir, "crosswalk.json"), "utf8"));
  }, 60_000);
});
