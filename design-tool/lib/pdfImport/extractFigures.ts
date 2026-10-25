import {
  createIsomorphicCanvasFactory,
  extractImages,
  getDocumentProxy,
  getResolvedPDFJS,
  renderPageAsImage,
} from "unpdf";
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
  /** Multi-source stimulus slice 5 (docs/multi-source-stimulus-design.md):
   * `raster` = an image XObject painted on the page; `vector` = a cluster of
   * drawn paths (a chart) rasterised here. The teacher sees a "chart" tag on
   * the second kind and nothing else differs. */
  source: "raster" | "vector";
  /** Slice 5: the printed title line above a vector figure (the nearest bold
   * line within CAPTION_GAP_PT). It stays in the page text as well and is
   * used as the image's alt text. Raster figures have none. */
  caption?: string;
  /** Import fixes slice 1 (2026-10-25): text starts to the left of the
   * figure at the same height — it is printed beside its question, so it
   * belongs to that question (questionAfterFigure), not the next one. */
  beside?: true;
  /** PDF-import fixes (2026-10-25): a ruled area with most of its cells
   * empty — a blank graph grid or a table for the student to fill. It is
   * where the answer goes, not something to read: never a stimulus. */
  answer_area?: true;
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

// --- Multi-source stimulus slice 5: vector figures (charts drawn as paths) ---
// The pilot's charts are path drawings, not image XObjects, so the raster
// walk above saw nothing. Painted paths within PATH_CLUSTER_GAP_PT of each
// other are one drawing; a drawing of at least MIN_CLUSTER_PATHS paths and
// MIN_FIGURE_PT on both sides is a figure, rasterised from the rendered page.

/** Two painted paths this close (points, any side) belong to one drawing. */
export const PATH_CLUSTER_GAP_PT = 12;
/** Fewer painted paths than this is a rule or an underline, not a chart. */
export const MIN_CLUSTER_PATHS = 8;
/** A path box covering this much of the page on BOTH sides is the page
 * background / a full-page clip, never a figure. */
const PAGE_COVER_RATIO = 0.9;
/** Render scale for the page a vector figure is cropped out of. */
export const VECTOR_RENDER_SCALE = 2;
/** Points of margin kept around a cropped cluster. */
export const VECTOR_CROP_PAD_PT = 4;
/** A bold line this far above a cluster (points) is its printed title. */
export const CAPTION_GAP_PT = 24;
/** Import fixes slice 1: a short run (a vertex or point label: "R", "AB")
 * this close to a vector figure belongs to the drawing, not the text line
 * it shares a baseline with. */
export const FIGURE_LABEL_PAD_PT = 12;
const MAX_LABEL_CHARS = 4;
/** Longest caption kept (it becomes an image's alt text). */
const MAX_CAPTION_CHARS = 200;
/** Beyond this many painted paths a page is not clustered — the O(n²) merge
 * would cost the teacher the import for no gain (a page that dense is
 * artwork, not a chart). */
export const MAX_PATHS_PER_PAGE = 4000;

/** What `renderPageAsImage` and the crop need; injectable so a test can hand
 * in one that throws (the guard must never cost the teacher the import). */
export type CanvasImport = () => Promise<typeof import("@napi-rs/canvas")>;
const defaultCanvasImport: CanvasImport = () => import("@napi-rs/canvas");

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
  /** Slice 5: the line's leftmost run, for the "inside a cluster" test. */
  x?: number;
  /** Slice 5: every run on the line is bold (raw font style, before the
   * page's majority guard) — a caption candidate. */
  bold?: boolean;
  /** Slice 5: the line without E6 emphasis markers, for a caption. */
  plain?: string;
}

export type Box = [number, number, number, number];

/** A cluster of painted paths: its page-space box and how many paths it holds. */
export interface PathCluster {
  box: Box;
  paths: number;
}

const boxesNear = (a: Box, b: Box, gap: number): boolean =>
  a[0] - gap <= b[2] && b[0] - gap <= a[2] && a[1] - gap <= b[3] && b[1] - gap <= a[3];

const unionBox = (a: Box, b: Box): Box => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

