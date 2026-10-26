import {
  REGION_HEAD_PT,
  anchorsFromLines,
  type CandidateRegion,
  type PageSize,
  type QuestionAnchor,
} from "@/lib/pdfImport/regions";

// Editor redesign Phase 7 slice B (R-10, docs/editor-redesign-design.md):
// a Word document (word/document.xml, plus word/numbering.xml for the
// automatic list numbers) read into
//   - blocks: paragraphs and tables with bold / italic, line breaks, list
//     labels, heading levels and picture placeholders — what the import
//     review's left pane draws (DocxSourcePane), as data, never as HTML;
//   - text: the plain text the extractor model reads, with the E6 emphasis
//     markers (**bold**, _italic_) and list numbers written out, so the
//     numbers the model reports are the ones the review can find;
//   - anchors: the numbered paragraphs, for placing each proposal.
// Pure (no node: imports), so the panel can share the types and helpers.
//
// Not read: pictures (counted, shown as a placeholder), text boxes, tracked
// deletions, field codes, footnotes, headers and footers, and numbering that
// comes from a paragraph style rather than the paragraph itself.

export type WordRun = { text: string; bold?: true; italic?: true } | { picture: true };

export interface WordParagraph {
  kind: "paragraph";
  runs: WordRun[];
  /** The automatic list number or bullet, e.g. "1.", "a)", "•". */
  label?: string;
  /** List level, 0 = outermost. */
  level?: number;
  /** 1–6 for a Heading style (Title counts as 1). */
  heading?: number;
}

export interface WordTable {
  kind: "table";
  /** Rows of cells; each cell holds its paragraphs (a nested table's
   * paragraphs are flattened into the cell). */
  rows: WordParagraph[][][];
}

export type WordBlock = WordParagraph | WordTable;

export interface WordDocument {
  blocks: WordBlock[];
  text: string;
  anchors: QuestionAnchor[];
  /** One pseudo-page the anchors are measured on (see WORD_BLOCK_UNIT). */
  pages: PageSize[];
  /** Pictures in the body, none of which is imported. */
  pictures: number;
}

/** Each block is this many "points" tall on the pseudo-page, so
 * locateCandidates (built for PDF pages) places a proposal over whole
 * blocks: a region's top and bottom come back as block index / count. */
export const WORD_BLOCK_UNIT = 100;

// ---- XML ----

const TOKEN_RE =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return "";
    }
  });
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name.replace(".", "\\.")}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? "") : null;
}

/** `<w:b/>` is on; `<w:b w:val="0"/>` (or false / off) is off. */
function toggleOn(attrs: string): boolean {
  const v = attr(attrs, "w:val");
  return v === null || !["0", "false", "off", "none"].includes(v.toLowerCase());
}

interface Token {
  close: boolean;
  name: string;
  attrs: string;
  selfClose: boolean;
  text: string | null;
}

function* tokens(xml: string): Generator<Token> {
  for (const m of xml.matchAll(TOKEN_RE)) {
    if (m[6] !== undefined) yield { close: false, name: "", attrs: "", selfClose: false, text: decodeEntities(m[6]) };
    else if (m[1] !== undefined) yield { close: false, name: "", attrs: "", selfClose: false, text: m[1] };
    else if (m[3] !== undefined) {
      yield { close: m[2] === "/", name: m[3], attrs: m[4] ?? "", selfClose: m[5] === "/", text: null };
    }
  }
}

// ---- Numbering ----

interface LevelDef {
  start: number;
  fmt: string;
  text: string;
}

export interface Numbering {
  /** numId → its abstract list, and the levels it restarts. */
  nums: Map<string, { abstractId: string; startOverrides: Map<number, number> }>;
  /** abstractNumId → level → definition. */
  abstracts: Map<string, Map<number, LevelDef>>;
}

