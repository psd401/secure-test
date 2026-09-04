import { CreateItemBody } from "@/lib/api/items";

// Shared between the mock and Bedrock PDF extractors + the route.

// Output cap for one extraction call. 4000 was enough for 2–7 page quizzes
// but a 13-page exam (WH_S1_ERAS, 2026-09-01) overran it: the model's JSON
// array was cut off mid-item and parsed as "invalid JSON". Raised 4× so a
// full-length exam fits; a genuine overrun now surfaces as
// PdfExtractError("truncated") instead of a 500.
export const PDF_EXTRACT_MAX_TOKENS = 16000;

// Typed failure from the extraction pipeline so the route can answer with a
// structured, teacher-readable error instead of letting the throw escape as
// an empty-body 500 (which the panel then rendered as a raw TypeError).
export type PdfExtractErrorCode = "truncated" | "invalid_json" | "not_array";
export class PdfExtractError extends Error {
  readonly code: PdfExtractErrorCode;
  constructor(code: PdfExtractErrorCode, message: string) {
    super(message);
    this.name = "PdfExtractError";
    this.code = code;
  }
}

// Cap on candidates surfaced from one PDF — keeps a huge document from
// producing an unreviewable wall of items. Reported when hit so nothing is
// silently dropped.
export const MAX_PDF_CANDIDATES = 100;

// Shapes + rules the model is offered. E1/E2/E4/E7a/E8 (2026-09-01 sample
// run, docs/pdf-import-enhancements.md) added match, drawing_upload, the
// show-your-work split (typed work = essay, James 2026-09-01: a trackpad
// canvas is the wrong tool for a chi-square computation; drawing only for
// graphs and figures), KaTeX-in-text and the printed question number.
// `source_number` is read off the raw candidate (readSourceNumbers) and
// then stripped by CreateItemBody — it never reaches an item row.
export const PDF_EXTRACT_SYSTEM_PROMPT = [
  "You extract assessment items from the text of a test document.",
  "Return ONLY a JSON array (no markdown fences) of item objects. Each",
  "object matches one of these shapes:",
  '{"type":"multiple_choice_single","stem":"...","choices":[{"id":"a","text":"..."}],"correct_choice_ids":["a"]}',
  '{"type":"multiple_choice_multi","stem":"...","choices":[...],"correct_choice_ids":["a","b"]}',
  '{"type":"short_text","stem":"...","correct_answer":"..."}',
  '{"type":"essay","stem":"..."}',
  '{"type":"match","stem":"...","pairs":[{"left":"...","right":"..."}]}',
  '{"type":"drawing_upload","stem":"..."}',
  '{"type":"table","stem":"...","columns":["..."],"rows":["..."],"corner":"..."}',
  'Every object may also carry "source_number": the question number as',
  "printed in the document, as an integer; omit it when the question is not",
  'numbered. An item that covers several numbered rows (a match set built',
  'from questions 1-5) carries "source_numbers": [1,2,3,4,5] instead.',
  "Rules: use the answer key if the document provides one, otherwise omit",
  "correct_choice_ids / correct_answer. Preserve the question wording. Do",
  "not invent questions that are not in the text. Choice ids are short",
  "letters (a, b, c...). Return [] if you find no items.",
  "Use match when several terms or statements are each paired with exactly",
  "one entry from a bank (column A / column B, a lettered statement bank",
  "matched to numbered terms): ONE match item for the whole set, left = the",
  "term or statement being matched, right = its correct partner from the",
  "bank; never one multiple-choice item per row.",
  "Use drawing_upload when the student is asked to draw, sketch, graph,",
  "plot, label or construct a diagram, or otherwise produce a figure.",
  'When a question says "show your work" (or "show your steps"), emit',
  "essay for the work itself (the student types the steps); if the document",
  "also gives that question's final answer, add a second item",
  '{"type":"short_text","stem":"Final answer: <the question>","correct_answer":"..."}',
  "with the same source_number. Use drawing_upload for the work only when",
  "it must be drawn (a graph, a diagram, a construction).",
  "Use table when the document prints a table with EMPTY cells for the",
  "student to fill in (a data table to complete, a calculation grid):",
  "columns = the header row's labels left to right, rows = the first",
  "column's labels top to bottom (an empty string for a row with no label),",
  'corner = the header cell above the row labels when there is one (omit it',
  "otherwise); the stem is the instruction printed before the table. Never",
  "write such a table into a stem as text. A table whose cells are already",
  "filled in is data the questions refer to — a stimulus, not an item.",
  "Write chemical formulas, subscripts, superscripts and math as KaTeX",
  "inside $...$ in stems, choices and pairs (H2O becomes $\\mathrm{H_2O}$,",
  "x squared becomes $x^2$, 3.5 x 10^4 becomes $3.5 \\times 10^{4}$), never",
  "as flat text; table column and row labels take KaTeX the same way.",
  "Leave correct_answer values as plain text.",
  "The text may contain markers like [FIGURE 3] where a figure (a graph,",
  "diagram, table or picture) sits in the document. When one or more",
  "questions depend on a figure, or on a passage or data given before them,",
  'return a JSON OBJECT {"items":[...],"item_sets":[...]} instead of a bare',
  'array. Each item_set is {"stimulus":"the shared passage or data, verbatim,',
  'or an empty string when the figure alone is the stimulus","figures":[3],',
  '"item_indexes":[0,1]} — item_indexes are 0-based positions in the items',
  "array and must be consecutive; figures lists the marker numbers the set",
  "uses (empty when it is a passage). A question belongs to at most one set.",
  "Never put the [FIGURE n] marker text itself into a stem or stimulus.",
  "The text marks the document's own emphasis as **bold** and _italic_.",
  "Keep those markers exactly where they are in stems, choices, pairs and",
  "stimulus text; never add markers the document does not have, and never",
  "put them inside $...$.",
  "Return a bare items array when nothing is shared. Inside JSON strings,",
  'escape double quotes as \\" and backslashes as \\\\.',
].join(" ");

