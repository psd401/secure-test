// Editor redesign Phase 7 slice B (R-10): reading a .docx for item import —
// the zip reader, the WordprocessingML reader (blocks, text, list numbers,
// anchors) and the region → block mapping the review's left pane uses. Pure;
// no DB. Fixtures are hand-built (test/helpers/docx.ts).
import { describe, expect, test } from "bun:test";
import { DocxReadError, readDocx, readZipEntries } from "../lib/docxImport/readDocx";
import {
  docxGroups,
  formatListNumber,
  WordXmlError,
  parseWordDocument,
  regionBlockRange,
  type WordParagraph,
} from "../lib/docxImport/document";
import { locateCandidates } from "../lib/pdfImport/regions";
import { PICTURE_RUN, buildZip, documentXml, makeDocx, para, run, table } from "./helpers/docx";

describe("readZipEntries", () => {
  test("reads deflated and stored entries; an absent name is absent", () => {
    for (const stored of [false, true]) {
      const zip = buildZip({ "a.txt": "hello", "b/c.xml": "<x/>" }, { stored });
      const got = readZipEntries(zip, ["a.txt", "b/c.xml", "missing"]);
      expect(new TextDecoder().decode(got.get("a.txt")!)).toBe("hello");
      expect(new TextDecoder().decode(got.get("b/c.xml")!)).toBe("<x/>");
      expect(got.has("missing")).toBe(false);
    }
  });

  test("not a zip, or a part over the cap → DocxReadError", () => {
    expect(() => readZipEntries(new TextEncoder().encode("%PDF-1.4 not a zip at all"), ["a"])).toThrow(DocxReadError);
    const zip = buildZip({ "big.xml": "x".repeat(10_000) });
    expect(() => readZipEntries(zip, ["big.xml"], 1000)).toThrow(DocxReadError);
    expect(() => readZipEntries(buildZip({ "big.xml": "x".repeat(10_000) }, { stored: true }), ["big.xml"], 1000)).toThrow(
      DocxReadError,
    );
  });

  // Review of #127: every directory record of a wanted name used to be
  // inflated, so one small file could repeat a 40 MiB stream thousands of
  // times. buildZip takes a map, so the duplicate is made by renaming the
  // second entry's bytes (same length) to the first's.
  test("a name listed twice in the directory is refused, not inflated twice", () => {
    const zip = buildZip({ "word/document.xml": "<a/>", "word/documenX.xml": "<b/>" });
    const from = new TextEncoder().encode("word/documenX.xml");
    const to = new TextEncoder().encode("word/document.xml");
    for (let i = 0; i + from.length <= zip.length; i++) {
      if (from.every((b, j) => zip[i + j] === b)) zip.set(to, i);
    }
    expect(() => readZipEntries(zip, ["word/document.xml"])).toThrow(/duplicate zip entry word\/document\.xml/);
    expect(() => readDocx(zip)).toThrow(DocxReadError);
    // An unwanted name may repeat: it is never read.
    expect(readZipEntries(zip, ["other.xml"]).size).toBe(0);
  });

  test("a zip with no word/document.xml is not a Word document", () => {
    expect(() => readDocx(buildZip({ "hello.txt": "hi" }))).toThrow(/not a Word document/);
  });
});

