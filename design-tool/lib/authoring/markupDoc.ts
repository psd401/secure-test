import type { JSONContent } from "@tiptap/core";
import {
  BLANK_MARKER_RE,
  parse,
  renderedForm,
  serialize,
  type EmNode,
  type ItalicChild,
  type MarkupNode,
  type ParseOptions,
  type StrongChild,
  type TextNode,
} from "@secure-test/markup";

// R-4 (docs/editor-redesign-design.md): the new editor's document <-> the
// stored markup string. R-1 holds: the editor never stores its JSON; it loads
// markup into a one-paragraph ProseMirror document whose nodes map 1:1 onto
// packages/markup's AST, and saves by turning that document back into AST and
// calling `serialize`.
//
// The document shape (what `getSchema(markupExtensions())` accepts and what
// `editor.getJSON()` returns): doc > one paragraph > inline nodes —
//   text (marks: strong, em)      a markup text run; "\n" is a hardBreak
//   hardBreak                     "\n"
//   escapedDollar (marks)         `\$` — shows "$"
//   blank {id} (marks)            `[[id]]` in a fill-in-the-blank stem
//   math {tex, display}           `$tex$` / `$$tex$$`
//   image {alt, id, scheme}       `![alt](asset:<uuid>)`
// strong / em are marks; em nested in strong is the marks [strong, em] (the
// grammar has no strong inside em).
//
// Loading is exact or refused: `markupToDoc` reports `representable: false`
// when saving the loaded document unchanged would not give back the same
// string (or, for a blank marker inside math or alt text, ER-F1–F3, when the
// two renderers disagree about what it means). The field then opens
// read-only with "Show source" rather than rewriting the item (Risks).

export const MARKUP_NODE = {
  doc: "doc",
  paragraph: "paragraph",
  text: "text",
  hardBreak: "hardBreak",
  dollar: "escapedDollar",
  blank: "blank",
  math: "math",
  image: "image",
} as const;

export const MARKUP_MARK = { strong: "strong", em: "em" } as const;

export type Unrepresentable =
  /** A `[[id]]` marker inside a formula or alt text (ER-F1 – ER-F3). */
  | "blank_in_math_or_alt"
  /** The editor's document would save as a different string (e.g. `**a****b**`). */
  | "not_round_trip";

export interface LoadedMarkup {
  doc: JSONContent;
  representable: boolean;
  reason?: Unrepresentable;
}

export interface SavedMarkup {
  markup: string;
  /**
   * The saved string reads back as what the editor shows. False when typed
   * characters spell markup with no escape (`**`, `_word_`) or a formula's TeX
   * holds a delimiter — the field warns and shows the student preview.
   */
  exact: boolean;
}

type Mark = { type: string };

export function markupToDoc(markup: string, options: ParseOptions = {}): LoadedMarkup {
  const inline = mergeText(toInline(parse(markup, options), []));
  const doc: JSONContent = {
    type: MARKUP_NODE.doc,
    content: [
      inline.length > 0
        ? { type: MARKUP_NODE.paragraph, content: inline }
        : { type: MARKUP_NODE.paragraph },
    ],
  };
  if (options.blanks && blankInMathOrAlt(markup, options.blanks)) {
    return { doc, representable: false, reason: "blank_in_math_or_alt" };
  }
  if (serialize(docToNodes(doc)) !== markup) {
    return { doc, representable: false, reason: "not_round_trip" };
  }
  return { doc, representable: true };
}

/**
 * The document as markup. Tries the plain serialization, then one with every
 * typed `$` escaped as `\$` (which shows the same), and keeps the first whose
 * parse is what the editor shows. A document loaded by `markupToDoc` always
 * passes on the first try, so opening and saving an item never changes it.
 */
export function docToMarkup(doc: JSONContent, options: ParseOptions = {}): SavedMarkup {
  const nodes = docToNodes(doc);
  // Phase 4 slice C: a blank chip in the document is a blank, even before the
  // item's blank list has caught up with an "Insert blank" in the same event.
  if (Array.isArray(options.blanks)) {
    const ids = new Set<string>(options.blanks);
    for (const n of doc.content?.[0]?.content ?? []) {
      if (n.type === MARKUP_NODE.blank && n.attrs?.id) ids.add(String(n.attrs.id));
    }
    options = { ...options, blanks: [...ids] };
  }
  const want = JSON.stringify(renderedForm(nodes));
  for (const candidate of [nodes, escapeDollars(nodes)]) {
    const markup = serialize(candidate);
    if (JSON.stringify(renderedForm(parse(markup, options))) === want) {
      return { markup, exact: true };
    }
  }
  // Neither shows exactly (a typed `**`, say): still escape typed dollars, so a
  // `$x^2$` typed beside it stays text instead of becoming a formula (F-2).
  return { markup: serialize(escapeDollars(nodes)), exact: false };
}

