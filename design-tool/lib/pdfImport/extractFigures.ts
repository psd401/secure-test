import { extractImages, getDocumentProxy, getResolvedPDFJS } from "unpdf";
import { encodePng } from "./png";

// E5 slice 4 (docs/stimulus-design.md; spike S1 made this the plan): the
// raster figures of a text-layer PDF, each with its page position, plus the
// page text with a `[FIGURE n]` marker spliced in where each figure sits —
// what the extractor prompt reads (slice 3) so the model can say which
// questions a figure belongs to. Pure JS through unpdf / pdf.js (ADR 0013).
//
// How a figure's position is known: the page's operator list is walked with
// a transform stack (save / restore / transform / form-XObject begin+end);
// every image paint maps the unit square through the current matrix, and
// the viewport transform puts the result in top-left-origin page space —
// the frame the text runs are placed in below. The spike matched 41 of 41
// real figures in the 12-PDF sample this way.
//
// Extraction writes nothing (James, 2026-09-01): figures ride the response
// as data URLs and become assets only when the teacher adds a set.

export interface PdfFigure {
  /** 1-based, in document order (page, then top-to-bottom). */
  n: number;
  /** 1-based page number. */
  page: number;
  /** Page-space bbox in points, top-left origin: [x0, y0, x1, y1]. */
  bbox: [number, number, number, number];
  width_px: number;
  height_px: number;
  /** PNG data URL, or null when the figure was omitted (see `omitted`). */
  data_url: string | null;
  /** Encoded PNG size, 0 when omitted. */
  bytes: number;
  /** Why there is no data_url: the pixels could not be read, one figure was
   * over MAX_FIGURE_BYTES, or the response budget was spent. */
  omitted?: "no_pixels" | "too_large" | "budget";
}

export interface PdfLayout {
  pageCount: number;
  /** Page text in reading order, one line per text line, pages separated by
   * a blank line, with `[FIGURE n]` on its own line at each figure's top. */
  textWithMarkers: string;
  figures: PdfFigure[];
}

/** Below this many points on either side an image is decoration, not a figure. */
export const MIN_FIGURE_PT = 40;
/** One figure's PNG above this is left out (its position is still reported). */
export const MAX_FIGURE_BYTES = 2 * 1024 * 1024;
/** Total PNG bytes one response carries; beyond it figures are position-only. */
export const MAX_FIGURES_TOTAL_BYTES = 12 * 1024 * 1024;
/** Hard cap on figures per document. */
export const MAX_FIGURES = 60;

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

interface Paint {
  name: string;
  bbox: [number, number, number, number];
}

interface TextLine {
  y: number;
  text: string;
}

export function figureMarker(n: number): string {
  return `[FIGURE ${n}]`;
}

/**
 * Text lines (top-left-origin page space) with figure markers interleaved by
 * vertical position. Exported for tests; pure.
 */
export function interleaveMarkers(
  lines: readonly TextLine[],
  figures: readonly { n: number; top: number }[],
): string {
  const rows: { y: number; order: number; text: string }[] = [];
  lines.forEach((l, i) => rows.push({ y: l.y, order: 1, text: l.text }));
  // A marker sorts before a line at the same height — the figure's top edge
  // is above the text that starts beside it.
  for (const f of figures) rows.push({ y: f.top, order: 0, text: figureMarker(f.n) });
  rows.sort((a, b) => a.y - b.y || a.order - b.order);
  return rows.map((r) => r.text).join("\n");
}

// E6 (decision James 2026-09-02): emphasis from the text layer. Spike S3
// (docs/stimulus-design.md) showed each run's font carries bold / italic
// (pdf.js flags, or the BaseFont name — "Arial-BoldMT"); underline is a
// drawn path and is not carried. Runs are wrapped as `**bold**` /
// `_italic_` in the text the model reads, and the prompt tells it to keep
// the markers. One guard: emphasis is the minority style on a page. When
// more than half of a page's characters are bold (a worksheet set in a
// bold face throughout), bold is that page's body and is not marked; same
// for italic.
export interface RunStyle {
  bold: boolean;
  italic: boolean;
}