describe("parseWordDocument", () => {
  test("paragraphs, bold / italic runs, breaks and tabs; paragraph-mark formatting ignored", () => {
    const doc = parseWordDocument(
      documentXml([
        para([run("Plain "), run("bold", { b: true }), run(" and "), run("italic", { i: true })]),
        `<w:p><w:r><w:t>one</w:t><w:br/><w:t>two</w:t><w:tab/><w:t>three</w:t></w:r></w:p>`,
        para("Not bold", { style: "Normal" }),
      ]),
    );
    expect(doc.blocks).toHaveLength(3);
    const p0 = doc.blocks[0] as WordParagraph;
    expect(p0.runs).toEqual([
      { text: "Plain " },
      { text: "bold", bold: true },
      { text: " and " },
      { text: "italic", italic: true },
    ]);
    // para() puts <w:b/> in the paragraph mark's own run properties.
    expect((doc.blocks[2] as WordParagraph).runs).toEqual([{ text: "Not bold" }]);
    expect(doc.text.split("\n")).toEqual(["Plain **bold** and _italic_", "one", "two\tthree", "Not bold"]);
  });

  test("emphasis markers sit inside the run's whitespace; w:b w:val=0 is off", () => {
    const doc = parseWordDocument(
      documentXml([
        `<w:p>${run("Read ")}<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> carefully </w:t></w:r><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>now</w:t></w:r></w:p>`,
      ]),
    );
    expect(doc.text).toBe("Read  **carefully** now");
  });

  test("automatic list numbers become labels, written into the text; levels and restarts", () => {
    const doc = parseWordDocument(
      documentXml([
        para("First question", { num: { id: 1 } }),
        para("a part", { num: { id: 1, level: 1 } }),
        para("another part", { num: { id: 1, level: 1 } }),
        para("Second question", { num: { id: 1 } }),
        para("new part", { num: { id: 1, level: 1 } }),
        para("Form B starts again", { num: { id: 2 } }),
        para("Continues", { num: { id: 1 } }),
      ]),
      makeNumbering(),
    );
    const labels = doc.blocks.map((b) => (b as WordParagraph).label);
    expect(labels).toEqual(["1.", "a)", "b)", "2.", "a)", "1.", "2."]);
    expect((doc.blocks[1] as WordParagraph).level).toBe(1);
    expect(doc.text.split("\n")[0]).toBe("1. First question");
    // Numbered paragraphs are anchors, at their block index.
    expect(doc.anchors.map((a) => a.number)).toEqual([1, 2, 1, 2]);
  });

  test("list number formats", () => {
    expect(formatListNumber(1, "lowerLetter")).toBe("a");
    expect(formatListNumber(27, "lowerLetter")).toBe("aa");
    expect(formatListNumber(4, "upperRoman")).toBe("IV");
    expect(formatListNumber(3, "decimalZero")).toBe("03");
    expect(formatListNumber(7, "decimal")).toBe("7");
  });

  test("typed numbers are anchors too; a decimal at the start is not", () => {
    const doc = parseWordDocument(documentXml([para("1. Typed number"), para("2.5 grams is not a question"), para("2) Next")]));
    expect(doc.anchors.map((a) => a.number)).toEqual([1, 2]);
  });

  test("tables are one block each, cells joined in the text; headings; pictures counted", () => {
    const doc = parseWordDocument(
      documentXml([
        para("Unit test", { style: "Heading1" }),
        table([
          ["x", "y"],
          ["1", "2"],
        ]),
        `<w:p>${run("See ")}${PICTURE_RUN}${run(" above")}</w:p>`,
      ]),
    );
    expect(doc.blocks.map((b) => b.kind)).toEqual(["paragraph", "table", "paragraph"]);
    expect((doc.blocks[0] as WordParagraph).heading).toBe(1);
    expect(doc.text.split("\n")).toEqual(["Unit test", "x | y", "1 | 2", "See  above"]);
    expect(doc.pictures).toBe(1);
    expect((doc.blocks[2] as WordParagraph).runs).toEqual([{ text: "See " }, { picture: true }, { text: " above" }]);
  });

  test("tracked deletions, field codes and Fallback copies are not read; entities decoded", () => {
    const doc = parseWordDocument(
      documentXml([
        `<w:p>${run("Kept")}<w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:ins>${run(" added")}</w:ins></w:p>`,
        `<w:p><w:r><w:instrText> PAGE </w:instrText></w:r>${run("3 < 4 & 5")}<w:r><w:t>&#x2014;&#233;</w:t></w:r></w:p>`,
        `<w:p><mc:AlternateContent><mc:Choice>${run("choice")}</mc:Choice><mc:Fallback>${run("fallback")}</mc:Fallback></mc:AlternateContent></w:p>`,
      ]),
    );
    expect(doc.text.split("\n")).toEqual(["Kept added", "3 < 4 & 5—é", "choice"]);
  });

  test("readDocx reads a whole file, with and without numbering.xml", () => {
    const withList = readDocx(makeDocx([para("Q", { num: { id: 1 } })]));
    expect(withList.text).toBe("1. Q");
    const without = readDocx(makeDocx([para("Q", { num: { id: 1 } })], { numbering: null }));
    expect(without.text).toBe("Q");
  });

  // Review fix (2026-10-26): the tokenizer was a regex that backtracked
  // super-linearly on a '<' with no '>' (60 KB took 26 s, blocking the
  // server). Now one linear pass that refuses markup that never closes.
  test("quoted '>' in an attribute, comments, a processing instruction and CDATA tokenize as before", () => {
    const doc = parseWordDocument(
      `<?xml version="1.0"?><!-- a > comment --><w:document><w:body>` +
        `<w:p w:x="a>b" w:y='c>d'><w:r><w:t xml:space="preserve">One </w:t></w:r><w:r><w:t><![CDATA[<two>]]></w:t></w:r></w:p>` +
        `</w:body></w:document>`,
    );
    expect(doc.text).toBe("One <two>");
  });

  test("markup that never closes is refused, quickly; readDocx reports it as DocxReadError", () => {
    for (const bad of ["<w:p ".repeat(100_000), "<!--".repeat(100_000), '<w:p a="'.repeat(50_000), "<?x".repeat(100_000)]) {
      const t = performance.now();
      expect(() => parseWordDocument(documentXml([para("Q")]) + bad)).toThrow(WordXmlError);
      expect(performance.now() - t).toBeLessThan(1000);
    }
    const zip = buildZip({ "word/document.xml": documentXml([para("Q")]) + "<w:p" });
    expect(() => readDocx(zip)).toThrow(DocxReadError);
  });
});