export function parseNumbering(xml: string | null): Numbering {
  const nums: Numbering["nums"] = new Map();
  const abstracts: Numbering["abstracts"] = new Map();
  if (!xml) return { nums, abstracts };
  let abs: Map<number, LevelDef> | null = null;
  let lvl: LevelDef | null = null;
  let num: { abstractId: string; startOverrides: Map<number, number> } | null = null;
  let overrideLvl: number | null = null;
  for (const t of tokens(xml)) {
    if (t.text !== null) continue;
    if (t.close) {
      if (t.name === "w:abstractNum") abs = null;
      else if (t.name === "w:lvl") lvl = null;
      else if (t.name === "w:num") num = null;
      else if (t.name === "w:lvlOverride") overrideLvl = null;
      continue;
    }
    if (t.name === "w:abstractNum") {
      abs = new Map();
      abstracts.set(attr(t.attrs, "w:abstractNumId") ?? "", abs);
    } else if (t.name === "w:lvl" && abs && !num) {
      lvl = { start: 1, fmt: "decimal", text: "" };
      abs.set(Number(attr(t.attrs, "w:ilvl") ?? 0), lvl);
    } else if (lvl && t.name === "w:start") lvl.start = Number(attr(t.attrs, "w:val") ?? 1);
    else if (lvl && t.name === "w:numFmt") lvl.fmt = attr(t.attrs, "w:val") ?? "decimal";
    else if (lvl && t.name === "w:lvlText") lvl.text = attr(t.attrs, "w:val") ?? "";
    else if (t.name === "w:num") {
      num = { abstractId: "", startOverrides: new Map() };
      nums.set(attr(t.attrs, "w:numId") ?? "", num);
    } else if (num && t.name === "w:abstractNumId") num.abstractId = attr(t.attrs, "w:val") ?? "";
    else if (num && t.name === "w:lvlOverride") overrideLvl = Number(attr(t.attrs, "w:ilvl") ?? 0);
    else if (num && overrideLvl !== null && t.name === "w:startOverride") {
      num.startOverrides.set(overrideLvl, Number(attr(t.attrs, "w:val") ?? 1));
    }
  }
  return { nums, abstracts };
}

function letters(n: number): string {
  // Word's letter numbering repeats the letter: a … z, aa … zz.
  if (n < 1) return String(n);
  const ch = String.fromCharCode(97 + ((n - 1) % 26));
  return ch.repeat(Math.floor((n - 1) / 26) + 1);
}

