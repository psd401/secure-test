import type { JSONContent } from "@tiptap/core";
import { Fragment, Slice, type Schema } from "@tiptap/pm/model";
import { MARKUP_MARK, MARKUP_NODE } from "./markupDoc";

// R-4 clean paste (docs/editor-redesign-design.md): HTML pasted or dropped
// from Word or Google Docs keeps ONLY what the stored grammar can hold — text,
// bold, italic and line breaks. Fonts, colours, sizes, underline, links,
// lists' structure, tables' structure and Office's XML all fall away; their
// text stays. Pictures are left out (an editor picture must be an uploaded
// asset) and counted so the field can say so.
//
// A string-level reader rather than DOMParser so it runs, and is tested, the
// same headlessly as in the browser. It does not have to be a complete HTML
// parser: its output is rebuilt from scratch (`runsToHtml`) from four tags,
// and ProseMirror then parses that through the editor's schema.
//
// Weight and style come from the tag (b / strong, i / em) and are overridden
// by an inline `font-weight` / `font-style` — Google Docs wraps every paste in
// `<b style="font-weight:normal">` and marks real bold on spans
// (`font-weight:700`); Word uses `<b>` / `<i>` with `mso-` styles.

export type PasteRun = { text: string; bold: boolean; italic: boolean } | { break: true };

export interface SanitizedPaste {
  runs: PasteRun[];
  droppedImages: number;
}

const DROP_WHOLE = /<(style|script|head|title|xml|template|noscript)\b[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
// Word's downlevel-revealed conditionals `<![if …]>` / `<![endif]>`.
const CONDITIONAL = /<!\[[^\]]*\]>/g;
const TOKEN = /<(\/?)([a-zA-Z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g;

const VOID = new Set(["br", "img", "hr", "meta", "link", "input", "col", "area", "wbr", "base", "source", "v:imagedata"]);
const BLOCK = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "tr", "table", "tbody", "thead",
  "blockquote", "pre", "section", "article", "header", "footer", "dl", "dt", "dd", "body", "html",
]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", bull: "•",
  middot: "·", times: "×", divide: "÷", deg: "°", plusmn: "±", minus: "−", le: "≤", ge: "≥", ne: "≠",
  frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³", copy: "©", reg: "®", trade: "™",
  pi: "π", micro: "µ", para: "¶", sect: "§",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const cp = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function styleValue(attrs: string, prop: string): string | null {
  const style = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
  const body = style ? decodeEntities(style[2] ?? style[3] ?? "") : "";
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(body);
  return m ? m[1]!.trim().toLowerCase() : null;
}

function weight(tag: string, attrs: string): boolean | undefined {
  const v = styleValue(attrs, "font-weight");
  if (v) {
    if (v === "bold" || v === "bolder") return true;
    if (v === "normal" || v === "lighter") return false;
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n >= 600;
  }
  return tag === "b" || tag === "strong" ? true : undefined;
}

function slant(tag: string, attrs: string): boolean | undefined {
  const v = styleValue(attrs, "font-style");
  if (v) return v.startsWith("italic") || v.startsWith("oblique");
  return tag === "i" || tag === "em" ? true : undefined;
}

interface Open {
  tag: string;
  bold?: boolean;
  italic?: boolean;
}

export function sanitizePastedHtml(html: string): SanitizedPaste {
  // Until nothing changes: one pass can re-form what it removed
  // (`<scr<script></script>ipt>`), and that element's body would then be
  // kept as text. The output is rebuilt from escaped text, so this is about
  // hidden content showing up, not markup getting through.
  let cleaned = html;
  for (let prev = ""; prev !== cleaned; ) {
    prev = cleaned;
    cleaned = cleaned.replace(COMMENT, "").replace(CONDITIONAL, "").replace(DROP_WHOLE, "");
  }
  const stack: Open[] = [];
  const lines: { text: string; bold: boolean; italic: boolean }[][] = [[]];
  let droppedImages = 0;

  const current = () => lines[lines.length - 1]!;
  const effective = (key: "bold" | "italic") => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const v = stack[i]![key];
      if (v !== undefined) return v;
    }
    return false;
  };
  const endLine = (force: boolean) => {
    if (force || current().length > 0) lines.push([]);
  };
  const addText = (raw: string) => {
    // HTML whitespace collapses. No-break spaces collapse too: Word and Docs
    // pad list bullets with runs of them.
    let text = decodeEntities(raw).replace(/[ \t\r\n\f\u00a0]+/g, " ");
    const line = current();
    const prev = line[line.length - 1];
    if (!prev || prev.text.endsWith(" ")) text = text.replace(/^ +/, "");
    if (!text) return;
    line.push({ text, bold: effective("bold"), italic: effective("italic") });
  };

  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(cleaned)) !== null) {
    if (m[4] !== undefined) {
      addText(m[4]);
      continue;
    }
    if (m[2] === undefined) {
      addText("<");
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3] ?? "";
    if (closing) {
      const at = stack.map((o) => o.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      if (BLOCK.has(tag)) endLine(false);
      else if (tag === "td" || tag === "th") addText(" ");
      continue;
    }
    if (tag === "br") {
      endLine(true);
      continue;
    }
    if (tag === "img" || tag === "v:imagedata") {
      droppedImages++;
      continue;
    }
    if (BLOCK.has(tag)) endLine(false);
    if (VOID.has(tag) || /\/\s*$/.test(attrs)) continue;
    stack.push({ tag, bold: weight(tag, attrs), italic: slant(tag, attrs) });
  }

  // Lines → runs: trim each line's edges, drop empty lines, join with breaks,
  // merge neighbours that share a format.
  const runs: PasteRun[] = [];
  for (const line of lines) {
    const parts = line.map((r) => ({ ...r }));
    while (parts.length > 0) {
      parts[0]!.text = parts[0]!.text.replace(/^ +/, "");
      if (parts[0]!.text) break;
      parts.shift();
    }
    while (parts.length > 0) {
      const last = parts[parts.length - 1]!;
      last.text = last.text.replace(/ +$/, "");
      if (last.text) break;
      parts.pop();
    }
    if (parts.length === 0) continue;
    if (runs.length > 0) runs.push({ break: true });
    for (const part of parts) {
      const prev = runs[runs.length - 1];
      if (prev && !("break" in prev) && prev.bold === part.bold && prev.italic === part.italic) {
        prev.text += part.text;
      } else {
        runs.push(part);
      }
    }
  }
  return { runs, droppedImages };
}

