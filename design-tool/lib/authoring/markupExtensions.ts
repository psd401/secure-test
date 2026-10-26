import { Extension, Mark, Node, type Extensions } from "@tiptap/core";
import { history, redo, undo } from "@tiptap/pm/history";
import katex from "katex";
import { K12_MACROS } from "@/lib/math/macros";
import { MARKUP_MARK, MARKUP_NODE } from "./markupDoc";

// R-4 (docs/editor-redesign-design.md): the new editor's ProseMirror schema,
// as Tiptap (MIT core only) extensions. One node or mark per packages/markup
// AST construct and nothing else, so nothing the editor can hold is outside
// the stored grammar (lib/authoring/markupDoc.ts maps the two). No lists,
// headings, links or underline: Phase 6 adds new constructs to the grammar
// first. No input rules either — typing `**` or `$` stays the characters
// typed; formatting comes from the toolbar and Mod-B / Mod-I.
//
// Node views (KaTeX formulas, pictures, blank chips) only run in the browser;
// `getSchema(markupExtensions())` is pure, which is what the round-trip tests
// use.

export interface MarkupExtensionOptions {
  /** The `<img src>` for an asset id (assessment-scoped, G-1). */
  assetUrl?: (id: string) => string;
  /** A choice field: Enter inserts nothing (the current editor's choice is a one-line input). */
  singleLine?: boolean;
}

export function renderTex(tex: string, display: boolean): string {
  try {
    // Same options as lib/math/renderLatex.ts (fresh macros copy, E16; trust
    // explicit, GHSA-238p-pmpm-9mq7).
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      errorColor: "#cc0000",
      macros: { ...K12_MACROS },
      output: "html",
      strict: "ignore",
      trust: false,
    });
  } catch {
    return "";
  }
}

const Doc = Node.create({
  name: MARKUP_NODE.doc,
  topNode: true,
  // One paragraph: a stored field is one inline string.
  content: MARKUP_NODE.paragraph,
});

const Paragraph = Node.create({
  name: MARKUP_NODE.paragraph,
  content: "inline*",
  parseHTML: () => [{ tag: "p" }],
  renderHTML: () => ["p", 0],
});

const Text = Node.create({ name: MARKUP_NODE.text, group: "inline" });

const HardBreak = Node.create({
  name: MARKUP_NODE.hardBreak,
  inline: true,
  group: "inline",
  selectable: false,
  parseHTML: () => [{ tag: "br" }],
  renderHTML: () => ["br"],
  renderText: () => "\n",
});

const Strong = Mark.create({
  name: MARKUP_MARK.strong,
  parseHTML: () => [{ tag: "strong" }],
  renderHTML: () => ["strong", 0],
  addKeyboardShortcuts() {
    return { "Mod-b": () => this.editor.commands.toggleMark(this.name) };
  },
});

const Em = Mark.create({
  name: MARKUP_MARK.em,
  parseHTML: () => [{ tag: "em" }],
  renderHTML: () => ["em", 0],
  addKeyboardShortcuts() {
    return { "Mod-i": () => this.editor.commands.toggleMark(this.name) };
  },
});

/** `\$` from stored markup: shows "$", saves as `\$`. A typed "$" is text. */
const EscapedDollar = Node.create({
  name: MARKUP_NODE.dollar,
  inline: true,
  group: "inline",
  atom: true,
  selectable: false,
  parseHTML: () => [{ tag: "span[data-dollar]" }],
  renderHTML: () => ["span", { "data-dollar": "" }, "$"],
  renderText: () => "$",
});

