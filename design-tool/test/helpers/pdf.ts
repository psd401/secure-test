// Hand-built PDFs for tests (no teacher PDF enters the repo). Lifted from
// pdf-import-route.test.ts when E5 slice 4 needed a PDF with an embedded
// raster figure as well.

/** Assemble numbered objects + xref + trailer into valid PDF bytes. */
export function buildPdf(objs: (string | Uint8Array)[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (s: string | Uint8Array) => {
    const b = typeof s === "string" ? new TextEncoder().encode(s) : s;
    parts.push(b);
    length += b.length;
  };
  push("%PDF-1.4\n");
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(length);
    push(`${i + 1} 0 obj\n`);
    push(body);
    push("\nendobj\n");
  });
  const xrefStart = length;
  push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`);
  offsets.forEach((off) => push(`${String(off).padStart(10, "0")} 00000 n \n`));
  push(`trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/**
 * One page, Helvetica 12pt, each line 16pt below the previous starting at
 * y=720 (PDF user space, y up). Empty `lines` → no text layer (scanned).
 */
export function makeTextPdf(lines: string[]): Uint8Array {
  let content = "BT /F1 12 Tf 72 720 Td";
  lines.forEach((line, i) => {
    if (i > 0) content += " 0 -16 Td";
    content += ` (${esc(line)}) Tj`;
  });
  content += " ET";
  return buildPdf([
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>",
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ]);
}

/**
 * Many pages of Helvetica 12pt text, one content stream per page and one
 * shared font object — the public-release stand-in for the OSPI reference
 * PDF that pdf-extract.test.ts used to read (a 66-page state document is
 * not ours to redistribute). Object layout: 1 catalog, 2 pages, 3 font,
 * then for page i (0-based) the page object at 4+2i and its stream at 5+2i.
 */
export function makeMultiPageTextPdf(pages: string[][]): Uint8Array {
  const kids = pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ");
  const objs: string[] = [
    "<</Type/Catalog/Pages 2 0 R>>",
    `<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  pages.forEach((lines, i) => {
    let content = "BT /F1 12 Tf 72 720 Td";
    lines.forEach((line, j) => {
      if (j > 0) content += " 0 -16 Td";
      content += ` (${esc(line)}) Tj`;
    });
    content += " ET";
    objs.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents ${5 + 2 * i} 0 R>>`,
      `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    );
  });
  return buildPdf(objs);
}

/**
 * E6: one page like makeTextPdf, but each line names its face — F1
 * Helvetica, F2 Helvetica-Bold, F3 Helvetica-Oblique — and a line may be
 * split into runs of different faces (each run is its own Tj on the same
 * baseline, advanced by `Td` so pdf.js sees separate items left to right).
 */
export type StyledRun = { text: string; face?: "regular" | "bold" | "italic" };
export function makeStyledTextPdf(lines: StyledRun[][]): Uint8Array {
  const faceOf = (f: StyledRun["face"]) => (f === "bold" ? "F2" : f === "italic" ? "F3" : "F1");
  let content = "BT 72 720 Td";
  lines.forEach((runs, i) => {
    if (i > 0) content += " 0 -16 Td";
    let dx = 0;
    runs.forEach((run) => {
      // Advance ~6.5pt per character of the previous run so runs never overlap.
      content += ` ${dx} 0 Td /${faceOf(run.face)} 12 Tf (${esc(run.text)}) Tj`;
      dx = Math.round(run.text.length * 6.5) + 6;
    });
    if (dx) content += ` ${-runs.slice(0, -1).reduce((acc, r) => acc + Math.round(r.text.length * 6.5) + 6, 0)} 0 Td`;
  });
  content += " ET";
  return buildPdf([
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R/F2 6 0 R/F3 7 0 R>>>>/Contents 4 0 R>>",
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Oblique>>",
  ]);
}

/**
 * N pages with no text layer at all (scanned-PDF stand-in). `padStreamBytes`
 * inflates the shared content stream with whitespace to exercise the OCR
 * byte cap without a real 4.5 MB scan.
 */
export function makeEmptyPagesPdf(pageCount: number, padStreamBytes = 0): Uint8Array {
  const contentsObj = 3 + pageCount;
  const pad = " ".repeat(padStreamBytes);
  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i} 0 R`).join(" ");
  return buildPdf([
    "<</Type/Catalog/Pages 2 0 R>>",
    `<</Type/Pages/Kids[${kids}]/Count ${pageCount}>>`,
    ...Array.from(
      { length: pageCount },
      () => `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentsObj} 0 R>>`,
    ),
    `<</Length ${pad.length}>>\nstream\n${pad}\nendstream`,
  ]);
}