/** A choice is one line: breaks become spaces. */
export function joinLines(runs: readonly PasteRun[]): PasteRun[] {
  return runs.map((r) => ("break" in r ? { text: " ", bold: false, italic: false } : r));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The clean HTML handed to ProseMirror: one `<p>` of text, `<strong>`, `<em>`, `<br>`. */
export function runsToHtml(runs: readonly PasteRun[]): string {
  let body = "";
  for (const r of runs) {
    if ("break" in r) {
      body += "<br>";
      continue;
    }
    let t = esc(r.text);
    if (r.italic) t = `<em>${t}</em>`;
    if (r.bold) t = `<strong>${t}</strong>`;
    body += t;
  }
  return `<p>${body}</p>`;
}

/** The same runs as editor JSON (inline nodes), for tests and direct inserts. */
export function runsToContent(runs: readonly PasteRun[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const r of runs) {
    if ("break" in r) {
      out.push({ type: MARKUP_NODE.hardBreak });
      continue;
    }
    if (!r.text) continue;
    const marks = [
      ...(r.bold ? [{ type: MARKUP_MARK.strong }] : []),
      ...(r.italic ? [{ type: MARKUP_MARK.em }] : []),
    ];
    out.push(marks.length > 0 ? { type: MARKUP_NODE.text, text: r.text, marks } : { type: MARKUP_NODE.text, text: r.text });
  }
  return out;
}

/** Plain-text paste: lines become breaks (or spaces in a one-line field). */
export function plainTextToContent(text: string, singleLine = false): JSONContent[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: JSONContent[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(singleLine ? { type: MARKUP_NODE.text, text: " " } : { type: MARKUP_NODE.hardBreak });
    if (line) out.push({ type: MARKUP_NODE.text, text: line });
  });
  return out;
}

// ---------- ProseMirror's own slices ----------

// A copy out of one of these fields carries ProseMirror's slice marker
// (`data-pm-slice`) and is parsed through the schema as is, so a formula,
// picture or blank survives a copy from the question to a choice. The
// marker proves nothing about where a paste came from, though: any page
// can put it on the clipboard, and the schema would then turn its
// `<img data-asset-id>` and `<span data-math>` into real nodes. So a
// marked paste keeps its parse only when it is the slice this tab last
// copied out of a field; anything else is cleaned like other HTML. Compared
// as JSON because every field builds its own schema, and Slice.eq compares
// node types by identity.

let ownCopy: string | null = null;

/** Record a slice copied (or cut) out of a field; returns it unchanged. */
export function rememberCopied(slice: Slice): Slice {
  ownCopy = JSON.stringify(slice.toJSON());
  return slice;
}

/**
 * What a marked paste becomes once ProseMirror has parsed it: null keeps the
 * parse (it is this tab's own copy); otherwise the clipboard HTML cleaned
 * like a paste from Word.
 */
export function cleanForeignSlice(
  slice: Slice,
  html: string,
  schema: Schema,
  singleLine: boolean,
): { slice: Slice; droppedImages: number } | null {
  if (ownCopy !== null && JSON.stringify(slice.toJSON()) === ownCopy) return null;
  const out = sanitizePastedHtml(html);
  const runs = singleLine ? joinLines(out.runs) : out.runs;
  return { slice: new Slice(Fragment.fromJSON(schema, runsToContent(runs)), 0, 0), droppedImages: out.droppedImages };
}
