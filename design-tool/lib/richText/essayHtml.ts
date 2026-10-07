// RT slice 1 (docs/rich-text-essay-design.md): the server's half of a
// formatted essay answer.
//
// A formatted essay arrives as `{type: "essay", text, html}`. The client's
// `html` is never trusted or stored as sent: it is parsed here, rebuilt from
// a fixed subset, and `text` is DERIVED from the rebuilt html (D-7), so word
// count, AI scoring, safeguarding, insights and answer history all read the
// same words the teacher will see formatted.
//
// Hand-rolled on purpose: the output is rebuilt from scratch out of a
// handful of tags with no attributes but one, so the parser only has to be
// good enough to recover the student's words and formatting — never to be a
// faithful browser. Nothing the client sends is copied through as markup;
// every character of text is re-escaped.
//
// The subset (the note's "Proposed shape"):
//   <p>          a paragraph; the only attribute kept is data-indent="first"
//                (D-4, MLA-style first-line indent)
//   <br>         a line break inside a paragraph or list item
//   <strong> <em> <u>                       bold / italic / underline (D-2)
//   <ul> <ol> <li>                          lists, ONE level deep (D-9)
//
// What else is accepted, and how it maps:
//   <b>                       → <strong>
//   <i>                       → <em>
//   <span style="…">          → its marks: font-weight bold / bolder / 600–900
//                               → strong; font-style italic / oblique → em;
//                               text-decoration(-line) underline → u
//                               (what a contenteditable may emit)
//   <div>, <h1>–<h6>, <blockquote>, <pre>, <section>, <article>, <header>,
//   <footer>, <aside>, <nav>, <main>, <figure>, <figcaption>, <address>,
//   <dl>, <dt>, <dd>, <table>, <tr>, <td>, <th>, <caption>, <hr>
//                             → a paragraph boundary (<div> and <p> keep
//                               data-indent="first")
//   a list inside a list item → flattened: its items become items of the
//                               outer list, in order (D-9, no nesting)
//   <li> outside any list     → a paragraph
//   text outside any block    → a paragraph
//   <script>, <style>, <iframe>, <object>, <embed>, <noscript>, <template>,
//   <textarea>, <title>, <xmp>, <noembed>, <noframes>, <svg>, <math>,
//   <head>, <select>, <video>, <audio>, <canvas>, <img>, <input>, …
//                             → dropped WITH their content
//   comments, <!doctype>, <?…?> → dropped
//   any other element         → unwrapped (its children kept)
//   every attribute but data-indent="first" on <p>/<div> → removed
//
// Entities: &amp; &lt; &gt; &quot; &apos; &nbsp; and numeric (&#…; / &#x…;)
// are decoded; an unknown named entity stays as literal text. Output text
// escapes & < > only.

/** One run of text with its marks, or a line break. */
type Inline =
  | { kind: "text"; text: string; b: boolean; i: boolean; u: boolean }
  | { kind: "br" };

type Block =
  | { kind: "p"; indent: boolean; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] };

interface Marks {
  b: boolean;
  i: boolean;
  u: boolean;
}

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: "text"; text: string }
  | { kind: "start"; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: "end"; name: string };

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Invalid code points (and NUL / surrogates) become U+FFFD, as a browser does.
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return "�";
      }
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

function parseAttributes(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1]!.toLowerCase();
    if (name in attrs) continue; // first one wins, as in a browser
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Index of the `>` that ends a tag starting at `from`, honouring quotes. */
function tagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let k = from; k < html.length; k++) {
    const c = html[k];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return k;
    }
  }
  return -1;
}