export function buildPdfExtractUserPrompt(text: string): string {
  return `TEST DOCUMENT TEXT:\n\n${text}`;
}

// Scanned path (ADR 0015): the PDF itself is attached as a Converse
// document block; this replaces the extracted-text prompt.
// E14 (2026-09-02, Graphing Skills scan): the shared system prompt describes
// `[FIGURE n]` markers, and on a scan the model invented them for figures it
// could see ("Identify the type of graph: [FIGURE 1]"). The scanned input
// carries none, so say so outright; stripFigureMarkers is the backstop.
// E13 (decision James 2026-09-02): with no figure to attach, the model wrote
// a description of each graph into the stimulus, and on the four "Identify
// the type of graph" items the description named the answer. A stimulus on
// a scan is verbatim printed text only; a set that depended on a figure
// says so with `needs_figure` and the teacher supplies the figure by hand.
export const PDF_OCR_USER_PROMPT =
  "The test document is attached as a PDF. Its pages are scanned images with " +
  "no text layer — read every page visually and extract the assessment items. " +
  "This document contains no [FIGURE n] markers; never write one into a stem " +
  "or stimulus. A stimulus is text printed on the page, copied verbatim (a " +
  "passage, a data table, instructions). Never describe a graph, chart, " +
  "diagram or picture in a stimulus or a stem — a description can give away " +
  "the answer. When questions depend on a figure you can see, return them as " +
  'an item_set with "needs_figure": true and only the printed text (or "") ' +
  "as its stimulus; the teacher adds the figure by hand.";

// Caps for the scanned/OCR branch (ADR 0015, approved 2026-08-13). Pages are
// read as images, which is token-heavy — 30 pages bounds the spend, checked
// before any model call (unpdf reports pageCount even with no text layer).
export const MAX_OCR_PAGES = 30;
// AWS documents 4.5 MB per Converse document, but slice 45's live probes
// showed that limit is not enforced — 10 MiB was accepted. Cap raised to the
// validated 10 MiB (James, 2026-08-13; ADR 0015) so 30-page scans at
// 150-200 dpi fit. Still bounded by the route's 25 MiB MAX_BYTES.
export const MAX_OCR_BYTES = 10 * 1024 * 1024;

