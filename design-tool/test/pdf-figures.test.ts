// E5 slice 4: raster figures with positions + `[FIGURE n]` markers in the
// text the model reads. Runs the real unpdf / pdf.js path on hand-built PDFs.
import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import {
  DEFAULT_FIGURE_LIMITS,
  MIN_FIGURE_PT,
  extractPdfLayout,
  figureMarker,
  interleaveMarkers,
} from "../lib/pdfImport/extractFigures";
import { PNG_SIGNATURE, encodePng, pngDimensions } from "../lib/pdfImport/png";
import { makeStyledTextPdf, makeTextAndImagePdf, makeTextPdf } from "./helpers/pdf";

const LINES = ["1. First question", "2. Second question", "3. Third", "4. Fourth", "5. Fifth", "6. Sixth"];
// 120×90 pt image, left 100, bottom 560 → top-left-origin bbox [100,142,220,232]:
// below the line at baseline 136 (line 5) and above the one at 152 (line 6).
const IMAGE = { x: 100, y: 560, width: 120, height: 90 };

function idatBytes(png: Uint8Array): Buffer {
  const b = Buffer.from(png);
  let at = 8;
  while (at < b.length) {
    const len = b.readUInt32BE(at);
    const type = b.subarray(at + 4, at + 8).toString("ascii");
    if (type === "IDAT") return inflateSync(b.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  throw new Error("no IDAT");
}

describe("encodePng", () => {
  test("writes a PNG with the right header and filter-0 rows", () => {
    const png = encodePng(2, 1, 3, new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(Buffer.from(png.subarray(0, 8)).equals(PNG_SIGNATURE)).toBe(true);
    expect(pngDimensions(png)).toEqual({ width: 2, height: 1 });
    expect([...idatBytes(png)]).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("expands gray+alpha to RGBA and rejects a short buffer", () => {
    const png = encodePng(1, 1, 2, new Uint8Array([9, 255]));
    expect([...idatBytes(png)]).toEqual([0, 9, 9, 9, 255]);
    expect(() => encodePng(2, 2, 3, new Uint8Array(3))).toThrow(/too short/);
  });
});

describe("interleaveMarkers", () => {
  test("puts each marker at its height, before a line at the same height", () => {
    const text = interleaveMarkers(
      [
        { y: 72, text: "1. a" },
        { y: 100, text: "2. b" },
        { y: 130, text: "3. c" },
      ],
      [
        { n: 1, top: 100 },
        { n: 2, top: 125 },
      ],
    );
    expect(text.split("\n")).toEqual(["1. a", "[FIGURE 1]", "2. b", "[FIGURE 2]", "3. c"]);
    expect(figureMarker(7)).toBe("[FIGURE 7]");
  });
});

describe("extractPdfLayout", () => {
  test("finds the figure with its page position and pixels, and marks the text", async () => {
    const layout = await extractPdfLayout(makeTextAndImagePdf(LINES, IMAGE));
    expect(layout.pageCount).toBe(1);
    expect(layout.figures).toHaveLength(1);
    const f = layout.figures[0]!;
    expect(f.n).toBe(1);
    expect(f.page).toBe(1);
    expect(f.bbox).toEqual([100, 142, 220, 232]);
    expect(f.width_px).toBe(2);
    expect(f.height_px).toBe(2);
    expect(f.omitted).toBeUndefined();
    expect(f.data_url?.startsWith("data:image/png;base64,")).toBe(true);
    const png = Buffer.from(f.data_url!.slice("data:image/png;base64,".length), "base64");
    expect(pngDimensions(png)).toEqual({ width: 2, height: 2 });
    // The image XObject's bytes were the ASCII "ABCDEFGHIJKL" as raw RGB.
    const rows = [...idatBytes(png)];
    expect(rows.slice(1, 7)).toEqual([65, 66, 67, 68, 69, 70]);
    expect(f.bytes).toBe(png.length);

    const lines = layout.textWithMarkers.split("\n");
    expect(lines).toEqual([
      "1. First question",
      "2. Second question",
      "3. Third",
      "4. Fourth",
      "5. Fifth",
      "[FIGURE 1]",
      "6. Sixth",
    ]);
  });

  test("a PDF without figures yields the text alone; a tiny image is decoration", async () => {
    const plain = await extractPdfLayout(makeTextPdf(LINES));
    expect(plain.figures).toEqual([]);
    expect(plain.textWithMarkers.split("\n")).toEqual(LINES);
    const tiny = await extractPdfLayout(
      makeTextAndImagePdf(LINES, { ...IMAGE, width: MIN_FIGURE_PT - 1, height: MIN_FIGURE_PT - 1 }),
    );
    expect(tiny.figures).toEqual([]);
    expect(tiny.textWithMarkers).not.toContain("[FIGURE");
  });

  test("limits: an oversize figure keeps its position but no pixels; the figure cap drops it", async () => {
    const pdf = makeTextAndImagePdf(LINES, IMAGE);
    const capped = await extractPdfLayout(pdf, { ...DEFAULT_FIGURE_LIMITS, maxFigureBytes: 10 });
    expect(capped.figures[0]).toMatchObject({ n: 1, page: 1, width_px: 2, data_url: null, bytes: 0, omitted: "too_large" });
    expect(capped.textWithMarkers).toContain("[FIGURE 1]");
    const budget = await extractPdfLayout(pdf, { ...DEFAULT_FIGURE_LIMITS, maxTotalBytes: 10 });
    expect(budget.figures[0]?.omitted).toBe("budget");
    const none = await extractPdfLayout(pdf, { ...DEFAULT_FIGURE_LIMITS, maxFigures: 0 });
    expect(none.figures).toEqual([]);
    expect(none.textWithMarkers).not.toContain("[FIGURE");
  });
});

// E6 (2026-09-02): emphasis from the text layer's font runs.
import { emphasisMarks, emphasizeRuns, extractPdfLayout as extractLayoutE6, styleOfFont } from "../lib/pdfImport/extractFigures";

describe("E6 emphasis from font runs", () => {
  const B = { bold: true, italic: false };
  const I = { bold: false, italic: true };
  const R = { bold: false, italic: false };

  test("styleOfFont reads pdf.js flags or the BaseFont name", () => {
    expect(styleOfFont({ name: "CAAAAA+Arial-BoldMT" })).toEqual(B);
    expect(styleOfFont({ name: "TimesNewRomanPS-BoldItalicMT" })).toEqual({ bold: true, italic: true });
    expect(styleOfFont({ italic: true, name: "g_d0_f1" })).toEqual(I);
    expect(styleOfFont({ name: "Helvetica" })).toEqual(R);
    expect(styleOfFont(null)).toEqual(R);
  });

  test("emphasizeRuns wraps maximal same-style groups once", () => {
    expect(
      emphasizeRuns([
        { str: "Which is", style: R },
        { str: "NOT", style: B },
        { str: "an", style: R },
        { str: "abiotic", style: I },
        { str: "factor?", style: R },
      ]),
    ).toBe("Which is **NOT** an _abiotic_ factor?");
    expect(emphasizeRuns([{ str: "AB", style: B }, { str: "IOTIC", style: B }, { str: " ", style: R }])).toBe("**AB IOTIC**");
    expect(emphasizeRuns([{ str: "both", style: { bold: true, italic: true } }])).toBe("**_both_**");
    // The page guard: bold not marked when bold is the body face.
    expect(emphasizeRuns([{ str: "x", style: B }], { bold: false, italic: true })).toBe("x");
  });

  test("emphasisMarks: a style covering more than half the page's characters is the body, not emphasis", () => {
    expect(emphasisMarks([{ str: "abcdefgh", style: B }, { str: "ij", style: R }])).toEqual({ bold: false, italic: true });
    expect(emphasisMarks([{ str: "ab", style: B }, { str: "cdefghij", style: R }])).toEqual({ bold: true, italic: true });
    expect(emphasisMarks([])).toEqual({ bold: false, italic: false });
  });

  test("extractPdfLayout marks bold and italic runs from a real text layer", async () => {
    const layout = await extractLayoutE6(
      makeStyledTextPdf([
        [{ text: "7. Which of these is" }, { text: "NOT", face: "bold" }, { text: "an" }, { text: "abiotic", face: "italic" }, { text: "factor?" }],
        [{ text: "A) sunlight  B) water  C) a fern  D) soil" }],
      ]),
    );
    expect(layout.textWithMarkers).toContain("**NOT**");
    expect(layout.textWithMarkers).toContain("_abiotic_");
    expect(layout.textWithMarkers).toContain("A) sunlight");
  });

  test("a page set entirely in bold carries no bold markers", async () => {
    const layout = await extractLayoutE6(
      makeStyledTextPdf([
        [{ text: "1. Everything here is bold", face: "bold" }],
        [{ text: "2. and so is this line", face: "bold" }],
      ]),
    );
    expect(layout.textWithMarkers).not.toContain("**");
    expect(layout.textWithMarkers).toContain("Everything here is bold");
  });
});