/**
 * Slice 5: union any two path boxes within `gap` points of each other until
 * nothing merges. Exported for tests; pure. Each sweep merges as many pairs
 * as it can, so a 500-path chart page settles in a couple of sweeps.
 */
export function clusterPathBoxes(boxes: readonly Box[], gap: number = PATH_CLUSTER_GAP_PT): PathCluster[] {
  const out: PathCluster[] = boxes.map((b) => ({ box: [...b] as Box, paths: 1 }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; ) {
        if (boxesNear(out[i]!.box, out[j]!.box, gap)) {
          out[i] = { box: unionBox(out[i]!.box, out[j]!.box), paths: out[i]!.paths + out[j]!.paths };
          out.splice(j, 1);
          merged = true;
        } else j++;
      }
    }
  }
  return out.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
}

/**
 * Slice 5: the printed title above a cluster — the nearest bold line above
 * its top within CAPTION_GAP_PT, plus the bold lines contiguous with it
 * (a two-line wrapped chart title is one caption). Exported for tests; pure.
 */
export function captionAbove(lines: readonly TextLine[], top: number, gap: number = CAPTION_GAP_PT): string | undefined {
  const above = lines
    .filter((l) => l.bold && l.y < top && (l.plain ?? l.text).trim().length > 0)
    .sort((a, b) => a.y - b.y);
  const seedAt = above.length - 1;
  if (seedAt < 0 || top - above[seedAt]!.y > gap) return undefined;
  const picked = [above[seedAt]!];
  for (let i = seedAt - 1; i >= 0; i--) {
    if (picked[0]!.y - above[i]!.y > gap) break;
    picked.unshift(above[i]!);
  }
  // The caption becomes an `![alt](asset:…)` alt text: no brackets, one line.
  const text = picked
    .map((l) => (l.plain ?? l.text))
    .join(" ")
    .replace(/[[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text.slice(0, MAX_CAPTION_CHARS) : undefined;
}

/** A line shorter than this is a label (an axis title letter, a point
 * name), not question text, for the beside test. */
const MIN_BESIDE_LINE_CHARS = 12;

/**
 * Import fixes slice 1: a figure is beside text when a line of real text at
 * its height starts to its left, clear of its labels (a question in the left
 * column, the figure in the right). Exported for tests; pure.
 */
export function isBesideText(lines: readonly TextLine[], box: Box): boolean {
  return lines.some(
    (l) =>
      l.y >= box[1] &&
      l.y <= box[3] &&
      (l.x ?? 0) < box[0] - FIGURE_LABEL_PAD_PT &&
      (l.plain ?? l.text).trim().length >= MIN_BESIDE_LINE_CHARS,
  );
}

/**
 * Import fixes slice 1: drop short runs sitting on or just outside a vector
 * drawing — its point labels — so they stop riding on the question line
 * beside it (a question line ending in "… R A"). Exported for tests; pure.
 */
export function isFigureLabel(run: { x: number; y: number; str: string }, boxes: readonly Box[]): boolean {
  if (run.str.trim().length > MAX_LABEL_CHARS) return false;
  const pad = FIGURE_LABEL_PAD_PT;
  return boxes.some(
    (b) => run.x >= b[0] - pad && run.x <= b[2] + pad && run.y >= b[1] - pad && run.y <= b[3] + pad,
  );
}

/** A line at least this long inside a drawing is prose, not a label. */
const PROSE_LINE_CHARS = 30;
/** This many prose lines inside a drawing make it a text box, not a figure.
 * Review on #102: two was enough for a chart with two long legend or
 * category labels inside its box to lose its picture; the text panels in
 * the samples hold 5–30 such lines. */
export const TEXT_PANEL_PROSE_LINES = 3;

/**
 * Import fixes (2026-10-25): a shaded box, a bordered instructions panel or
 * a table of sentences is drawn with paths too, and clustered as a "figure"
 * — its text was cropped into a picture and dropped from what the model
 * reads. A chart carries short labels; two or more lines of prose inside
 * the box mean it is page layout, and its text stays text. Exported for
 * tests; pure.
 */
export function isTextPanel(lines: readonly TextLine[], box: Box): boolean {
  let prose = 0;
  for (const l of lines) {
    const x = l.x ?? 0;
    if (x < box[0] || x > box[2] || l.y < box[1] || l.y > box[3]) continue;
    if ((l.plain ?? l.text).trim().length >= PROSE_LINE_CHARS) prose += 1;
    if (prose >= TEXT_PANEL_PROSE_LINES) return true;
  }
  return false;
}

/** A ruled area: at least this share of its painted paths are thin rules. */
const RULED_SHARE = 0.8;
/** A rule is thinner than this on one side (points). */
const RULE_PT = 2;
/** Fewer rules than this is a box or an underline, not a grid or table. */
const MIN_RULES = 8;

/** `b` lies within `outer` (1 pt of slack). */
const insideBox = (b: Box, outer: Box): boolean =>
  b[0] >= outer[0] - 1 && b[2] <= outer[2] + 1 && b[1] >= outer[1] - 1 && b[3] <= outer[3] + 1;

/** Distinct positions, merged within RULE_PT. */
function positions(values: number[]): number[] {
  const out: number[] = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    if (out.length === 0 || v - out[out.length - 1]! > RULE_PT) out.push(v);
  }
  return out;
}

/**
 * PDF-import fixes (2026-10-25): a vector drawing that is a blank answer
 * area — a graph grid, or a table whose cells the student fills. Measured on
 * the samples: grids, tables and ruled boxes are 85–100% thin rules, charts
 * and diagrams 0–27%. Among ruled areas, a filled data table has text in
 * most of its cells, an answer table in a few (its row and column labels)
 * and a grid in none; under half filled is an answer area. `paths` are the
 * drawing's painted path boxes, `runs` the text runs' baseline starts, both
 * in page space. Exported for tests; pure.
 */
export function isBlankAnswerArea(paths: readonly Box[], runs: readonly { x: number; y: number }[]): boolean {
  const fill = ruledCells(paths, runs);
  return fill !== null && fill.filled * 2 < fill.cells;
}

/**
 * Review on #102: the other half of a ruled area — a table with text in at
 * least half its cells is data, and its text is the content. As a cropped
 * picture its text also left what the model reads (lines inside a vector
 * figure are dropped as chart labels), and a sub-question that leaned on it
 * was lost. It stays text, not a figure. Exported for tests; pure.
 */
export function isFilledTable(paths: readonly Box[], runs: readonly { x: number; y: number }[]): boolean {
  const fill = ruledCells(paths, runs);
  return fill !== null && fill.filled * 2 >= fill.cells;
}

/** A ruled area's cell count and how many hold text; null when the drawing
 * is not ruled (a chart, a diagram) or has no grid of rules. */
function ruledCells(
  paths: readonly Box[],
  runs: readonly { x: number; y: number }[],
): { cells: number; filled: number } | null {
  const thin = paths.filter((b) => b[2] - b[0] < RULE_PT || b[3] - b[1] < RULE_PT);
  if (thin.length < MIN_RULES || thin.length < paths.length * RULED_SHARE) return null;
  const rows = positions(thin.filter((b) => b[3] - b[1] < RULE_PT).map((b) => (b[1] + b[3]) / 2));
  const cols = positions(thin.filter((b) => b[2] - b[0] < RULE_PT).map((b) => (b[0] + b[2]) / 2));
  if (rows.length < 2 || cols.length < 2) return null;
  const filled = new Set<string>();
  for (const r of runs) {
    const ri = rows.findIndex((y, i) => i + 1 < rows.length && r.y > y && r.y <= rows[i + 1]! + RULE_PT);
    const ci = cols.findIndex((x, i) => i + 1 < cols.length && r.x >= x - RULE_PT && r.x < cols[i + 1]!);
    if (ri >= 0 && ci >= 0) filled.add(`${ri}:${ci}`);
  }
  return { cells: (rows.length - 1) * (cols.length - 1), filled: filled.size };
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
  drop: (run: { x: number; y: number; str: string }) => boolean = () => false,
): TextLine[] {
  const runs = items
    .filter((it) => it.str && it.str.trim().length > 0)
    .map((it) => {
      const [x, y] = apply(base, it.transform[4] ?? 0, it.transform[5] ?? 0);
      return { x, y, str: it.str, style: styleOf(it.fontName) };
    })
    .filter((r) => !drop(r))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const mark = emphasisMarks(runs);
  const lines: { y: number; parts: { x: number; str: string; style: RunStyle }[] }[] = [];
  for (const r of runs) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - r.y) <= 2.5) last.parts.push({ x: r.x, str: r.str, style: r.style });
    else lines.push({ y: r.y, parts: [{ x: r.x, str: r.str, style: r.style }] });
  }
  return lines.map((l) => {
    const parts = l.parts.sort((a, b) => a.x - b.x);
    const filled = parts.filter((p) => p.str.trim().length > 0);
    return {
      y: l.y,
      text: emphasizeRuns(parts, mark),
      x: parts[0]?.x ?? 0,
      // Slice 5: the RAW style, not the page's majority-guarded mark — a
      // caption is found by how the line is set, not by how it is written out.
      bold: filled.length > 0 && filled.every((p) => p.style.bold),
      plain: emphasizeRuns(parts, { bold: false, italic: false }),
    };
  });
}

