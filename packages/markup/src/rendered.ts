// What a student SEES for parsed markup, as a small comparable tree: escapes
// folded into text, adjacent text merged, images resolved or reported missing.
// The golden fixtures (test/fixtures/golden.json) are written in this form, and
// the design tool's tests project BOTH renderers' output onto it — the
// server's HTML string and the client renderer's DOM — so one expected value
// holds all three (parser, server, client) to one behaviour.

import type { MarkupNode } from "./grammar";

export type RenderedNode =
  | string
  | { b: RenderedNode[] }
  | { i: RenderedNode[] }
  | { math: string }
  | { display: string }
  | { img: { alt: string; id: string } }
  /** `[image not found: <label>]` — the label is the alt text, or the id. */
  | { missing: string }
  | { blank: string };

export interface RenderedOptions {
  /** Whether an asset id (lowercase) resolves; absent means none do. */
  resolves?: (id: string) => boolean;
}

export function renderedForm(
  nodes: readonly MarkupNode[],
  options: RenderedOptions = {},
): RenderedNode[] {
  const resolves = options.resolves ?? (() => false);
  const out: RenderedNode[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (typeof prev === "string") out[out.length - 1] = prev + text;
    else out.push(text);
  };
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        pushText(node.value);
        break;
      case "escape":
        pushText("$");
        break;
      case "math":
        out.push(node.display ? { display: node.tex } : { math: node.tex });
        break;
      case "image": {
        const id = node.id.toLowerCase();
        out.push(resolves(id) ? { img: { alt: node.alt, id } } : { missing: node.alt || id });
        break;
      }
      case "blank":
        out.push({ blank: node.id });
        break;
      case "strong":
        out.push({ b: renderedForm(node.children, options) });
        break;
      case "em":
        out.push({ i: renderedForm(node.children, options) });
        break;
    }
  }
  return out;
}