describe("regions over Word blocks", () => {
  test("locateCandidates on the pseudo-page gives whole-block ranges", () => {
    const doc = parseWordDocument(
      documentXml([
        para("Directions"),
        para("1. First"),
        para("more of the first"),
        para("2. Second"),
        para("3. Third"),
      ]),
    );
    const regions = locateCandidates([[1], [2], [3], [9]], doc.anchors, doc.pages);
    expect(regions.map((r) => r && regionBlockRange(r, doc.blocks.length))).toEqual([
      { start: 1, end: 3 },
      { start: 3, end: 4 },
      { start: 4, end: 5 },
      // No "9." anywhere: placed by order, no range.
      null,
    ]);
    expect(regions[3]).toMatchObject({ how: "order" });
  });
});

describe("docxGroups", () => {
  test("regions sharing a start share a group; groups end where the next starts; by-order regions are left out", () => {
    const r = (key: string, top: number | null, bottom: number | null) => ({
      key,
      region: { page: 1, top, bottom, how: top === null ? ("order" as const) : ("number" as const) },
    });
    // 10 blocks: a at 1–3, b shares a's start, c at 2–6 (overlaps a), d by order.
    const groups = docxGroups([r("a", 0.1, 0.3), r("b", 0.1, 0.2), r("c", 0.2, 0.6), r("d", null, null)], 10);
    expect(groups.map((g) => [g.start, g.end, g.regions.map((x) => x.key)])).toEqual([
      [1, 2, ["a", "b"]],
      [2, 6, ["c"]],
    ]);
  });
});

function makeNumbering(): string {
  // The same list the file fixtures use.
  return new TextDecoder().decode(readZipEntries(makeDocx([]), ["word/numbering.xml"]).get("word/numbering.xml")!);
}