function roman(n: number): string {
  if (n < 1 || n > 3999) return String(n);
  const table: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

export function formatListNumber(n: number, fmt: string): string {
  switch (fmt) {
    case "lowerLetter": return letters(n);
    case "upperLetter": return letters(n).toUpperCase();
    case "lowerRoman": return roman(n);
    case "upperRoman": return roman(n).toUpperCase();
    case "decimalZero": return n < 10 ? `0${n}` : String(n);
    case "none": return "";
    default: return String(n);
  }
}

/** Hands out each numbered paragraph's label, in document order. Counters
 * belong to the abstract list, so two w:num instances of one list continue
 * each other unless one restarts a level (Word's "Restart at 1"). */
export function listLabeller(numbering: Numbering) {
  const counters = new Map<string, (number | undefined)[]>();
  const restarted = new Set<string>();
  return (numId: string, ilvl: number): string | undefined => {
    const num = numbering.nums.get(numId);
    const levels = num ? numbering.abstracts.get(num.abstractId) : undefined;
    const def = levels?.get(ilvl);
    if (!num || !levels || !def) return undefined;
    const c = counters.get(num.abstractId) ?? [];
    counters.set(num.abstractId, c);
    if (!restarted.has(numId)) {
      restarted.add(numId);
      for (const [l, s] of num.startOverrides) c[l] = s - 1;
    }
    c[ilvl] = (c[ilvl] ?? def.start - 1) + 1;
    for (let l = ilvl + 1; l < 9; l++) c[l] = undefined;
    if (def.fmt === "bullet") return "•";
    return def.text.replace(/%([1-9])/g, (_, d: string) => {
      const l = Number(d) - 1;
      const ld = levels.get(l);
      return formatListNumber(c[l] ?? ld?.start ?? 1, ld?.fmt ?? "decimal");
    });
  };
}

// ---- document.xml ----

/** Whose content is never read. A picture element also counts a picture. */
const SKIPPED = new Set(["w:del", "w:instrText", "mc:Fallback", "w:footnoteReference", "w:endnoteReference"]);
const PICTURES = new Set(["w:drawing", "w:pict", "w:object"]);

function headingLevel(style: string | null): number | undefined {
  if (!style) return undefined;
  if (/^title$/i.test(style)) return 1;
  const m = /^heading\s*([1-6])$/i.exec(style);
  return m ? Number(m[1]) : undefined;
}

export function parseWordDocument(documentXml: string, numberingXml: string | null = null): WordDocument {
  const label = listLabeller(parseNumbering(numberingXml));
  const blocks: WordBlock[] = [];
  let pictures = 0;
  let skipName: string | null = null;
  let skipNest = 0;
  let para: WordParagraph | null = null;
  let numId: string | null = null;
  let ilvl = 0;
  let style: string | null = null;
  let inPPr = false;
  let inRPr = false;
  let inT = false;
  let bold = false;
  let italic = false;
  let tableDepth = 0;
  let table: WordTable | null = null;
  let row: WordParagraph[][] | null = null;
  let cell: WordParagraph[] | null = null;

  const append = (text: string) => {
    if (!para || text === "") return;
    const last = para.runs[para.runs.length - 1];
    if (last && "text" in last && !!last.bold === bold && !!last.italic === italic) {
      last.text += text;
      return;
    }
    para.runs.push({ text, ...(bold ? { bold: true as const } : {}), ...(italic ? { italic: true as const } : {}) });
  };
  const endParagraph = () => {
    if (!para) return;
    if (numId && numId !== "0") {
      const l = label(numId, ilvl);
      if (l !== undefined && l !== "") {
        para.label = l;
        para.level = ilvl;
      }
    }
    const h = headingLevel(style);
    if (h) para.heading = h;
    if (cell) cell.push(para);
    else blocks.push(para);
    para = null;
  };

  for (const t of tokens(documentXml)) {
    if (skipName) {
      if (t.text === null && t.name === skipName && !t.selfClose) skipNest += t.close ? -1 : 1;
      if (skipNest === 0) skipName = null;
      continue;
    }
    if (t.text !== null) {
      if (inT) append(t.text);
      continue;
    }
    const { name } = t;
    if (!t.close && (SKIPPED.has(name) || PICTURES.has(name))) {
      if (PICTURES.has(name) && para) {
        para.runs.push({ picture: true });
        pictures++;
      }
      if (!t.selfClose) {
        skipName = name;
        skipNest = 1;
      }
      continue;
    }
    if (t.close) {
      if (name === "w:p") endParagraph();
      else if (name === "w:pPr") inPPr = false;
      else if (name === "w:rPr") inRPr = false;
      else if (name === "w:t") inT = false;
      else if (name === "w:tc" && tableDepth === 1) {
        if (cell && row) row.push(cell);
        cell = null;
      } else if (name === "w:tr" && tableDepth === 1) {
        if (row && table) table.rows.push(row);
        row = null;
      } else if (name === "w:tbl") {
        tableDepth--;
        if (tableDepth === 0 && table) {
          blocks.push(table);
          table = null;
        }
      }
      continue;
    }
    switch (name) {
      case "w:p":
        para = { kind: "paragraph", runs: [] };
        numId = null;
        ilvl = 0;
        style = null;
        if (t.selfClose) endParagraph();
        break;
      case "w:pPr":
        if (!t.selfClose) inPPr = true;
        break;
      case "w:pStyle":
        if (inPPr) style = attr(t.attrs, "w:val");
        break;
      case "w:numId":
        if (inPPr) numId = attr(t.attrs, "w:val");
        break;
      case "w:ilvl":
        if (inPPr) ilvl = Number(attr(t.attrs, "w:val") ?? 0) || 0;
        break;
      case "w:r":
        bold = false;
        italic = false;
        break;
      case "w:rPr":
        if (!t.selfClose && !inPPr) inRPr = true;
        break;
      case "w:b":
        if (inRPr) bold = toggleOn(t.attrs);
        break;
      case "w:i":
        if (inRPr) italic = toggleOn(t.attrs);
        break;
      case "w:t":
        if (!t.selfClose) inT = true;
        break;
      case "w:tab":
        // A w:tab inside w:pPr is a tab stop, not a character.
        if (!inPPr) append("\t");
        break;
      case "w:br":
      case "w:cr":
        if (!inPPr) append("\n");
        break;
      case "w:noBreakHyphen":
        append("-");
        break;
      case "w:tbl":
        tableDepth++;
        if (tableDepth === 1) table = { kind: "table", rows: [] };
        break;
      case "w:tr":
        if (tableDepth === 1) row = [];
        break;
      case "w:tc":
        if (tableDepth === 1) cell = [];
        break;
    }
  }
  if (para) endParagraph();

  const text = blocks.map(blockText).join("\n");
  const lines = blocks.flatMap((b, i) =>
    b.kind === "paragraph" ? [{ y: i * WORD_BLOCK_UNIT + REGION_HEAD_PT, text: paragraphText(b).split("\n")[0]! }] : [],
  );
  return {
    blocks,
    text,
    anchors: anchorsFromLines(lines, 1),
    pages: [{ width: 1, height: Math.max(1, blocks.length) * WORD_BLOCK_UNIT }],
    pictures,
  };
}

// ---- Text for the model ----

/** One run's text with its E6 emphasis markers, line by line, the
 * whitespace kept outside the markers. */
function emphasised(text: string, b: boolean, i: boolean): string {
  if (!b && !i) return text;
  return text
    .split("\n")
    .map((line) => {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(line)!;
      if (m[2] === "") return line;
      let core = m[2]!;
      if (i) core = `_${core}_`;
      if (b) core = `**${core}**`;
      return `${m[1]}${core}${m[3]}`;
    })
    .join("\n");
}

export function paragraphText(p: WordParagraph): string {
  const body = p.runs
    .map((r) => ("picture" in r ? "" : emphasised(r.text, !!r.bold, !!r.italic)))
    .join("");
  return p.label ? `${p.label} ${body}` : body;
}

export function blockText(b: WordBlock): string {
  if (b.kind === "paragraph") return paragraphText(b);
  return b.rows
    .map((cells) => cells.map((ps) => ps.map(paragraphText).join(" ").trim()).join(" | "))
    .join("\n");
}

/** The blocks a located proposal covers, [start, end), or null for one
 * placed by order (no position). */
export function regionBlockRange(
  region: CandidateRegion,
  blockCount: number,
): { start: number; end: number } | null {
  if (region.top === null || region.bottom === null || blockCount <= 0) return null;
  const start = Math.min(blockCount - 1, Math.max(0, Math.round(region.top * blockCount)));
  const end = Math.min(blockCount, Math.max(start + 1, Math.round(region.bottom * blockCount)));
  return { start, end };
}

/** The review pane's outlined groups: a run of blocks and the regions that
 * start there. A group ends where the next one starts, so groups never
 * nest; a region placed by order is in no group. */
export function docxGroups<R extends { region: CandidateRegion }>(
  regions: readonly R[],
  blockCount: number,
): { start: number; end: number; regions: R[] }[] {
  const byStart = new Map<number, { end: number; regions: R[] }>();
  for (const r of regions) {
    const range = regionBlockRange(r.region, blockCount);
    if (!range) continue;
    const g = byStart.get(range.start) ?? { end: range.end, regions: [] };
    g.end = Math.max(g.end, range.end);
    g.regions.push(r);
    byStart.set(range.start, g);
  }
  const starts = [...byStart.keys()].sort((a, b) => a - b);
  return starts.map((start, i) => {
    const g = byStart.get(start)!;
    const next = starts[i + 1];
    return { start, end: next === undefined ? g.end : Math.min(g.end, next), regions: g.regions };
  });
}