export interface FigureLimits {
  maxFigureBytes: number;
  maxTotalBytes: number;
  maxFigures: number;
  /** Slice 5: how `@napi-rs/canvas` is loaded. Left out in production (the
   * real package); a test passes one that throws to prove the guard. */
  canvasImport?: CanvasImport;
}
export const DEFAULT_FIGURE_LIMITS: FigureLimits = {
  maxFigureBytes: MAX_FIGURE_BYTES,
  maxTotalBytes: MAX_FIGURES_TOTAL_BYTES,
  maxFigures: MAX_FIGURES,
};

type CanvasModule = Awaited<ReturnType<CanvasImport>>;
type PageImage = Awaited<ReturnType<CanvasModule["loadImage"]>>;

/**
 * Slice 5: cut one cluster out of the rendered page. The box is page-space
 * points; the rendered image is VECTOR_RENDER_SCALE times that, and
 * VECTOR_CROP_PAD_PT of margin is kept so a chart's outermost stroke is not
 * clipped. Returns null when the crop is empty or the canvas throws.
 */
function cropFromPage(
  canvas: CanvasModule,
  image: PageImage,
  box: Box,
): { png: Buffer; width: number; height: number } | null {
  const s = VECTOR_RENDER_SCALE;
  const pad = VECTOR_CROP_PAD_PT;
  const x0 = Math.max(0, Math.round((box[0] - pad) * s));
  const y0 = Math.max(0, Math.round((box[1] - pad) * s));
  const x1 = Math.min(image.width, Math.round((box[2] + pad) * s));
  const y1 = Math.min(image.height, Math.round((box[3] + pad) * s));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return null;
  try {
    const cv = canvas.createCanvas(width, height);
    cv.getContext("2d").drawImage(image, x0, y0, width, height, 0, 0, width, height);
    return { png: cv.toBuffer("image/png"), width, height };
  } catch {
    return null;
  }
}

