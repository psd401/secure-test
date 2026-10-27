// The authored-text markup grammar (ADR 0009 / 0010, E6, FB slice 1) as a
// parser and a serializer: `parse(markup) → nodes`, `serialize(nodes) →
// markup`, with `serialize(parse(s)) === s` for EVERY string (R-2 of
// docs/editor-redesign-design.md). The stored format stays the markup string
// (R-1); this package only reads and writes it.
//
// The rules are the server renderer's (design-tool/lib/items/renderItemContent.ts
// and, for blanks, lib/items/renderAroundBlanks.ts), step for step:
//
//   1. `![alt](asset:<uuid>)` image refs are split out first (case-insensitive,
//      like IMG_RE), so an image inside `$…$` splits the formula.
//   2. Each remaining run is split into math and text: `$…$` / `$$…$$`; `\$`
//      is a literal dollar everywhere; a single `$` whose next character is a
//      digit opens math only when its run carries `\`+letter, `^` or `_`
//      (C-2 / M-1, "the money rule"); an unmatched `$` is text.
//   3. Each text run gets `**bold**` (first) with `_italic_` inside it and
//      between bolds, by BOLD_RE / ITALIC_RE. No escape syntax: a literal `**`
//      pair in prose becomes bold (a known limitation the fixtures pin).
//   4. `[[id]]` blanks exist only in a fill-in-the-blank stem (`blanks`
//      option): the markers are swapped for a sentinel, the whole stem is
//      parsed once, and the sentinels become blank nodes — so a blank can sit
//      inside bold or italic. When a sentinel lands inside a formula or an
//      image's alt text the stem is parsed segment by segment instead, as the
//      server's fallback does.
//
// Nodes keep everything the source spelled, so the serializer is a plain
// concatenation: an escaped dollar is its own node, an image keeps the case
// its `asset:` was written in, and italic's opening boundary character stays
// in the preceding text node.

/** `\$` — renders as a dollar sign. */
export interface EscapeNode {
  type: "escape";
}

export interface TextNode {
  type: "text";
  /** Source characters, never containing the two-character sequence `\$`. */
  value: string;
}

export interface MathNode {
  type: "math";
  /** The TeX between the delimiters, exactly as written. */
  tex: string;
  /** `$$…$$` rather than `$…$`. */
  display: boolean;
}

export interface ImageNode {
  type: "image";
  alt: string;
  /** The uuid as written (renderers lowercase it for lookup). */
  id: string;
  /** Present only when the `asset` scheme was written in another case. */
  scheme?: string;
}

export interface BlankNode {
  type: "blank";
  id: string;
}

export type ItalicChild = TextNode | EscapeNode | BlankNode;

export interface EmNode {
  type: "em";
  children: ItalicChild[];
}

export type StrongChild = ItalicChild | EmNode;

export interface StrongNode {
  type: "strong";
  children: StrongChild[];
}

export type MarkupNode =
  | TextNode
  | EscapeNode
  | MathNode
  | ImageNode
  | StrongNode
  | EmNode
  | BlankNode;