export interface StyledRun {
  str: string;
  style: RunStyle;
}

const NO_STYLE: RunStyle = { bold: false, italic: false };

/** Font flags for one run: pdf.js's own flags, else the BaseFont name. */
export function styleOfFont(font: { bold?: unknown; italic?: unknown; name?: unknown } | null | undefined): RunStyle {
  if (!font) return NO_STYLE;
  const name = typeof font.name === "string" ? font.name : "";
  return {
    bold: font.bold === true || /bold|black|heavy|semibold|demibold/i.test(name),
    italic: font.italic === true || /italic|oblique/i.test(name),
  };
}

/**
 * Join a line's runs (already left-to-right) into text, wrapping each
 * maximal group of same-style runs once: `**a b**`, `_c_`, `**_d_**`.
 * `mark` says which styles count on this page (the majority guard).
 */
export function emphasizeRuns(runs: readonly StyledRun[], mark: RunStyle = { bold: true, italic: true }): string {
  const groups: { text: string; style: RunStyle }[] = [];
  for (const r of runs) {
    const str = r.str.trim();
    if (!str) continue;
    const style = { bold: mark.bold && r.style.bold, italic: mark.italic && r.style.italic };
    const last = groups[groups.length - 1];
    if (last && last.style.bold === style.bold && last.style.italic === style.italic) last.text += ` ${str}`;
    else groups.push({ text: str, style });
  }
  return groups
    .map((g) => {
      let t = g.text.replace(/\s+/g, " ");
      if (g.style.italic) t = `_${t}_`;
      if (g.style.bold) t = `**${t}**`;
      return t;
    })
    .join(" ");
}

/** Which styles are emphasis (not the body face) on a page of runs. */
export function emphasisMarks(runs: readonly StyledRun[]): RunStyle {
  let total = 0;
  let bold = 0;
  let italic = 0;
  for (const r of runs) {
    const n = r.str.trim().length;
    total += n;
    if (r.style.bold) bold += n;
    if (r.style.italic) italic += n;
  }
  return { bold: total > 0 && bold * 2 <= total, italic: total > 0 && italic * 2 <= total };
}

// Group text runs into lines: same baseline (within a couple of points),
// left to right. pdf.js gives each run its own transform; item[5] is the
// baseline y in user space, mapped here through the viewport transform.
function linesOf(
  items: { str: string; transform: number[]; fontName?: string }[],
  base: M,
  styleOf: (fontName: string | undefined) => RunStyle = () => NO_STYLE,
): TextLine[] {
  const runs = items
    .filter((it) => it.str && it.str.trim().length > 0)
    .map((it) => {
      const [x, y] = apply(base, it.transform[4] ?? 0, it.transform[5] ?? 0);
      return { x, y, str: it.str, style: styleOf(it.fontName) };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const mark = emphasisMarks(runs);
  const lines: { y: number; parts: { x: number; str: string; style: RunStyle }[] }[] = [];
  for (const r of runs) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - r.y) <= 2.5) last.parts.push({ x: r.x, str: r.str, style: r.style });
    else lines.push({ y: r.y, parts: [{ x: r.x, str: r.str, style: r.style }] });
  }
  return lines.map((l) => ({
    y: l.y,
    text: emphasizeRuns(
      l.parts.sort((a, b) => a.x - b.x),
      mark,
    ),
  }));
}

export interface FigureLimits {
  maxFigureBytes: number;
  maxTotalBytes: number;
  maxFigures: number;
}
export const DEFAULT_FIGURE_LIMITS: FigureLimits = {
  maxFigureBytes: MAX_FIGURE_BYTES,
  maxTotalBytes: MAX_FIGURES_TOTAL_BYTES,
  maxFigures: MAX_FIGURES,
};

