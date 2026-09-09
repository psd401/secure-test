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

// Multi-source stimulus slice 5 (docs/multi-source-stimulus-design.md):
// vector figures — a chart drawn as paths, clustered and rasterised.
import {
  CAPTION_GAP_PT,
  type Box,
  type CanvasImport,
  captionAbove,
  clusterPathBoxes,
} from "../lib/pdfImport/extractFigures";
import { type VectorChartSpec, makeVectorChartPdf } from "./helpers/pdf";

const CHART: VectorChartSpec = {
  // Top-left page space: [120, 792-580, 420, 792-400] = [120, 212, 420, 392].
  region: { x: 120, y: 400, width: 300, height: 180 },
  bars: 8,
  caption: "Average uncertainty, 2000-2022",
  inside: ["10", "20", "30"],
  above: ["Source C", "A paragraph of the source."],
  below: ["Note. Something about the chart."],
  rule: true,
  pageRect: true,
};

describe("clusterPathBoxes", () => {
  test("unions boxes within the gap and leaves distant ones alone", () => {
    const a: Box = [0, 0, 10, 10];
    const b: Box = [15, 0, 25, 10]; // 5 pt from a
    const c: Box = [200, 200, 210, 210];
    const out = clusterPathBoxes([a, b, c], 12);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ box: [0, 0, 25, 10], paths: 2 });
    expect(out[1]).toEqual({ box: [200, 200, 210, 210], paths: 1 });
    // A chain merges transitively even though the ends are far apart.
    const chain = clusterPathBoxes([[0, 0, 10, 10], [20, 0, 30, 10], [40, 0, 50, 10]], 12);
    expect(chain).toEqual([{ box: [0, 0, 50, 10], paths: 3 }]);
  });
});

describe("captionAbove", () => {
  const line = (y: number, plain: string, bold: boolean) => ({ y, text: plain, plain, bold, x: 0 });
  test("takes the nearest bold line above, joining a wrapped title", () => {
    const lines = [
      line(10, "Body text well above", false),
      line(60, "A two-line chart title", true),
      line(76, "continued here", true),
      line(200, "below the cluster", true),
    ];
    expect(captionAbove(lines, 96)).toBe("A two-line chart title continued here");
    // Nothing bold close enough above.
    expect(captionAbove([line(10, "far away", true)], 200)).toBeUndefined();
    expect(captionAbove([line(10, "not bold", false)], 20)).toBeUndefined();
    expect(CAPTION_GAP_PT).toBe(24);
  });

  test("brackets are stripped so the caption can be an image alt", () => {
    expect(captionAbove([{ y: 10, text: "Rate [%] of x", plain: "Rate [%] of x", bold: true, x: 0 }], 20)).toBe(
      "Rate % of x",
    );
  });
});