export interface ParseOptions {
  /**
   * A fill-in-the-blank stem: `true` makes every marker's first occurrence a
   * blank; a list limits that to the item's own blank ids (the renderers keep
   * a marker naming no blank, and a repeated marker, as literal text).
   */
  blanks?: true | readonly string[];
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const IMG_RE = new RegExp(`!\\[([^\\]]*)\\]\\((asset):(${UUID})\\)`, "gi");

// Copied from renderItemContent.ts (E6); the golden fixtures hold the two
// copies to one behaviour.
const BOLD_RE = /\*\*([^*\s](?:[^*\n]*?[^*\s])?)\*\*/g;
const ITALIC_RE = /(^|[\s(\[{"'“‘])_([^_\s](?:[^_\n]*?[^_\s])?)_(?=$|[\s.,;:!?)\]}"'”’])/g;
const MATH_MARKER_RE = /\\[a-zA-Z]|[\^_]/;

/** The schema package's FILL_BLANK_MARKER_RE (FB slice 1). */
export const BLANK_MARKER_RE = /\[\[([A-Za-z0-9_-]{1,40})\]\]/g;

export function parse(markup: string, options: ParseOptions = {}): MarkupNode[] {
  if (typeof markup !== "string" || markup.length === 0) return [];
  if (options.blanks) return parseWithBlanks(markup, options.blanks);
  return parsePlain(markup);
}

export function serialize(nodes: readonly MarkupNode[]): string {
  let out = "";
  for (const node of nodes) out += serializeNode(node);
  return out;
}

function serializeNode(node: MarkupNode): string {
  switch (node.type) {
    case "text":
      return node.value;
    case "escape":
      return "\\$";
    case "math":
      return node.display ? `$$${node.tex}$$` : `$${node.tex}$`;
    case "image":
      return `![${node.alt}](${node.scheme ?? "asset"}:${node.id})`;
    case "blank":
      return `[[${node.id}]]`;
    case "strong":
      return `**${serialize(node.children)}**`;
    case "em":
      return `_${serialize(node.children)}_`;
  }
}

// ---------- steps 1–3 ----------

function parsePlain(input: string): MarkupNode[] {
  const out: MarkupNode[] = [];
  let cursor = 0;
  IMG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMG_RE.exec(input)) !== null) {
    if (m.index > cursor) out.push(...parseMath(input.slice(cursor, m.index)));
    const image: ImageNode = { type: "image", alt: m[1] ?? "", id: m[3]! };
    if (m[2] !== "asset") image.scheme = m[2]!;
    out.push(image);
    cursor = m.index + m[0].length;
  }
  if (cursor < input.length) out.push(...parseMath(input.slice(cursor)));
  return out;
}

// The tokenizer of renderItemContent.ts (`tokenizeMath`), unchanged except
// that a text run is handed on raw (escapes become nodes) rather than
// unescaped.
function parseMath(input: string): MarkupNode[] {
  const out: MarkupNode[] = [];
  let cursor = 0;
  let textStart = 0;
  const len = input.length;
  const pushText = (end: number) => {
    if (end > textStart) out.push(...parseEmphasis(input.slice(textStart, end)));
  };
  while (cursor < len) {
    const ch = input[cursor];
    if (ch === "\\" && input[cursor + 1] === "$") {
      cursor += 2;
      continue;
    }
    if (ch === "$") {
      const display = input[cursor + 1] === "$";
      const next = input[cursor + 1];
      const digitOpener = !display && next !== undefined && next >= "0" && next <= "9";
      const openLen = display ? 2 : 1;
      let scan = cursor + openLen;
      let closeAt = -1;
      while (scan < len) {
        if (input[scan] === "\\" && input[scan + 1] === "$") {
          scan += 2;
          continue;
        }
        if (input[scan] === "$") {
          if (display) {
            if (input[scan + 1] === "$") {
              closeAt = scan;
              break;
            }
            scan += 1;
            continue;
          }
          closeAt = scan;
          break;
        }
        scan += 1;
      }
      if (closeAt === -1) {
        cursor += 1;
        continue;
      }
      if (digitOpener && !MATH_MARKER_RE.test(input.slice(cursor + 1, closeAt))) {
        cursor += 1;
        continue;
      }
      pushText(cursor);
      out.push({ type: "math", tex: input.slice(cursor + openLen, closeAt), display });
      cursor = closeAt + openLen;
      textStart = cursor;
      continue;
    }
    cursor += 1;
  }
  pushText(len);
  return out;
}

// The server unescapes `\$` before emphasis; matching on the raw run instead
// is equivalent — `\$` and `$` fall in the same classes of both patterns (not
// `*`, `_`, whitespace, or a boundary character), and no delimiter can split
// the pair.
function parseEmphasis(raw: string): MarkupNode[] {
  const out: MarkupNode[] = [];
  let last = 0;
  BOLD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BOLD_RE.exec(raw)) !== null) {
    out.push(...parseItalic(raw.slice(last, m.index)));
    out.push({ type: "strong", children: parseItalic(m[1]!) });
    last = m.index + m[0].length;
  }
  out.push(...parseItalic(raw.slice(last)));
  return out;
}

function parseItalic(raw: string): (ItalicChild | EmNode)[] {
  const out: (ItalicChild | EmNode)[] = [];
  let last = 0;
  ITALIC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ITALIC_RE.exec(raw)) !== null) {
    out.push(...textNodes(raw.slice(last, m.index) + m[1]!));
    out.push({ type: "em", children: textNodes(m[2]!) });
    last = m.index + m[0].length;
  }
  out.push(...textNodes(raw.slice(last)));
  return out;
}