// Parse the model's JSON array (tolerating markdown fences) into raw
// candidate objects. Throws PdfExtractError (message keeps errPrefix) on
// non-JSON / non-array; `truncated` (the provider saw stopReason
// max_tokens) turns an unparseable body into code "truncated" so the
// teacher is told to split the document rather than "try again".
export function parsePdfCandidates(
  text: string,
  errPrefix: string,
  opts: { truncated?: boolean } = {},
): unknown[] {
  return parsePdfExtraction(text, errPrefix, opts).candidates;
}

export interface ParsedExtraction {
  candidates: unknown[];
  /** E5 slice 3: the model's proposed item sets, raw (validated later). */
  proposedSets: unknown[];
}

// E5 slice 3: the model may answer with {"items":[…],"item_sets":[…]} when
// questions share a figure or passage; a bare array is still the shape for
// "nothing shared" and every older prompt.
export function parsePdfExtraction(
  text: string,
  errPrefix: string,
  opts: { truncated?: boolean } = {},
): ParsedExtraction {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    // Graphing Skills, 2026-09-01: the model quoted a question inside a stem
    // ("…the question, "How does…") without escaping it — one stray quote
    // and the whole import failed. Repair only what strict JSON can never
    // contain, and only after the strict parse failed.
    try {
      raw = JSON.parse(repairModelJson(cleaned));
    } catch {
      throw new PdfExtractError(
        opts.truncated ? "truncated" : "invalid_json",
        `${errPrefix}: model did not return valid JSON` +
          (opts.truncated ? " (output hit the token cap)" : ""),
      );
    }
  }
  if (Array.isArray(raw)) return { candidates: raw, proposedSets: [] };
  if (raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)) {
    const obj = raw as { items: unknown[]; item_sets?: unknown };
    return {
      candidates: obj.items,
      proposedSets: Array.isArray(obj.item_sets) ? obj.item_sets : [],
    };
  }
  throw new PdfExtractError("not_array", `${errPrefix}: model JSON was not an array`);
}

/**
 * Best-effort repair of two things a model does to otherwise-valid JSON and
 * strict JSON can never legitimately contain:
 * - a backslash that starts no valid escape (`\mathrm` written for KaTeX
 *   without doubling) — doubled;
 * - a double quote inside a string that is not followed by a structural
 *   character (`,` `}` `]` `:`) — a quoted phrase inside a stem — escaped.
 * A content quote that IS followed by a comma (`said "yes", then`) is the
 * known limit: it reads as the string's end and the parse still fails, which
 * surfaces as the same teacher-facing error as before. Exported for tests.
 */
