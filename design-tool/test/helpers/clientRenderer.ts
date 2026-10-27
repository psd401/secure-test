// The client renderer, run headlessly from bun (R-2, editor redesign Phase 1).
//
// What runs is the bridge-mode `renderer.js` — the same bytes
// packages/renderer's build serves (extracted from the client's Swift
// literals by scripts/extract-swift.ts, the build's own extractor) — against
// the DOM shim of the client's existing JavaScriptCore harness
// (`RendererHarness.domShim` in client/SecureTestCore/Tests/…/RendererHarness.swift,
// read out of the Swift source by the same extractor), in a fresh node:vm
// context. bun's engine is JavaScriptCore, so this is the shim and the
// renderer the Swift suites run, on the same engine, without Xcode; headless
// Chrome hangs on this Mac (ADR 0013).
//
// KaTeX is not loaded: a stub `katex.render` marks each formula's span with
// its TeX and display flag, so the math pass's TOKENIZING is observable
// without comparing KaTeX's own markup (which is the same library on both
// sides).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import type { RenderedNode } from "../../../packages/markup/src";
import {
  CLIENT_SOURCES,
  collectLiterals,
  extractRenderer,
  resolveLiteral,
} from "../../../packages/renderer/scripts/extract-swift";

const REPO = join(import.meta.dir, "..", "..", "..");
const HARNESS_SWIFT = "client/SecureTestCore/Tests/SecureTestCoreTests/RendererHarness.swift";

let cached: { js: string; shim: string } | null = null;
function sources() {
  if (cached) return cached;
  const read = (file: string) => ({ file, source: readFileSync(join(REPO, file), "utf8") });
  const { js } = extractRenderer(CLIENT_SOURCES.map(read));
  const shim = resolveLiteral("domShim", collectLiterals([read(HARNESS_SWIFT)]));
  cached = { js, shim };
  return cached;
}

const KATEX_STUB = `
var katex = {
  render: function (tex, el, opts) {
    el.className = 'katex-stub';
    el.setAttribute('data-tex', tex);
    el.setAttribute('data-display', opts && opts.displayMode ? '1' : '0');
  }
};
var KATEX_MACROS = {};
`;

// The client tree → RenderedNode (packages/markup/src/rendered.ts). Anything
// the walker does not know is reported as {unknown}, so a new element shows up
// as a mismatch rather than vanishing.
const NORMALIZE = `
function __rendered(node, blankIds) {
  var out = [];
  function text(t) {
    if (!t) return;
    if (typeof out[out.length - 1] === 'string') out[out.length - 1] += t;
    else out.push(t);
  }
  node.children.forEach(function (c) {
    if (c.tagName === '#text') text(c.textContent);
    else if (c.tagName === 'strong') out.push({ b: __rendered(c, blankIds) });
    else if (c.tagName === 'em') out.push({ i: __rendered(c, blankIds) });
    else if (c.className === 'katex-stub') {
      var tex = c.getAttribute('data-tex');
      out.push(c.getAttribute('data-display') === '1' ? { display: tex } : { math: tex });
    } else if (c.tagName === 'img') {
      var hex = String(c.src).split('base64,')[1] || '';
      var id = hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
      out.push({ img: { alt: c.alt, id: id } });
    } else if (c.className === 'missing-asset') {
      out.push({ missing: c.textContent.replace(/^\\[image not found: /, '').replace(/\\]$/, '') });
    } else if (c.tagName === 'input' && c.className === 'fill-text') {
      var n = Number(String(c.getAttribute('aria-label')).replace('Blank ', ''));
      out.push({ blank: blankIds[n - 1] });
    } else out.push({ unknown: c.tagName + '.' + c.className });
  });
  return out;
}
`;

export interface ClientStem {
  markup: string;
  /** Render as a fill-in-the-blank stem with a text blank per marker id. */
  blanks?: boolean;
}

const MARKER_RE = /\[\[([A-Za-z0-9_-]{1,40})\]\]/g;

/** Distinct marker ids in order of first appearance — the client's numbering. */
export function markerIds(stem: string): string[] {
  return [...new Set([...stem.matchAll(MARKER_RE)].map((m) => m[1]!))];
}

/**
 * Renders every stem as one item of one bundle (one renderer run) and returns
 * each stem's tree in rendered form, plus the blank rows the client placed
 * after a sentence (a blank whose marker it could not place inline).
 */
export function renderStemsInClient(
  stems: readonly ClientStem[],
  resolvedIds: readonly string[],
): { dom: RenderedNode[]; unplaced: number }[] {
  // The shim's selectors walk the whole tree, so one bundle per few hundred
  // stems keeps a long run linear.
  const out: { dom: RenderedNode[]; unplaced: number }[] = [];
  for (let at = 0; at < stems.length; at += 300) {
    out.push(...renderBundle(stems.slice(at, at + 300), resolvedIds));
  }
  return out;
}

function renderBundle(
  stems: readonly ClientStem[],
  resolvedIds: readonly string[],
): { dom: RenderedNode[]; unplaced: number }[] {
  const { js, shim } = sources();
  const items = stems.map((s, k) =>
    s.blanks
      ? {
          type: "fill_blank",
          id: `q${k}`,
          stem: s.markup,
          blanks: markerIds(s.markup).map((id) => ({ id, kind: "text" })),
        }
      : {
          type: "multiple_choice_single",
          id: `q${k}`,
          stem: s.markup,
          choices: [{ id: "a", text: "A" }],
        },
  );
  const assets = Object.fromEntries(
    resolvedIds.map((id) => [id, { content_type: "image/png", base64: id.replace(/-/g, "") }]),
  );
  const bundle = { test_id: "markup-golden", title: "Markup golden", items, item_sets: [], assets, accommodations: {} };
  const context = vm.createContext({});
  vm.runInContext(shim, context);
  vm.runInContext(`var BUNDLE = ${JSON.stringify(bundle)}; var OFFLINE = false;`, context);
  vm.runInContext(KATEX_STUB + NORMALIZE, context);
  vm.runInContext(js, context);
  const ids = JSON.stringify(stems.map((s) => (s.blanks ? markerIds(s.markup) : [])));
  const out = vm.runInContext(
    `JSON.stringify(${ids}.map(function (blankIds, k) {
       var item = __item(k);
       return { dom: __rendered(__first('.stem', item), blankIds), unplaced: __count('.fill-unplaced', item) };
     }))`,
    context,
  ) as string;
  return JSON.parse(out);
}