function textNodes(raw: string): (TextNode | EscapeNode)[] {
  const out: (TextNode | EscapeNode)[] = [];
  const parts = raw.split("\\$");
  parts.forEach((part, i) => {
    if (part) out.push({ type: "text", value: part });
    if (i < parts.length - 1) out.push({ type: "escape" });
  });
  return out;
}

// ---------- step 4: blanks ----------

// The server joins with U+E000 and STRIPS that character from the stem first;
// stripping would make the parse lossy, so this parser uses a private-use
// character the stem does not contain — every such character falls in the
// same classes of the patterns above, so the parse is the same.
function freeSentinel(input: string): string {
  for (let cp = 0xe000; cp <= 0xf8ff; cp++) {
    const ch = String.fromCharCode(cp);
    if (!input.includes(ch)) return ch;
  }
  throw new Error("no free private-use character for the blank sentinel");
}

function parseWithBlanks(input: string, blanks: true | readonly string[]): MarkupNode[] {
  const allowed = blanks === true ? null : new Set(blanks);
  const placed = new Set<string>();
  const texts: string[] = [];
  const ids: string[] = [];
  let last = 0;
  for (const m of input.matchAll(BLANK_MARKER_RE)) {
    const id = m[1]!;
    if ((allowed && !allowed.has(id)) || placed.has(id)) continue;
    placed.add(id);
    texts.push(input.slice(last, m.index));
    ids.push(id);
    last = m.index! + m[0].length;
  }
  texts.push(input.slice(last));
  if (ids.length === 0) return parsePlain(input);

  const sentinel = freeSentinel(input);
  const whole = parsePlain(texts.join(sentinel));
  const placedNodes = substituteBlanks(whole, sentinel, ids);
  if (placedNodes) return placedNodes;

  // A sentinel inside a formula or an alt text: segment by segment, as
  // renderAroundBlanks falls back.
  const out: MarkupNode[] = [];
  texts.forEach((text, i) => {
    out.push(...parsePlain(text));
    if (i < ids.length) out.push({ type: "blank", id: ids[i]! });
  });
  return out;
}

/** Sentinels in text nodes → blank nodes; null when one sits anywhere else. */
function substituteBlanks(
  nodes: MarkupNode[],
  sentinel: string,
  ids: readonly string[],
): MarkupNode[] | null {
  let next = 0;
  let stray = false;
  const walk = <T extends MarkupNode>(list: readonly T[]): T[] => {
    const out: T[] = [];
    for (const node of list) {
      if (node.type === "text" && node.value.includes(sentinel)) {
        const parts = node.value.split(sentinel);
        parts.forEach((part, i) => {
          if (part) out.push({ type: "text", value: part } as T);
          if (i < parts.length - 1) out.push({ type: "blank", id: ids[next++]! } as T);
        });
      } else if (node.type === "strong" || node.type === "em") {
        out.push({ ...node, children: walk(node.children as MarkupNode[]) } as T);
      } else {
        if (node.type === "math" && node.tex.includes(sentinel)) stray = true;
        if (node.type === "image" && node.alt.includes(sentinel)) stray = true;
        out.push(node);
      }
    }
    return out;
  };
  const result = walk(nodes);
  return stray || next !== ids.length ? null : result;
}