export function repairModelJson(text: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1] ?? "";
      if ('"\\/bfnrtu'.includes(next) && next !== "") {
        out += ch + next;
        i += 1;
      } else {
        out += "\\\\";
      }
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && (text[j] === " " || text[j] === "\n" || text[j] === "\r" || text[j] === "\t")) j++;
      const after = text[j] ?? "";
      if (after === "" || ",}]:".includes(after)) {
        out += ch;
        inStr = false;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

export interface CandidateValidation {
  candidates: ReturnType<typeof CreateItemBody.parse>[];
  rejected: { index: number; errors: string[] }[];
  truncated: boolean;
}

// Fill in what the prompt tells the model to leave out, so CreateItemBody
// (the only validation authority) sees the write shape it expects:
// - keyless multiple choice: the prompt says "omit correct_choice_ids" when
//   the document has no key, but the schema requires the array (empty =
//   keyless, slice B). The Bedrock run of 2026-09-01 rejected every keyless
//   MC with "correct_choice_ids: Required" — the mock always sent [], so
//   the route tests never saw it.
// - E1 match without pair ids (the model is not asked to invent them):
//   p1..pn for ALL pairs, so a half-filled list cannot collide.
// - E14 `[FIGURE n]` text in a stem when NO figure was extracted
//   (figureCount 0 — every scan): the marker can refer to nothing, so it
//   goes; a stem that was only a marker then fails min(1) and is reported,
//   not proposed. With figures present the text-path prompt rule holds and
//   stems are left alone.
// Everything else passes through untouched.
export interface NormalizeOptions {
  /** Figures extracted from the document; 0 turns on the E14 strip. */
  figureCount?: number;
}

// E14 (2026-09-02, Graphing Skills scan): six of eleven stems came back
// ending in a literal `[FIGURE 1]` … `[FIGURE 6]` on the scanned path,
// where the input carries no markers and `figures` is empty — the model
// imitates the marker syntax the system prompt describes for figures it
// can see. The marker and the whitespace before it go; text without a
// marker is returned as is (same string, no trim).
const FIGURE_MARKER_RE = /\s*\[FIGURE \d+\]/g;
export function stripFigureMarkers(text: string): string {
  const stripped = text.replace(FIGURE_MARKER_RE, "");
  return stripped === text ? text : stripped.trim();
}

// E3 slice 4: the Unit 0 chi-square question came back (2026-09-01 Bedrock
// run) as an ESSAY whose stem ended in a Markdown pipe table with an
// all-blank body — the model's way of saying "fill this in" before the type
// existed. A stem that ends in such a table becomes a `table` candidate:
// the header row is the columns, the first body column the row labels (only
// when some row has one; the header cell above it is then the corner), and
// the text before and after the table is the stem. A table whose body has
// text in it is data the question refers to, not a grid to fill — it is left
// alone (a stimulus, by the prompt's own rule). Rows are newline-separated,
// as the model writes them; unpdf's space-joined text never reaches here.
export interface PipeTableGrid {
  stem: string;
  columns: { id: string; label: string }[];
  rows: { id: string; label: string }[];
  corner?: string;
}

const PIPE_ROW_RE = /^\s*\|.*\|\s*$/;
const PIPE_SEPARATOR_RE = /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/;

function splitPipeRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

export function fillableTableFromStem(stem: string): PipeTableGrid | null {
  const lines = stem.split("\n");
  // Find the first run of pipe rows that has a header, a separator and at
  // least one body row.
  for (let start = 0; start < lines.length; start++) {
    if (!PIPE_ROW_RE.test(lines[start]!)) continue;
    if (!(start + 1 < lines.length && PIPE_SEPARATOR_RE.test(lines[start + 1]!))) continue;
    let end = start + 2;
    while (end < lines.length && PIPE_ROW_RE.test(lines[end]!) && !PIPE_SEPARATOR_RE.test(lines[end]!)) end++;
    const header = splitPipeRow(lines[start]!);
    const body = lines.slice(start + 2, end).map(splitPipeRow);
    if (body.length === 0 || header.length === 0) continue;
    const width = header.length;
    const cells = body.map((r) => {
      const padded = r.slice(0, width);
      while (padded.length < width) padded.push("");
      return padded;
    });
    const labelled = cells.some((r) => r[0]!.length > 0);
    const dataFrom = labelled ? 1 : 0;
    // Every data cell must be blank — otherwise this is a data table.
    if (cells.some((r) => r.slice(dataFrom).some((c) => c.length > 0))) return null;
    const columnLabels = header.slice(dataFrom);
    if (columnLabels.length === 0) return null;
    const before = lines.slice(0, start).join("\n").trim();
    const after = lines.slice(end).join("\n").trim();
    const grid: PipeTableGrid = {
      stem: [before, after].filter((t) => t.length > 0).join("\n\n"),
      columns: columnLabels.map((label, i) => ({ id: `c${i + 1}`, label: label || `Column ${i + 1}` })),
      rows: cells.map((r, i) => ({ id: `r${i + 1}`, label: labelled ? r[0]! : "" })),
    };
    if (labelled && header[0]!.length > 0) grid.corner = header[0]!;
    return grid;
  }
  return null;
}

// The model is asked for label lists, not ids (like match pairs): coerce a
// string or an id-less object to {id, label}, c1…/r1… for all so a half-
// filled list cannot collide. Anything else passes through for
// CreateItemBody to reject with its own message.
function coerceGridList(list: unknown, prefix: string): unknown {
  if (!Array.isArray(list)) return list;
  const allHaveIds = list.every(
    (e) => e != null && typeof e === "object" && typeof (e as { id?: unknown }).id === "string" && ((e as { id: string }).id.trim().length > 0),
  );
  if (allHaveIds) return list;
  return list.map((e, i) => {
    if (typeof e === "string") return { id: `${prefix}${i + 1}`, label: e };
    if (e != null && typeof e === "object") return { ...(e as object), id: `${prefix}${i + 1}` };
    return e;
  });
}

export function normalizePdfCandidate(cand: unknown, opts: NormalizeOptions = {}): unknown {
  if (!cand || typeof cand !== "object") return cand;
  let obj = cand as Record<string, unknown>;
  if (opts.figureCount === 0 && typeof obj.stem === "string") {
    const stem = stripFigureMarkers(obj.stem);
    if (stem !== obj.stem) obj = { ...obj, stem };
  }
  // E3 slice 4 backstop: a fill-in table written into an essay / short-text
  // stem as Markdown pipes becomes a table candidate. Fields of the old
  // type (correct_answer, essay metadata) are dropped with it — a grid has
  // no single answer and no word cap.
  if ((obj.type === "essay" || obj.type === "short_text") && typeof obj.stem === "string") {
    const grid = fillableTableFromStem(obj.stem);
    if (grid && grid.stem.length > 0) {
      const { correct_answer: _a, max_word_count: _w, placeholder: _p, rubric: _r, ...rest } = obj;
      obj = { ...rest, type: "table", ...grid };
    }
  }
  if (obj.type === "table") {
    const { corner: rawCorner, ...rest } = obj;
    const columns = coerceGridList(rest.columns, "c");
    const rows = coerceGridList(rest.rows, "r");
    // A blank corner is no corner (the write schema takes an optional string).
    const corner = typeof rawCorner === "string" && rawCorner.trim().length > 0 ? rawCorner.trim() : undefined;
    return { ...rest, columns, rows, ...(corner ? { corner } : {}) };
  }
  if (
    (obj.type === "multiple_choice_single" || obj.type === "multiple_choice_multi") &&
    obj.correct_choice_ids === undefined
  ) {
    return { ...obj, correct_choice_ids: [] };
  }
  if (obj.type !== "match" || !Array.isArray(obj.pairs)) return obj;
  const pairs = obj.pairs as unknown[];
  const allHaveIds = pairs.every(
    (p) =>
      p != null &&
      typeof p === "object" &&
      typeof (p as { id?: unknown }).id === "string" &&
      ((p as { id: string }).id.trim().length > 0),
  );
  if (allHaveIds) return obj;
  return {
    ...obj,
    pairs: pairs.map((p, i) =>
      p != null && typeof p === "object" ? { ...(p as object), id: `p${i + 1}` } : p,
    ),
  };
}

// Validate raw candidates through the ONE write-shape authority
// (CreateItemBody). Invalid candidates are reported by index, never
// returned as usable. Enforces MAX_PDF_CANDIDATES with a truncated flag.
// CreateItemBody strips unknown keys, so `source_number` (E8) does not
// survive into a candidate — read it with readSourceNumbers first.
export function validatePdfCandidates(raw: unknown[], opts: NormalizeOptions = {}): CandidateValidation {
  const truncated = raw.length > MAX_PDF_CANDIDATES;
  const slice = truncated ? raw.slice(0, MAX_PDF_CANDIDATES) : raw;
  const candidates: ReturnType<typeof CreateItemBody.parse>[] = [];
  const rejected: { index: number; errors: string[] }[] = [];
  slice.forEach((cand, index) => {
    const parsed = CreateItemBody.safeParse(normalizePdfCandidate(cand, opts));
    if (parsed.success) {
      candidates.push(parsed.data);
    } else {
      rejected.push({
        index,
        errors: parsed.error.issues.map((iss) => {
          const path = iss.path.join(".");
          return path ? `${path}: ${iss.message}` : iss.message;
        }),
      });
    }
  });
  return { candidates, rejected, truncated };
}

// --- E8: did the extraction cover every numbered question? ---

// Upper bound on the numbering walk; nothing teachers import numbers past
// this, and it keeps a pathological text from producing a huge list.
export const MAX_NUMBERED_ITEMS = 300;

// How far the document's own question numbering runs. The text layer is
// one space-joined blob (no line starts to anchor on), so this scans for
// "N." / "N)" markers preceded by whitespace or "(" and followed by
// whitespace, and walks them in document order: a marker counts when it is
// the next number or the one after (one missing number is tolerated — an
// image-only question can lose its number too). Years ("2024." is four
// digits), "2.5 g" (no space after the dot) and page numbers out of
// sequence never advance the walk. An answer key that restarts at 1 after
// the questions does not lower it.
export function countNumberedItems(text: string): number {
  const re = /(?:^|[\s(])(\d{1,3})[.)](?=\s|$)/g;
  let current = 0;
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    if (n > current && n <= current + 2) {
      current = n;
      if (current >= MAX_NUMBERED_ITEMS) break;
    }
  }
  return current;
}