export async function extractPdfLayout(
  bytes: Uint8Array,
  limits: FigureLimits = DEFAULT_FIGURE_LIMITS,
): Promise<PdfLayout> {
  const pdfjs = (await getResolvedPDFJS()) as { OPS: Record<string, number> };
  const OPS = pdfjs.OPS;
  // pdfjs transfers the buffer it is handed (see extractText.ts) — copy.
  const doc = await getDocumentProxy(bytes.slice());
  const figures: PdfFigure[] = [];
  const pageTexts: string[] = [];
  let totalBytes = 0;
  let n = 0;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const base = page.getViewport({ scale: 1 }).transform as M;
    const ops = await page.getOperatorList();
    const stack: M[] = [];
    let ctm: M = base;
    const paints: Paint[] = [];
    const record = (name: string, m: M) => {
      const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      paints.push({
        name,
        bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      });
    };
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i] as unknown[];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = mul(ctm, args as unknown as M);
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        if (Array.isArray(args[0])) ctm = mul(ctm, args[0] as M);
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.paintImageXObject) record(String(args[0]), ctm);
      else if (fn === OPS.paintImageXObjectRepeat) {
        const [id, sx, sy, pos] = args as [string, number, number, number[]];
        for (let k = 0; k + 1 < pos.length; k += 2) {
          record(String(id), mul(ctm, [sx, 0, 0, sy, pos[k]!, pos[k + 1]!]));
        }
      }
    }

    const sized = paints
      .filter((pt) => pt.bbox[2] - pt.bbox[0] > MIN_FIGURE_PT && pt.bbox[3] - pt.bbox[1] > MIN_FIGURE_PT)
      .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);

    let images: { key: string; width: number; height: number; channels: number; data: Uint8ClampedArray }[] = [];
    if (sized.length > 0) {
      try {
        images = (await extractImages(doc, p)) as typeof images;
      } catch {
        images = [];
      }
    }
    const byKey = new Map(images.map((im) => [String(im.key), im]));
    const pageFigures: { n: number; top: number }[] = [];
    for (const pt of sized) {
      if (n >= limits.maxFigures) break;
      n += 1;
      const im = byKey.get(pt.name);
      const fig: PdfFigure = {
        n,
        page: p,
        bbox: pt.bbox.map((v) => Math.round(v * 10) / 10) as PdfFigure["bbox"],
        width_px: im?.width ?? 0,
        height_px: im?.height ?? 0,
        data_url: null,
        bytes: 0,
      };
      if (!im || !im.data || !(im.channels === 1 || im.channels === 2 || im.channels === 3 || im.channels === 4)) {
        fig.omitted = "no_pixels";
      } else {
        let png: Buffer | null = null;
        try {
          png = encodePng(im.width, im.height, im.channels, im.data);
        } catch {
          png = null;
        }
        if (!png) fig.omitted = "no_pixels";
        else if (png.length > limits.maxFigureBytes) fig.omitted = "too_large";
        else if (totalBytes + png.length > limits.maxTotalBytes) fig.omitted = "budget";
        else {
          totalBytes += png.length;
          fig.bytes = png.length;
          fig.data_url = `data:image/png;base64,${png.toString("base64")}`;
        }
      }
      figures.push(fig);
      pageFigures.push({ n, top: pt.bbox[1] });
    }

    const content = await page.getTextContent();
    // E6: fonts resolve into page.commonObjs while the operator list above
    // is built; before that, `get` throws "isn't resolved yet" (spike S3).
    const commonObjs = (page as { commonObjs?: { get: (k: string) => unknown } }).commonObjs;
    const styleCache = new Map<string, RunStyle>();
    const styleOf = (key: string | undefined): RunStyle => {
      if (!key) return NO_STYLE;
      const hit = styleCache.get(key);
      if (hit) return hit;
      let style = NO_STYLE;
      try {
        style = styleOfFont(commonObjs?.get(key) as Parameters<typeof styleOfFont>[0]);
      } catch {
        style = NO_STYLE;
      }
      styleCache.set(key, style);
      return style;
    };
    const lines = linesOf(content.items as { str: string; transform: number[]; fontName?: string }[], base, styleOf);
    pageTexts.push(interleaveMarkers(lines, pageFigures));
  }

  return { pageCount: doc.numPages, textWithMarkers: pageTexts.join("\n\n"), figures };
}