// Elements whose content is raw text in HTML: skipped to their end tag
// without tokenizing what is inside.
const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  let k = 0;
  const flush = () => {
    if (text) tokens.push({ kind: "text", text: decodeEntities(text) });
    text = "";
  };
  while (k < html.length) {
    const lt = html.indexOf("<", k);
    if (lt === -1) {
      text += html.slice(k);
      break;
    }
    text += html.slice(k, lt);
    const next = html[lt + 1];
    if (html.startsWith("<!--", lt)) {
      flush();
      const close = html.indexOf("-->", lt + 4);
      k = close === -1 ? html.length : close + 3;
      continue;
    }
    if (next === "!" || next === "?") {
      flush();
      const close = html.indexOf(">", lt + 2);
      k = close === -1 ? html.length : close + 1;
      continue;
    }
    if (next === "/" && /[a-zA-Z]/.test(html[lt + 2] ?? "")) {
      flush();
      const close = tagEnd(html, lt + 2);
      const end = close === -1 ? html.length : close;
      const name = /^[a-zA-Z][^\s/>]*/.exec(html.slice(lt + 2, end))![0].toLowerCase();
      tokens.push({ kind: "end", name });
      k = close === -1 ? html.length : close + 1;
      continue;
    }
    if (next !== undefined && /[a-zA-Z]/.test(next)) {
      flush();
      const close = tagEnd(html, lt + 1);
      const inner = html.slice(lt + 1, close === -1 ? html.length : close);
      const name = /^[a-zA-Z][^\s/>]*/.exec(inner)![0].toLowerCase();
      const rest = inner.slice(name.length);
      const selfClosing = /\/\s*$/.test(rest);
      tokens.push({ kind: "start", name, attrs: parseAttributes(rest), selfClosing });
      k = close === -1 ? html.length : close + 1;
      if (RAW_TEXT.has(name) && !selfClosing) {
        // Skip to the matching end tag (case-insensitive) — the content is
        // dropped with the element below, so it is never tokenized.
        const endAt = html.toLowerCase().indexOf(`</${name}`, k);
        if (endAt === -1) {
          k = html.length;
          tokens.push({ kind: "end", name });
        } else {
          k = endAt;
        }
      }
      continue;
    }
    // A bare "<" (e.g. "3 < 4") is text.
    text += "<";
    k = lt + 1;
  }
  flush();
  return tokens;
}

// --------------------------------------------------------------------- tree

interface ElementNode {
  kind: "element";
  name: string;
  attrs: Record<string, string>;
  children: Node[];
}
type Node = ElementNode | { kind: "text"; text: string };

const VOID = new Set([
  "br",
  "hr",
  "img",
  "input",
  "wbr",
  "meta",
  "link",
  "area",
  "base",
  "col",
  "embed",
  "source",
  "track",
  "param",
]);

/** Deeper than this, further start tags are unwrapped — a guard against
 * pathological nesting blowing the stack in the recursive walk below. */
const MAX_DEPTH = 64;

function buildTree(tokens: Token[]): ElementNode {
  const root: ElementNode = { kind: "element", name: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  for (const t of tokens) {
    const top = stack[stack.length - 1]!;
    if (t.kind === "text") {
      top.children.push({ kind: "text", text: t.text });
    } else if (t.kind === "start") {
      const el: ElementNode = { kind: "element", name: t.name, attrs: t.attrs, children: [] };
      if (VOID.has(t.name)) {
        top.children.push(el);
      } else if (stack.length > MAX_DEPTH) {
        // unwrapped: children land in `top`
      } else {
        top.children.push(el);
        if (!t.selfClosing) stack.push(el);
      }
    } else {
      // Close the nearest open element of that name; a stray end tag is ignored.
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d]!.name === t.name) {
          stack.length = d;
          break;
        }
      }
    }
  }
  return root;
}

// ------------------------------------------------------------- normalising

/** Dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  ...RAW_TEXT,
  "object",
  "embed",
  "template",
  "svg",
  "math",
  "head",
  "select",
  "option",
  "video",
  "audio",
  "canvas",
  "img",
  "input",
  "button",
  "map",
  "picture",
  "meta",
  "link",
  "base",
]);

/** Elements that end the current paragraph and start the next. */
const BLOCKS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "section",
  "article",
  "header",
  "footer",
  "aside",
  "nav",
  "main",
  "figure",
  "figcaption",
  "address",
  "dl",
  "dt",
  "dd",
  "table",
  "tr",
  "td",
  "th",
  "caption",
  "hr",
  "body",
  "html",
]);

function marksFromStyle(style: string | undefined, marks: Marks): Marks {
  if (!style) return marks;
  const out = { ...marks };
  const s = style.toLowerCase();
  const weight = /font-weight\s*:\s*([a-z0-9]+)/.exec(s)?.[1];
  if (weight === "bold" || weight === "bolder" || (weight && /^\d+$/.test(weight) && Number(weight) >= 600)) {
    out.b = true;
  }
  const fstyle = /font-style\s*:\s*([a-z]+)/.exec(s)?.[1];
  if (fstyle === "italic" || fstyle === "oblique") out.i = true;
  if (/text-decoration(?:-line)?\s*:[^;]*underline/.test(s)) out.u = true;
  return out;
}

function isIndented(el: ElementNode): boolean {
  return (el.name === "p" || el.name === "div") && el.attrs["data-indent"] === "first";
}

const WS_ONLY = /^[ \t\n\r\f]*$/;

/** Does this element contain a list, list item or block element anywhere below it? */
function holdsStructure(el: ElementNode): boolean {
  return el.children.some(
    (c) =>
      c.kind !== "text" &&
      (c.name === "ul" || c.name === "ol" || c.name === "li" || BLOCKS.has(c.name) || holdsStructure(c)),
  );
}

function normalise(root: ElementNode): Block[] {
  const blocks: Block[] = [];
  let para: Extract<Block, { kind: "p" }> | null = null;
  // The open list, if any; `item` is the list item being filled.
  let list: Extract<Block, { kind: "list" }> | null = null;
  let item: Inline[] | null = null;

  const endParagraph = () => {
    para = null;
  };
  const openParagraph = (indent: boolean): Inline[] => {
    const p: Extract<Block, { kind: "p" }> = { kind: "p", indent, inlines: [] };
    para = p;
    blocks.push(p);
    return p.inlines;
  };
  const sink = (): Inline[] => {
    if (list) {
      if (!item) {
        item = [];
        list.items.push(item);
      }
      return item;
    }
    const open: Extract<Block, { kind: "p" }> | null = para;
    return open ? open.inlines : openParagraph(false);
  };
  const emitText = (text: string, marks: Marks) => {
    // Whitespace between blocks (pretty-printed markup) must not open an
    // empty paragraph or list item of its own.
    const open = list ? item !== null : para !== null;
    if (!open && WS_ONLY.test(text)) return;
    sink().push({ kind: "text", text, b: marks.b, i: marks.i, u: marks.u });
  };
  const emitBr = (): void => {
    sink().push({ kind: "br" });
  };

  const walk = (node: Node, marks: Marks): void => {
    if (node.kind === "text") {
      emitText(node.text, marks);
      return;
    }
    const name = node.name;
    if (DROP_WITH_CONTENT.has(name)) return;
    const children = (m: Marks) => {
      for (const c of node.children) walk(c, m);
    };

    if (name === "br") return emitBr();
    if (name === "strong" || name === "b") return children({ ...marks, b: true });
    if (name === "em" || name === "i") return children({ ...marks, i: true });
    if (name === "u") return children({ ...marks, u: true });

    if (name === "ul" || name === "ol") {
      if (list) {
        // D-9: one level. A nested list's items join the outer list.
        item = null;
        children(marks);
        item = null;
        return;
      }
      endParagraph();
      list = { kind: "list", ordered: name === "ol", items: [] };
      blocks.push(list);
      item = null;
      children(marks);
      list = null;
      item = null;
      return;
    }
    if (name === "li") {
      if (list) {
        item = [];
        list.items.push(item);
        children(marks);
        item = null;
        return;
      }
      endParagraph();
      openParagraph(false);
      children(marks);
      endParagraph();
      return;
    }

    if (BLOCKS.has(name)) {
      if (list) {
        // A block inside a list item: a line break, not a new item.
        if (item && item.length > 0) emitBr();
        children(marks);
        return;
      }
      endParagraph();
      if (name !== "hr") {
        openParagraph(isIndented(node));
        const opened = para as Extract<Block, { kind: "p" }> | null;
        children(marks);
        // RT-1 (docs/rich-text-essay-design.md §Progress): WebKit's list
        // command leaves the list INSIDE the paragraph it started in
        // (`<p><ul>…</ul></p>`). The paragraph opened for that wrapper holds
        // nothing of its own, and kept it would be a blank line the student
        // never typed. A wrapper that held a list or another block and no
        // text is dropped; an empty `<p></p>` / `<p><br></p>` with nothing
        // structural inside is still a blank line and stays.
        if (opened && opened.inlines.length === 0 && holdsStructure(node)) {
          const at = blocks.indexOf(opened);
          if (at >= 0) blocks.splice(at, 1);
        }
      }
      endParagraph();
      return;
    }

    if (name === "span" || name === "font") return children(marksFromStyle(node.attrs.style, marks));
    // Anything else: unwrapped.
    children(marks);
  };

  for (const c of root.children) walk(c, { b: false, i: false, u: false });
  return tidy(blocks);
}