// Multi-source stimulus slice 5 (docs/multi-source-stimulus-design.md): a
// chart drawn as PATHS, the shape the pilot document's OECD figures have.
// Nothing here is an image XObject — the extractor has to find the drawing by
// clustering painted paths, and rasterise the page to get a picture of it.
export interface VectorChartSpec {
  /** The chart's region in PDF user space (y UP, bottom-left origin). */
  region: { x: number; y: number; width: number; height: number };
  /** Filled bars drawn inside the region; two stroked axes are added, so the
   * painted-path count is `bars + 2`. */
  bars: number;
  /** Bold title line, baseline 12 pt above the region's top. */
  caption: string;
  /** Regular text lines inside the region (axis values, a legend). */
  inside: string[];
  /** Regular text lines above the caption (from y = 760 down). */
  above: string[];
  /** Regular text lines below the region. */
  below: string[];
  /** A single stroked rule near the top of the page — one painted path, so
   * never a figure. */
  rule?: boolean;
  /** Fill a page-size rectangle first: the page background, which must not
   * count as a drawing. */
  pageRect?: boolean;
}

export function makeVectorChartPdf(spec: VectorChartSpec): Uint8Array {
  const { region } = spec;
  const parts: string[] = [];
  if (spec.pageRect) parts.push("q 1 1 1 rg 0 0 612 792 re f Q");
  if (spec.rule) parts.push("q 0 0 0 RG 1 w 72 770 m 540 770 l S Q");
  // Bars: each inside the region, none touching its edges but all within the
  // 12 pt cluster gap of the axes.
  const step = region.width / spec.bars;
  const barW = Math.max(2, step - 4);
  for (let i = 0; i < spec.bars; i++) {
    const h = region.height * (0.3 + (0.6 * i) / Math.max(1, spec.bars - 1));
    parts.push(
      `q 0 0 1 rg ${(region.x + i * step + 2).toFixed(2)} ${region.y.toFixed(2)} ${barW.toFixed(2)} ${h.toFixed(2)} re f Q`,
    );
  }
  // Axes: the left and bottom edges, so the union of the painted paths is
  // exactly the region.
  parts.push(
    `q 0 0 0 RG 1 w ${region.x} ${region.y} m ${region.x} ${region.y + region.height} l S Q`,
    `q 0 0 0 RG 1 w ${region.x} ${region.y} m ${region.x + region.width} ${region.y} l S Q`,
  );
  const text = (face: "F1" | "F2", x: number, y: number, s: string) =>
    `BT /${face} 12 Tf 1 0 0 1 ${x} ${y} Tm (${esc(s)}) Tj ET`;
  spec.above.forEach((l, i) => parts.push(text("F1", 72, 760 - i * 16, l)));
  parts.push(text("F2", 72, region.y + region.height + 12, spec.caption));
  spec.inside.forEach((l, i) => parts.push(text("F1", region.x + 10, region.y + region.height - 20 - i * 16, l)));
  spec.below.forEach((l, i) => parts.push(text("F1", 72, region.y - 20 - i * 16, l)));
  const content = parts.join("\n");
  return buildPdf([
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>/Contents 4 0 R>>",
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold>>",
  ]);
}

export interface PlacedImage {
  /** Left edge in points (PDF user space). */
  x: number;
  /** BOTTOM edge in points, y up. */
  y: number;
  width: number;
  height: number;
}

/**
 * E5 slice 4: text lines plus one uncompressed 2×2 DeviceRGB image XObject
 * drawn at `image`. Pixel bytes are the ASCII "ABCDEFGHIJKL" so a test can
 * recognise them after decoding. Lines are laid out as in makeTextPdf.
 */
export function makeTextAndImagePdf(lines: string[], image: PlacedImage): Uint8Array {
  let text = "BT /F1 12 Tf 72 720 Td";
  lines.forEach((line, i) => {
    if (i > 0) text += " 0 -16 Td";
    text += ` (${esc(line)}) Tj`;
  });
  text += " ET";
  const draw = `q ${image.width} 0 0 ${image.height} ${image.x} ${image.y} cm /Im1 Do Q`;
  const content = `${text}\n${draw}`;
  const pixels = "ABCDEFGHIJKL";
  return buildPdf([
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>/XObject<</Im1 6 0 R>>>>/Contents 4 0 R>>",
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    `<</Type/XObject/Subtype/Image/Width 2/Height 2/ColorSpace/DeviceRGB/BitsPerComponent 8/Length ${pixels.length}>>\nstream\n${pixels}\nendstream`,
  ]);
}