function asQuestionNumber(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

// The printed question numbers each raw candidate claims — `source_number`
// (one) or `source_numbers` (several: a match item built from rows 1-5
// claims all five, otherwise the report would list 2-5 as missing, which
// the Unit 1 Bedrock run did) — aligned with the raw list; [] when absent.
// Read BEFORE validation, which strips both fields.
export function readSourceNumbers(raw: readonly unknown[]): number[][] {
  return raw.map((cand) => {
    if (!cand || typeof cand !== "object") return [];
    const { source_number, source_numbers } = cand as {
      source_number?: unknown;
      source_numbers?: unknown;
    };
    const list = Array.isArray(source_numbers) ? source_numbers : [source_number];
    return list.map(asQuestionNumber).filter((n): n is number => n != null);
  });
}

export interface NumberingReport {
  /** Highest question number the text layer numbers to; null on the
   * scanned path (no text to count). */
  numbered_items: number | null;
  /** Raw candidates the model returned, valid or not — what "extracted"
   * means to the teacher. */
  extracted_count: number;
  /** Numbers in 1..numbered_items no candidate claimed; null when the model
   * gave no source numbers at all (then only the counts are comparable). */
  missing_numbers: number[] | null;
  /** Warn the teacher (James, 2026-09-01: any shortfall). */
  shortfall: boolean;
}

// E4 emits two candidates for one "show your work" question, so counts
// alone over-report coverage; with source numbers the missing list is
// exact, and without them the count comparison is the fallback.
export function numberingReport(
  numberedItems: number | null,
  raw: readonly unknown[],
): NumberingReport {
  const extracted_count = raw.length;
  if (numberedItems == null || numberedItems <= 0) {
    return { numbered_items: numberedItems, extracted_count, missing_numbers: null, shortfall: false };
  }
  const claimed = new Set(readSourceNumbers(raw).flat());
  if (claimed.size === 0) {
    return {
      numbered_items: numberedItems,
      extracted_count,
      missing_numbers: null,
      shortfall: numberedItems > extracted_count,
    };
  }
  const missing_numbers: number[] = [];
  for (let n = 1; n <= numberedItems; n++) if (!claimed.has(n)) missing_numbers.push(n);
  return {
    numbered_items: numberedItems,
    extracted_count,
    missing_numbers,
    shortfall: missing_numbers.length > 0,
  };
}

// --- E9: several forms in one document ---

export interface FormsReport {
  /** Forms detected — at least 2 when reported. */
  count: number;
  /** Validated candidate indexes per form, in document order; null when
   * only "Form A / Form B" labels were seen and the numbering ran on. */
  groups: number[][] | null;
  source: "numbering" | "labels";
}

/**
 * E9 (decision James 2026-09-02): a document that carries several forms
 * numbers each one from 1 (Solubility: four forms of six). Over the
 * validated candidates' claimed numbers, a group ends where the numbering
 * drops — the next candidate's lowest number is BELOW the group's highest
 * so far (an E4 twin that repeats its number stays; a match set claiming
 * 1–5 counts as 5); an unnumbered candidate stays with the current group.
 * Forms are reported only when there are at least two groups, every group
 * has at least two questions and the smallest is at least half the
 * largest: sections numbered from 1 inside one form look the same, so the
 * teacher confirms in the panel and the default imports everything.
 */
export function detectForms(validSourceNumbers: readonly (readonly number[])[]): FormsReport | null {
  const groups: number[][] = [];
  let cur: number[] = [];
  let high = 0;
  validSourceNumbers.forEach((nums, i) => {
    const lo = nums.length > 0 ? Math.min(...nums) : null;
    if (lo !== null && cur.length > 0 && lo < high) {
      groups.push(cur);
      cur = [];
      high = 0;
    }
    cur.push(i);
    if (nums.length > 0) high = Math.max(high, ...nums);
  });
  if (cur.length > 0) groups.push(cur);
  if (groups.length < 2) return null;
  const sizes = groups.map((g) => g.length);
  const min = Math.min(...sizes);
  const max = Math.max(...sizes);
  if (min < 2 || min * 2 < max) return null;
  return { count: groups.length, groups, source: "numbering" };
}

/** "Form A" … "Form H" labels in the text layer (distinct letters). */
export function countFormLabels(text: string): number {
  const seen = new Set<string>();
  for (const m of text.matchAll(/\bForm\s+([A-H])\b/g)) seen.add(m[1]!.toUpperCase());
  return seen.size;
}

/** Numbering first; labels alone can only announce a count. */
export function formsReport(
  validSourceNumbers: readonly (readonly number[])[],
  text: string | null,
): FormsReport | null {
  const byNumbering = detectForms(validSourceNumbers);
  if (byNumbering) return byNumbering;
  const labels = text ? countFormLabels(text) : 0;
  return labels >= 2 ? { count: labels, groups: null, source: "labels" } : null;
}

// --- E5 slice 3: proposed item sets ---

/** A set as the panel receives it: indexes into the VALIDATED candidate list. */
export interface ProposedSet {
  id: string;
  stimulus: string;
  /** Figure numbers (1-based, `figures[].n`) the set uses. */
  figures: number[];
  /** Consecutive indexes into the validated candidates. */
  item_indexes: number[];
  source: "model" | "adjacency";
  /** E13: the model saw a figure these questions depend on but nothing
   * could be attached (a scan). Present only when true and the set carries
   * no figure of its own; the teacher adds the figure by hand. */
  needs_figure?: boolean;
}

export interface RejectedSet {
  index: number;
  /** `empty` (2026-09-02, row 31): neither stimulus text nor a figure that
   * exists — a card that would offer nothing. */
  reason: "no_items" | "not_contiguous" | "all_items_rejected" | "invalid" | "empty";
}

export interface SetValidation {
  sets: ProposedSet[];
  rejected: RejectedSet[];
}

const asIndexList = (v: unknown): number[] =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === "string" ? Number(x) : x)).filter((n): n is number => Number.isInteger(n) && n >= 0)
    : [];