function hasText(inlines: Inline[]): boolean {
  return inlines.some((x) => x.kind === "text" && x.text.replace(/[ \t\n\r\f ]/g, "") !== "");
}

/**
 * Merge adjacent runs with the same marks, drop list items with no text and
 * lists with no items, and drop blank paragraphs at the start and end (a
 * blank paragraph between two others is a blank line the student typed, and
 * stays).
 */
function tidy(blocks: Block[]): Block[] {
  const merge = (inlines: Inline[]): Inline[] => {
    const out: Inline[] = [];
    for (const x of inlines) {
      const prev = out[out.length - 1];
      if (x.kind === "text") {
        if (x.text === "") continue;
        if (prev && prev.kind === "text" && prev.b === x.b && prev.i === x.i && prev.u === x.u) {
          out[out.length - 1] = { ...prev, text: prev.text + x.text };
          continue;
        }
      }
      out.push(x);
    }
    return out;
  };
  const kept: Block[] = [];
  for (const b of blocks) {
    if (b.kind === "list") {
      const items = b.items.map(merge).filter(hasText);
      if (items.length > 0) kept.push({ ...b, items });
    } else {
      kept.push({ ...b, inlines: merge(b.inlines) });
    }
  }
  const blank = (b: Block) => b.kind === "p" && !hasText(b.inlines);
  let start = 0;
  let end = kept.length;
  while (start < end && blank(kept[start]!)) start++;
  while (end > start && blank(kept[end - 1]!)) end--;
  return kept.slice(start, end);
}

// ------------------------------------------------------------------ output

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Canonical nesting strong > em > u, so sanitising twice changes nothing. */
function serializeInlines(inlines: Inline[]): string {
  let out = "";
  for (const x of inlines) {
    if (x.kind === "br") {
      out += "<br>";
      continue;
    }
    let s = escapeText(x.text);
    if (x.u) s = `<u>${s}</u>`;
    if (x.i) s = `<em>${s}</em>`;
    if (x.b) s = `<strong>${s}</strong>`;
    out += s;
  }
  return out;
}