export async function extractPdfLayout(
  bytes: Uint8Array,
  limits: FigureLimits = DEFAULT_FIGURE_LIMITS,
): Promise<PdfLayout> {
  const pdfjs = (await getResolvedPDFJS()) as { OPS: Record<string, number> };
  const OPS = pdfjs.OPS;
  // Slice 5: which `constructPath` painting operators actually put ink on the
  // page. Resolved through OPS by NAME — the numeric ids are pdf.js build
  // detail. `endPath` and `clip` construct a path and paint nothing.
  const PAINT_OPS = new Set(
    [
      "stroke",
      "closeStroke",
      "fill",
      "eoFill",
      "fillStroke",
      "eoFillStroke",
      "closeFillStroke",
      "closeEOFillStroke",
    ]
      .map((name) => OPS[name])
      .filter((id): id is number => typeof id === "number"),
  );
  const FILL_ONLY_OPS = new Set(
    ["fill", "eoFill"].map((name) => OPS[name]).filter((id): id is number => typeof id === "number"),
  );
  // pdfjs transfers the buffer it is handed (see extractText.ts) — copy.
  const doc = await getDocumentProxy(bytes.slice());
  const figures: PdfFigure[] = [];
  const pageTexts: string[] = [];
  let totalBytes = 0;
  let n = 0;

  // Slice 5: the canvas is loaded once, lazily, and only for a page that has
  // a cluster. A failure here (a missing native binary in some runtime) drops
  // vector figures and nothing else — the raster walk and the text still come
  // back, because a figure must never cost the teacher the import.
  const canvasImport = limits.canvasImport ?? defaultCanvasImport;
  let canvas: CanvasModule | null = null;
  let canvasFailed = false;
  const loadCanvas = async (): Promise<CanvasModule | null> => {
    if (canvas || canvasFailed) return canvas;
    try {
      canvas = await canvasImport();
    } catch (err) {
      canvasFailed = true;
      console.warn(
        "pdf-import: vector figures unavailable (@napi-rs/canvas did not load)",
        err instanceof Error ? err.message : err,
      );
    }
    return canvas;
  };
  // The page is rendered from a second copy of the document opened with
  // unpdf's canvas factory, once per import. Rendering `doc` itself handed
  // pdf.js its built-in Node factory — a stub that throws "@napi-rs/canvas is
  // not available in this environment" — for any scratch canvas (transparency
  // groups, soft masks, patterns), so a map page lost its figures (beta
  // report 2026-10-08).
  type RenderDoc = Awaited<ReturnType<typeof getDocumentProxy>>;
  let renderDoc: RenderDoc | null = null;
  const loadRenderDoc = async (): Promise<RenderDoc> => {
    if (!renderDoc) {
      const CanvasFactory = await createIsomorphicCanvasFactory(canvasImport);
      renderDoc = await getDocumentProxy(bytes.slice(), { CanvasFactory });
    }
    return renderDoc;
  };

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const base = viewport.transform as M;
    const ops = await page.getOperatorList();
    const stack: M[] = [];
    // Import fixes (2026-10-25): the fill colour, saved and restored with the
    // CTM. Google Docs exports paint a white rectangle behind each run of
    // text; on white paper they are invisible, but they clustered into one
    // page-wide "figure" that was cropped — text, chart and all — and shown
    // to students on top of the same text and the real chart.
    const fillStack: string[] = [];
    let fill = "#000000";
    let ctm: M = base;
    const paints: Paint[] = [];
    // Slice 5: every painted path's page-space box, for clustering below.
    const pathBoxes: Box[] = [];
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
      if (fn === OPS.save) {
        stack.push(ctm);
        fillStack.push(fill);
      } else if (fn === OPS.restore) {
        ctm = stack.pop() ?? ctm;
        fill = fillStack.pop() ?? fill;
      } else if (fn === OPS.setFillRGBColor && typeof args[0] === "string") fill = args[0].toLowerCase();
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
      } else if (fn === OPS.constructPath) {
        // Slice 5, measured on the pilot document: the args are
        // [paintOp, [pathData], minMax], and minMax is the path's own
        // [minX, minY, maxX, maxY] in CURRENT USER SPACE — the same space an
        // image paint's unit square is in — so the walk's CTM (which starts at
        // the viewport transform) maps it straight to top-left page space.
        // minMax arrives as a typed array, so length is the check, not isArray.
        const paintOp = args[0];
        if (typeof paintOp !== "number" || !PAINT_OPS.has(paintOp)) continue;
        if (FILL_ONLY_OPS.has(paintOp) && fill === "#ffffff") continue;
        const mm = args[2] as ArrayLike<number> | undefined;
        if (!mm || mm.length !== 4) continue;
        // All four corners, so a rotated CTM still gives the right box.
        const cs = [
          apply(ctm, mm[0]!, mm[1]!),
          apply(ctm, mm[2]!, mm[1]!),
          apply(ctm, mm[0]!, mm[3]!),
          apply(ctm, mm[2]!, mm[3]!),
        ];
        const cx = cs.map((q) => q[0]);
        const cy = cs.map((q) => q[1]);
        const box: Box = [Math.min(...cx), Math.min(...cy), Math.max(...cx), Math.max(...cy)];
        // A rect the size of the page is the background or a full-page clip.
        if (
          box[2] - box[0] >= viewport.width * PAGE_COVER_RATIO &&
          box[3] - box[1] >= viewport.height * PAGE_COVER_RATIO
        ) {
          continue;
        }
        pathBoxes.push(box);
      }
    }

    const sized = paints
      .filter((pt) => pt.bbox[2] - pt.bbox[0] > MIN_FIGURE_PT && pt.bbox[3] - pt.bbox[1] > MIN_FIGURE_PT)
      .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);

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
    const items = content.items as { str: string; transform: number[]; fontName?: string }[];
    const runStarts = items
      .filter((it) => it.str?.trim())
      .map((it) => {
        const [x, y] = apply(base, it.transform[4] ?? 0, it.transform[5] ?? 0);
        return { x, y };
      });
    const lines = linesOf(items, base, styleOf);

    // Slice 5: painted paths close together are one drawing; a drawing big
    // enough and with enough paths in it is a chart.
    let clusters: PathCluster[] = [];
    if (pathBoxes.length > 0 && !canvasFailed) {
      if (pathBoxes.length > MAX_PATHS_PER_PAGE) {
        console.warn(`pdf-import: page ${p} has ${pathBoxes.length} painted paths; vector figures skipped`);
      } else {
        clusters = clusterPathBoxes(pathBoxes).filter(
          (c) =>
            c.paths >= MIN_CLUSTER_PATHS &&
            c.box[2] - c.box[0] > MIN_FIGURE_PT &&
            c.box[3] - c.box[1] > MIN_FIGURE_PT &&
            !isTextPanel(lines, c.box) &&
            !isFilledTable(pathBoxes.filter((b) => insideBox(b, c.box)), runStarts),
        );
      }
    }
    // The page is rendered once, only when it has a cluster to crop out of it.
    let pageImage: PageImage | null = null;
    if (clusters.length > 0) {
      const cv = await loadCanvas();
      if (cv) {
        try {
          const rendered = await renderPageAsImage(await loadRenderDoc(), p, {
            canvasImport,
            scale: VECTOR_RENDER_SCALE,
          });
          pageImage = await cv.loadImage(Buffer.from(rendered));
        } catch (err) {
          console.warn(
            `pdf-import: page ${p} could not be rendered for vector figures`,
            err instanceof Error ? err.message : err,
          );
          pageImage = null;
        }
      }
      if (!pageImage) clusters = [];
    }

    let images: { key: string; width: number; height: number; channels: number; data: Uint8ClampedArray }[] = [];
    if (sized.length > 0) {
      try {
        images = (await extractImages(doc, p)) as typeof images;
      } catch {
        images = [];
      }
    }
    const byKey = new Map(images.map((im) => [String(im.key), im]));
    // Slice 5: raster paints and vector clusters are numbered together, in
    // document order (page, then top-to-bottom).
    const pending: ({ kind: "raster"; box: Box; paint: Paint } | { kind: "vector"; box: Box })[] = [
      ...sized.map((pt) => ({ kind: "raster" as const, box: pt.bbox as Box, paint: pt })),
      ...clusters.map((c) => ({ kind: "vector" as const, box: c.box })),
    ].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);

    const pageFigures: { n: number; top: number }[] = [];
    /** Vector figures own the text drawn inside them (axis labels, legends). */
    const figureBoxes: Box[] = [];
    for (const entry of pending) {
      if (n >= limits.maxFigures) break;
      n += 1;
      const fig: PdfFigure = {
        n,
        page: p,
        bbox: entry.box.map((v) => Math.round(v * 10) / 10) as PdfFigure["bbox"],
        width_px: 0,
        height_px: 0,
        data_url: null,
        bytes: 0,
        source: entry.kind,
      };
      let png: Buffer | null = null;
      if (entry.kind === "raster") {
        const im = byKey.get(entry.paint.name);
        fig.width_px = im?.width ?? 0;
        fig.height_px = im?.height ?? 0;
        if (im && im.data && (im.channels === 1 || im.channels === 2 || im.channels === 3 || im.channels === 4)) {
          try {
            png = encodePng(im.width, im.height, im.channels, im.data);
          } catch {
            png = null;
          }
        }
      } else {
        const caption = captionAbove(lines, entry.box[1]);
        if (isBlankAnswerArea(pathBoxes.filter((b) => insideBox(b, entry.box)), runStarts)) fig.answer_area = true;
        if (caption) fig.caption = caption;
        figureBoxes.push(entry.box);
        const crop = cropFromPage(canvas!, pageImage!, entry.box);
        if (crop) {
          png = crop.png;
          fig.width_px = crop.width;
          fig.height_px = crop.height;
        }
      }
      if (!png) fig.omitted = "no_pixels";
      else if (png.length > limits.maxFigureBytes) fig.omitted = "too_large";
      else if (totalBytes + png.length > limits.maxTotalBytes) fig.omitted = "budget";
      else {
        totalBytes += png.length;
        fig.bytes = png.length;
        fig.data_url = `data:image/png;base64,${png.toString("base64")}`;
      }
      // Slice 1: a figure beside its question is marked at its middle, so
      // the marker (and the model) reads inside that question.
      const beside = isBesideText(lines, entry.box);
      if (beside) fig.beside = true;
      figures.push(fig);
      pageFigures.push({ n, top: beside ? (entry.box[1] + entry.box[3]) / 2 : entry.box[1] });
    }

    // Slice 5: a text line whose baseline sits inside a vector figure is part
    // of the picture (axis values, tick labels, a legend) — it leaves the page
    // text so a source stops carrying chart noise. The caption line is above
    // the cluster and stays.
    // Import fixes slice 1: and its point labels leave the lines beside it.
    const kept =
      figureBoxes.length === 0
        ? lines
        : linesOf(items, base, styleOf, (r) => isFigureLabel(r, figureBoxes)).filter(
            (l) =>
              !figureBoxes.some(
                (b) => (l.x ?? 0) >= b[0] && (l.x ?? 0) <= b[2] && l.y >= b[1] && l.y <= b[3],
              ),
          );
    pageTexts.push(interleaveMarkers(kept, pageFigures));
  }

  await (renderDoc as RenderDoc | null)?.destroy();
  return { pageCount: doc.numPages, textWithMarkers: pageTexts.join("\n\n"), figures };
}