/**
 * Turn the model's raw sets into panel sets: indexes remapped from the raw
 * candidate list to the validated one (a rejected candidate just leaves
 * its set), each index in one set only (first set wins), the set kept as
 * its first consecutive run (the rest is reported not_contiguous), figure
 * numbers limited to what exists, stimulus bounded. A set left with no
 * figure and no text is dropped (`empty`) and its questions stay plain
 * candidates — the row-31 scan produced exactly that card — unless the
 * model marked it `needs_figure` (E13): that one is a placeholder the
 * teacher fills, and is kept with the flag.
 */
export function validateProposedSets(
  raw: readonly unknown[],
  rawToValid: ReadonlyMap<number, number>,
  figureCount: number,
): SetValidation {
  const sets: ProposedSet[] = [];
  const rejected: RejectedSet[] = [];
  const taken = new Set<number>();
  raw.forEach((cand, index) => {
    if (!cand || typeof cand !== "object") {
      rejected.push({ index, reason: "invalid" });
      return;
    }
    const obj = cand as {
      stimulus?: unknown;
      figures?: unknown;
      figure?: unknown;
      item_indexes?: unknown;
      needs_figure?: unknown;
    };
    const rawIndexes = asIndexList(obj.item_indexes);
    if (rawIndexes.length === 0) {
      rejected.push({ index, reason: "no_items" });
      return;
    }
    const mapped = [...new Set(rawIndexes.map((i) => rawToValid.get(i)).filter((i): i is number => i !== undefined))]
      .filter((i) => !taken.has(i))
      .sort((a, b) => a - b);
    if (mapped.length === 0) {
      rejected.push({ index, reason: "all_items_rejected" });
      return;
    }
    const figureList = Array.isArray(obj.figures)
      ? obj.figures
      : obj.figure !== undefined && obj.figure !== null
        ? [obj.figure]
        : [];
    const figures = [...new Set(asIndexList(figureList).filter((n) => n >= 1 && n <= figureCount))];
    const bounded = typeof obj.stimulus === "string" ? obj.stimulus.slice(0, 20000) : "";
    // E14: with no figure extracted a marker in the stimulus refers to nothing.
    const stimulus = figureCount === 0 ? stripFigureMarkers(bounded) : bounded;
    // E13: meaningful only when the set has no figure of its own.
    const needsFigure = obj.needs_figure === true && figures.length === 0;
    if (figures.length === 0 && stimulus.trim().length === 0 && !needsFigure) {
      rejected.push({ index, reason: "empty" });
      return;
    }
    const run: number[] = [mapped[0]!];
    for (let k = 1; k < mapped.length; k++) {
      if (mapped[k] === run[run.length - 1]! + 1) run.push(mapped[k]!);
      else break;
    }
    if (run.length < mapped.length) rejected.push({ index, reason: "not_contiguous" });
    for (const i of run) taken.add(i);
    sets.push({
      id: `s${sets.length + 1}`,
      stimulus,
      figures,
      item_indexes: run,
      source: "model",
      ...(needsFigure ? { needs_figure: true } : {}),
    });
  });
  return { sets, rejected };
}