function serialize(blocks: Block[]): string {
  return blocks
    .map((b) => {
      if (b.kind === "list") {
        const tag = b.ordered ? "ol" : "ul";
        return `<${tag}>${b.items.map((it) => `<li>${serializeInlines(it)}</li>`).join("")}</${tag}>`;
      }
      const open = b.indent ? '<p data-indent="first">' : "<p>";
      // A blank paragraph keeps a <br> so it renders as the empty line it is.
      const body = hasText(b.inlines) ? serializeInlines(b.inlines) : "<br>";
      return `${open}${body}</p>`;
    })
    .join("");
}

/**
 * Re-clean a student's formatted essay to the RT subset (see the header).
 * Returns "" when nothing readable is left. Idempotent.
 */
export function sanitizeEssayHtml(html: string): string {
  return serialize(normalise(buildTree(tokenize(html))));
}

// -------------------------------------------------------------------- text

/** The plain reading of one paragraph's or item's inlines, as lines. */
function inlinesToText(inlines: Inline[]): string {
  // Rendering collapses runs of ASCII whitespace to one space; a no-break
  // space is a real space (contenteditable writes them for double spaces).
  // A single trailing <br> in a block draws no line (it is a contenteditable
  // placeholder), so it adds nothing.
  const trimmed =
    inlines.length > 0 && inlines[inlines.length - 1]!.kind === "br" ? inlines.slice(0, -1) : inlines;
  let s = "";
  for (const x of trimmed) {
    s += x.kind === "br" ? "\n" : x.text.replace(/[ \t\n\r\f]+/g, " ");
  }
  return s
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}

/**
 * D-7: the plain reading of a formatted essay — what word count, the word
 * limit, AI scoring, safeguarding, insights and answer history read.
 *
 * - Each paragraph is one line; paragraphs are joined by a single "\n".
 *   A contenteditable makes every Enter a new paragraph, so one "\n" per
 *   paragraph reproduces the keys the student pressed, exactly as a
 *   textarea would hold them; a blank line the student typed is a blank
 *   paragraph and so an empty line.
 * - <br> is "\n".
 * - A list item is its own line: "• item" in a bulleted list, "1. item",
 *   "2. item", … in a numbered one, numbered within that list (D-9).
 * - The first-line indent adds nothing (D-4 is presentation only).
 * - Entities are decoded; leading / trailing blank lines are dropped.
 *
 * Accepts any html (it parses with the sanitiser), but the ingest path
 * always passes the sanitised form.
 */
export function essayTextFromHtml(html: string): string {
  const blocks = normalise(buildTree(tokenize(html)));
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.kind === "p") {
      lines.push(inlinesToText(b.inlines));
    } else {
      b.items.forEach((it, n) => {
        const prefix = b.ordered ? `${n + 1}. ` : "• ";
        lines.push(prefix + inlinesToText(it));
      });
    }
  }
  return lines.join("\n").replace(/^\n+|\n+$/g, "");
}

// ------------------------------------------------------------------ ingest

/**
 * RT slice 1, the response write path. For an essay whose item has
 * `rich_text` on and a body that carries `html`: store the re-cleaned html
 * and OVERWRITE `text` with its derivation (D-7 — the server's reading wins,
 * so scoring / safeguarding / history / word count cannot disagree with what
 * the teacher sees). With `rich_text` off, any `html` is dropped and the
 * answer is stored as plain text, as before. A rich_text item answered
 * without `html` (a client older than v1.6.0 shows the plain box) is stored
 * as sent. An html that cleans to nothing stores `{text: ""}` with no html.
 */
export function essayResponseForStorage<
  R extends { type: string; text?: string; html?: string },
>(item: { type: string; config?: { rich_text?: boolean } | null }, response: R): R {
  if (item.type !== "essay" || response.type !== "essay") return response;
  const { html, ...rest } = response;
  if (html === undefined) return response;
  if (!item.config?.rich_text) return rest as R;
  const clean = sanitizeEssayHtml(html);
  if (clean === "") return { ...rest, text: "" } as R;
  return { ...rest, text: essayTextFromHtml(clean), html: clean } as R;
}