// ---------- markup -> document ----------

function withMarks(node: JSONContent, marks: readonly Mark[]): JSONContent {
  return marks.length > 0 ? { ...node, marks: marks.map((m) => ({ ...m })) } : node;
}

function toInline(nodes: readonly MarkupNode[], marks: readonly Mark[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        node.value.split("\n").forEach((part, i) => {
          if (i > 0) out.push(withMarks({ type: MARKUP_NODE.hardBreak }, marks));
          if (part) out.push(withMarks({ type: MARKUP_NODE.text, text: part }, marks));
        });
        break;
      case "escape":
        out.push(withMarks({ type: MARKUP_NODE.dollar }, marks));
        break;
      case "blank":
        out.push(withMarks({ type: MARKUP_NODE.blank, attrs: { id: node.id } }, marks));
        break;
      case "math":
        out.push({ type: MARKUP_NODE.math, attrs: { tex: node.tex, display: node.display } });
        break;
      case "image":
        out.push({
          type: MARKUP_NODE.image,
          attrs: { alt: node.alt, id: node.id, scheme: node.scheme ?? null },
        });
        break;
      case "strong":
        // Schema rank order: strong before em.
        out.push(...toInline(node.children, [{ type: MARKUP_MARK.strong }, ...marks]));
        break;
      case "em":
        out.push(...toInline(node.children, [...marks, { type: MARKUP_MARK.em }]));
        break;
    }
  }
  return out;
}

const markKey = (n: JSONContent) => (n.marks ?? []).map((m) => m.type).join(",");

/** ProseMirror joins adjacent text nodes with the same marks; so do we, so the
 *  JSON here is exactly what the editor's schema holds. */
function mergeText(nodes: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (prev && prev.type === MARKUP_NODE.text && node.type === MARKUP_NODE.text && markKey(prev) === markKey(node)) {
      out[out.length - 1] = { ...prev, text: (prev.text ?? "") + (node.text ?? "") };
    } else {
      out.push(node);
    }
  }
  return out;
}

// Like the renderers, read the stem with each blank's marker swapped for one
// private-use character (a marker's `]]` cannot sit in alt text, a sentinel
// can — ER-F1), then look for that character in a formula or an alt text.
function blankInMathOrAlt(markup: string, blanks: true | readonly string[]): boolean {
  const allowed = blanks === true ? null : new Set(blanks);
  let sentinel = "";
  for (let cp = 0xe000; cp <= 0xf8ff && !sentinel; cp++) {
    if (!markup.includes(String.fromCharCode(cp))) sentinel = String.fromCharCode(cp);
  }
  if (!sentinel) return true;
  const placed = new Set<string>();
  const swapped = markup.replace(BLANK_MARKER_RE, (whole, id: string) => {
    if ((allowed && !allowed.has(id)) || placed.has(id)) return whole;
    placed.add(id);
    return sentinel;
  });
  if (placed.size === 0) return false;
  return parse(swapped).some(
    (n) => (n.type === "math" && n.tex.includes(sentinel)) || (n.type === "image" && n.alt.includes(sentinel)),
  );
}

// ---------- document -> markup ----------

interface Leaf {
  node: ItalicChild | MarkupNode;
  strong: boolean;
  em: boolean;
}