/**
 * The question number printed first after `[FIGURE n]` in the marked text —
 * the adjacency rule from the design doc ("the figure immediately above"):
 * a figure belongs to the first numbered question below it. Markers in
 * between are skipped, so two figures stacked above one question both
 * land on it. null when nothing numbered follows (a figure after the last
 * question, cover art on a title page).
 */
export function questionAfterFigure(textWithMarkers: string, n: number): number | null {
  const at = textWithMarkers.indexOf(`[FIGURE ${n}]`);
  if (at < 0) return null;
  const rest = textWithMarkers.slice(at + `[FIGURE ${n}]`.length).replace(/\[FIGURE \d+\]/g, " ");
  const m = /(?:^|[\s(])(\d{1,3})[.)](?=\s|$)/.exec(rest);
  return m ? Number(m[1]) : null;
}

/**
 * Figures the model did not place get a set of one on the first question
 * below them (matched by the candidate's printed number), when that
 * candidate is not already in a set. Figures with no such question are left
 * for the teacher (they stay in the figure strip).
 */
export function adjacencyFallback(
  figureCount: number,
  textWithMarkers: string,
  validSourceNumbers: readonly (readonly number[])[],
  existing: readonly ProposedSet[],
): ProposedSet[] {
  const usedFigures = new Set(existing.flatMap((s) => s.figures));
  const taken = new Set(existing.flatMap((s) => s.item_indexes));
  const out: ProposedSet[] = [];
  let seq = existing.length;
  for (let n = 1; n <= figureCount; n++) {
    if (usedFigures.has(n)) continue;
    const q = questionAfterFigure(textWithMarkers, n);
    if (q === null) continue;
    const idx = validSourceNumbers.findIndex((nums) => nums.includes(q));
    if (idx < 0) continue;
    // A second unplaced figure above the same question joins the set this
    // pass made for it; a question the model already grouped is left alone.
    const same = out.find((s) => s.item_indexes[0] === idx);
    if (same) {
      same.figures.push(n);
      continue;
    }
    if (taken.has(idx)) continue;
    taken.add(idx);
    seq += 1;
    out.push({ id: `s${seq}`, stimulus: "", figures: [n], item_indexes: [idx], source: "adjacency" });
  }
  return out;
}