const Blank = Node.create({
  name: MARKUP_NODE.blank,
  inline: true,
  group: "inline",
  atom: true,
  addAttributes: () => ({
    id: {
      default: "",
      parseHTML: (el) => el.getAttribute("data-blank") ?? "",
      renderHTML: (attrs) => ({ "data-blank": attrs.id }),
    },
  }),
  parseHTML: () => [{ tag: "span[data-blank]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "span",
    { ...HTMLAttributes, class: "rt-blank", contenteditable: "false" },
    "blank",
  ],
  renderText: ({ node }) => `[[${node.attrs.id}]]`,
});

const MathNode = Node.create({
  name: MARKUP_NODE.math,
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  addAttributes: () => ({
    tex: {
      default: "",
      parseHTML: (el) => el.getAttribute("data-tex") ?? "",
      renderHTML: (attrs) => ({ "data-tex": attrs.tex }),
    },
    display: {
      default: false,
      parseHTML: (el) => el.getAttribute("data-display") === "true",
      renderHTML: (attrs) => ({ "data-display": String(attrs.display === true) }),
    },
  }),
  parseHTML: () => [{ tag: "span[data-math]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", { ...HTMLAttributes, "data-math": "" }],
  renderText: ({ node }) => (node.attrs.display ? `$$${node.attrs.tex}$$` : `$${node.attrs.tex}$`),
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = node.attrs.display ? "rt-math rt-math-display" : "rt-math";
      dom.contentEditable = "false";
      dom.setAttribute("data-math", "");
      // renderToString escapes the TeX and trust is off — no markup injection.
      dom.innerHTML = renderTex(String(node.attrs.tex), node.attrs.display === true);
      dom.title = "Formula — click to edit";
      return { dom };
    };
  },
});

const ImageNode = Node.create<Pick<MarkupExtensionOptions, "assetUrl">>({
  name: MARKUP_NODE.image,
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  addOptions: () => ({ assetUrl: undefined }),
  addAttributes: () => ({
    alt: {
      default: "",
      parseHTML: (el) => el.getAttribute("alt") ?? "",
      renderHTML: (attrs) => ({ alt: attrs.alt }),
    },
    id: {
      default: "",
      parseHTML: (el) => el.getAttribute("data-asset-id") ?? "",
      renderHTML: (attrs) => ({ "data-asset-id": attrs.id }),
    },
    scheme: {
      default: null,
      parseHTML: (el) => el.getAttribute("data-scheme"),
      renderHTML: (attrs) => (attrs.scheme ? { "data-scheme": attrs.scheme } : {}),
    },
  }),
  parseHTML: () => [{ tag: "img[data-asset-id]" }],
  renderHTML: ({ HTMLAttributes }) => ["img", HTMLAttributes],
  renderText: ({ node }) => `![${node.attrs.alt}](${node.attrs.scheme ?? "asset"}:${node.attrs.id})`,
  addNodeView() {
    const assetUrl = this.options.assetUrl;
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "rt-image";
      dom.contentEditable = "false";
      const id = String(node.attrs.id).toLowerCase();
      const alt = String(node.attrs.alt);
      const label = () => {
        dom.textContent = `[picture: ${alt || id}]`;
        dom.classList.add("rt-image-missing");
      };
      if (assetUrl) {
        const img = document.createElement("img");
        img.src = assetUrl(id);
        img.alt = alt;
        img.onerror = label;
        dom.appendChild(img);
      } else {
        label();
      }
      return { dom };
    };
  },
});

const Behaviour = Extension.create<Pick<MarkupExtensionOptions, "singleLine">>({
  name: "markupBehaviour",
  priority: 1000,
  addOptions: () => ({ singleLine: false }),
  addKeyboardShortcuts() {
    const newline = () =>
      this.options.singleLine ? true : this.editor.commands.insertContent({ type: MARKUP_NODE.hardBreak });
    return {
      Enter: newline,
      "Shift-Enter": newline,
      "Mod-z": () => undo(this.editor.state, this.editor.view.dispatch),
      "Mod-Shift-z": () => redo(this.editor.state, this.editor.view.dispatch),
      "Mod-y": () => redo(this.editor.state, this.editor.view.dispatch),
    };
  },
  addProseMirrorPlugins: () => [history()],
});

export function markupExtensions(options: MarkupExtensionOptions = {}): Extensions {
  return [
    Doc,
    Paragraph,
    Text,
    HardBreak,
    // Mark order is schema rank: strong before em, as markupDoc writes them.
    Strong,
    Em,
    EscapedDollar,
    Blank,
    MathNode,
    ImageNode.configure({ assetUrl: options.assetUrl }),
    Behaviour.configure({ singleLine: options.singleLine ?? false }),
  ];
}