function leaves(doc: JSONContent): Leaf[] {
  const inline = doc.content?.[0]?.content ?? [];
  const out: Leaf[] = [];
  for (const n of inline) {
    const types = new Set((n.marks ?? []).map((m) => m.type));
    const strong = types.has(MARKUP_MARK.strong);
    const em = types.has(MARKUP_MARK.em);
    switch (n.type) {
      case MARKUP_NODE.text:
        if (n.text) out.push({ node: { type: "text", value: n.text }, strong, em });
        break;
      case MARKUP_NODE.hardBreak:
        // The grammar has no newline inside bold or italic.
        out.push({ node: { type: "text", value: "\n" }, strong: false, em: false });
        break;
      case MARKUP_NODE.dollar:
        out.push({ node: { type: "escape" }, strong, em });
        break;
      case MARKUP_NODE.blank:
        out.push({ node: { type: "blank", id: String(n.attrs?.id ?? "") }, strong, em });
        break;
      case MARKUP_NODE.math:
        // A formula is never inside bold or italic: a bold range across one
        // closes before it and reopens after.
        out.push({
          node: { type: "math", tex: String(n.attrs?.tex ?? ""), display: n.attrs?.display === true },
          strong: false,
          em: false,
        });
        break;
      case MARKUP_NODE.image: {
        const scheme = n.attrs?.scheme;
        out.push({
          node: {
            type: "image",
            alt: String(n.attrs?.alt ?? ""),
            id: String(n.attrs?.id ?? ""),
            ...(typeof scheme === "string" && scheme ? { scheme } : {}),
          },
          strong: false,
          em: false,
        });
        break;
      }
    }
  }
  return out;
}

/** The document's AST: runs of strong leaves become one strong node, runs of
 *  em leaves inside or outside it one em node. */
export function docToNodes(doc: JSONContent): MarkupNode[] {
  const all = leaves(doc);
  const out: MarkupNode[] = [];
  for (const run of runs(all, (l) => l.strong)) {
    const inner = emGroups(run.items);
    if (run.on) out.push(...wrapTrimmed("strong", inner as StrongChild[]));
    else out.push(...inner);
  }
  return out;
}

function runs<T>(items: readonly T[], on: (t: T) => boolean): { on: boolean; items: T[] }[] {
  const out: { on: boolean; items: T[] }[] = [];
  for (const item of items) {
    const flag = on(item);
    const last = out[out.length - 1];
    if (last && last.on === flag) last.items.push(item);
    else out.push({ on: flag, items: [item] });
  }
  return out;
}

function emGroups(items: readonly Leaf[]): MarkupNode[] {
  const out: MarkupNode[] = [];
  for (const run of runs(items, (l) => l.em)) {
    const nodes = run.items.map((l) => l.node) as MarkupNode[];
    if (run.on) out.push(...wrapTrimmed("em", nodes as ItalicChild[]));
    else out.push(...nodes);
  }
  return out;
}

/**
 * Bold and italic cannot start or end with whitespace in the grammar, so
 * whitespace at a run's edges moves outside it (a bold space looks like a
 * plain one). A run of only whitespace is plain text.
 */
function wrapTrimmed(type: "strong" | "em", children: (StrongChild | ItalicChild)[]): MarkupNode[] {
  const body = children.map((c) => ({ ...c })) as (StrongChild | ItalicChild)[];
  let lead = "";
  let trail = "";
  while (body.length > 0 && body[0]!.type === "text") {
    const t = body[0] as TextNode;
    const kept = t.value.replace(/^\s+/, "");
    lead += t.value.slice(0, t.value.length - kept.length);
    if (kept) {
      body[0] = { type: "text", value: kept };
      break;
    }
    body.shift();
  }
  while (body.length > 0 && body[body.length - 1]!.type === "text") {
    const t = body[body.length - 1] as TextNode;
    const kept = t.value.replace(/\s+$/, "");
    trail = t.value.slice(kept.length) + trail;
    if (kept) {
      body[body.length - 1] = { type: "text", value: kept };
      break;
    }
    body.pop();
  }
  const out: MarkupNode[] = [];
  if (lead) out.push({ type: "text", value: lead });
  if (body.length > 0) {
    out.push(
      type === "strong"
        ? { type: "strong", children: body as StrongChild[] }
        : ({ type: "em", children: body as ItalicChild[] } satisfies EmNode),
    );
  }
  if (trail) out.push({ type: "text", value: trail });
  return out;
}

function escapeDollars(nodes: readonly MarkupNode[]): MarkupNode[] {
  const out: MarkupNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      node.value.split("$").forEach((part, i) => {
        if (i > 0) out.push({ type: "escape" });
        if (part) out.push({ type: "text", value: part });
      });
    } else if (node.type === "strong") {
      out.push({ type: "strong", children: escapeDollars(node.children) as StrongChild[] });
    } else if (node.type === "em") {
      out.push({ type: "em", children: escapeDollars(node.children) as ItalicChild[] });
    } else {
      out.push(node);
    }
  }
  return out;
}