// --- PDF-import slice 3 (2026-10-25): the pages themselves, for the model ---
// On the text path the model read only the page text with figure markers, so
// it could not see which figure sits beside which question, which answer
// lines an answer key has already filled in, or that a question is a drawing.
// The pages ride the extraction call as images; the text stays the source of
// every word.

/** Pages beyond this send no images at all (the text path runs as before). */
export const PAGE_IMAGE_MAX_PAGES = 20;
/** Claude reads an image at about this many pixels; larger is resized down. */
export const PAGE_IMAGE_PIXELS = 1_150_000;

/** Whether an import sends page images: on unless PDF_IMPORT_PAGE_IMAGES=0
 * (slice 3c, James 2026-10-25); never for a scan, which sends the PDF. */
export function pageImagesWanted(scanned: boolean, env: Record<string, string | undefined> = process.env): boolean {
  return !scanned && env.PDF_IMPORT_PAGE_IMAGES !== "0";
}

/**
 * Every page as a PNG near PAGE_IMAGE_PIXELS, or null when the document has
 * more than `maxPages` pages or a page cannot be rendered — the caller then
 * extracts from the text alone, as before. Never throws.
 */
export async function renderPagesForModel(
  bytes: Uint8Array,
  maxPages: number = PAGE_IMAGE_MAX_PAGES,
): Promise<Uint8Array<ArrayBuffer>[] | null> {
  const canvasImport = defaultCanvasImport;
  let doc: Awaited<ReturnType<typeof getDocumentProxy>> | null = null;
  try {
    const CanvasFactory = await createIsomorphicCanvasFactory(canvasImport);
    doc = await getDocumentProxy(bytes.slice(), { CanvasFactory });
    if (doc.numPages > maxPages) return null;
    const pages: Uint8Array<ArrayBuffer>[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const vp = (await doc.getPage(p)).getViewport({ scale: 1 });
      const scale = Math.sqrt(PAGE_IMAGE_PIXELS / (vp.width * vp.height));
      const png = await renderPageAsImage(doc, p, { canvasImport, scale });
      pages.push(new Uint8Array(png));
    }
    return pages;
  } catch (err) {
    console.warn("pdf-import: pages could not be rendered for the model", err instanceof Error ? err.message : err);
    return null;
  } finally {
    await doc?.destroy();
  }
}