describe("extractPdfLayout: vector figures", () => {
  test("clusters a drawn chart, rasterises it, captions it and takes its text", async () => {
    const layout = await extractPdfLayout(makeVectorChartPdf(CHART));
    expect(layout.figures).toHaveLength(1);
    const f = layout.figures[0]!;
    expect(f.source).toBe("vector");
    expect(f.page).toBe(1);
    // The union of the bars and the two axes is exactly the region.
    [120, 212, 420, 392].forEach((want, i) => expect(Math.abs(f.bbox[i]! - want)).toBeLessThanOrEqual(2));
    expect(f.caption).toBe(CHART.caption);
    expect(f.omitted).toBeUndefined();
    // The crop is the bbox at scale 2 with VECTOR_CROP_PAD_PT of margin.
    expect(f.width_px).toBe((420 + 4) * 2 - (120 - 4) * 2);
    expect(f.height_px).toBe((392 + 4) * 2 - (212 - 4) * 2);
    const png = Buffer.from(f.data_url!.slice("data:image/png;base64,".length), "base64");
    expect(pngDimensions(png)).toEqual({ width: f.width_px, height: f.height_px });
    expect(f.bytes).toBe(png.length);
    expect(f.bytes).toBeGreaterThan(500);

    const lines = layout.textWithMarkers.split("\n");
    // The bold title stays in the text; the marker sits at the cluster's top,
    // right after it. The axis values inside the chart are gone.
    expect(lines).toEqual([
      "Source C",
      "A paragraph of the source.",
      `**${CHART.caption}**`,
      "[FIGURE 1]",
      "Note. Something about the chart.",
    ]);
  });

  test("a lone rule, a page-size rect and a small drawing are not figures", async () => {
    // Only the rule and the page background: one painted path and one
    // page-cover rect, so nothing clusters into a figure.
    const bare = await extractPdfLayout(
      makeVectorChartPdf({ ...CHART, bars: 0, inside: [], region: { x: 0, y: 0, width: 0, height: 0 } }),
    );
    expect(bare.figures).toEqual([]);
    expect(bare.textWithMarkers).not.toContain("[FIGURE");
    // Enough paths, but the drawing is under MIN_FIGURE_PT on both sides.
    const tiny = await extractPdfLayout(
      makeVectorChartPdf({
        ...CHART,
        inside: [],
        region: { x: 120, y: 400, width: MIN_FIGURE_PT - 5, height: MIN_FIGURE_PT - 5 },
      }),
    );
    expect(tiny.figures).toEqual([]);
    // Big enough, but only three painted paths (one bar plus the two axes).
    const sparse = await extractPdfLayout(makeVectorChartPdf({ ...CHART, bars: 1, inside: [] }));
    expect(sparse.figures).toEqual([]);
  });

  test("a text-only page renders nothing — the canvas is never loaded", async () => {
    let loads = 0;
    const spy: CanvasImport = async () => {
      loads += 1;
      return await import("@napi-rs/canvas");
    };
    const layout = await extractPdfLayout(makeTextPdf(LINES), { ...DEFAULT_FIGURE_LIMITS, canvasImport: spy });
    expect(layout.figures).toEqual([]);
    expect(loads).toBe(0);
    // …and it IS loaded for a page that has a cluster.
    await extractPdfLayout(makeVectorChartPdf({ ...CHART, inside: [] }), {
      ...DEFAULT_FIGURE_LIMITS,
      canvasImport: spy,
    });
    expect(loads).toBe(1);
  });

  test("a canvas that will not load costs no raster figure and no text", async () => {
    const broken: CanvasImport = () => Promise.reject(new Error("no native binary"));
    const vector = await extractPdfLayout(makeVectorChartPdf({ ...CHART }), {
      ...DEFAULT_FIGURE_LIMITS,
      canvasImport: broken,
    });
    expect(vector.figures).toEqual([]);
    // The chart's own labels stay in the text — nothing owns them now.
    expect(vector.textWithMarkers).toContain("Source C");
    expect(vector.textWithMarkers).toContain("10");
    expect(vector.textWithMarkers).not.toContain("[FIGURE");
    // The raster walk is untouched.
    const raster = await extractPdfLayout(makeTextAndImagePdf(LINES, IMAGE), {
      ...DEFAULT_FIGURE_LIMITS,
      canvasImport: broken,
    });
    expect(raster.figures).toHaveLength(1);
    expect(raster.figures[0]).toMatchObject({ source: "raster", width_px: 2 });
    expect(raster.textWithMarkers).toContain("[FIGURE 1]");
  });

  test("the byte limits apply to a vector figure too", async () => {
    const capped = await extractPdfLayout(makeVectorChartPdf({ ...CHART, inside: [] }), {
      ...DEFAULT_FIGURE_LIMITS,
      maxFigureBytes: 10,
    });
    expect(capped.figures[0]).toMatchObject({ source: "vector", data_url: null, bytes: 0, omitted: "too_large" });
    expect(capped.textWithMarkers).toContain("[FIGURE 1]");
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
