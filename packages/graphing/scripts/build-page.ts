// `bun run build:page` — builds the calculator for the student test page
// and writes it into the client as a Swift raw string literal
// (docs/graphing-calculator-design.md D-3):
//
//   client/SecureTestCore/Sources/SecureTestCore/GeneratedGraphing.swift
//     static let graphingScript = ##""" … """##
//
// `AssessmentPage.rendererScript` splices it with \#(graphingScript), so the
// page a v1.x shell builds and the renderer.js the server signs (bridge
// mode, packages/renderer) both carry it, and check-extraction.sh proves
// them equal as before.
//
// What the literal holds: the licence notices, then ONE function,
// `__secureTestGraphing()`, whose body is the minified bundle of
// src/page.ts (our engine and UI plus MathLive). Nothing runs until the page
// calls it — MathLive's top level needs `navigator` and `HTMLElement`, which
// the JSC test harness lacks.
//
// The page inlines its script, so the text must never contain `</` (the
// renderer build and the v2.0 shell both refuse it). MathLive has ~250, in
// strings, templates and regular expressions. Each is rewritten by its
// token's kind — `<\/` inside a string, template or regex (the same value),
// `< /` between two tokens (a less-than before a regex) — using acorn's
// tokenizer, and the result is re-parsed to prove it is still the same
// program.
//
// The Swift package never runs bun; the generated file is checked in.
// Re-run after any change under src/ or a mathlive bump.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, tokenizer, type Token } from "acorn";

const ROOT = resolve(import.meta.dir, "..");
const REPO = resolve(ROOT, "..", "..");
export const OUT = join(REPO, "client", "SecureTestCore", "Sources", "SecureTestCore", "GeneratedGraphing.swift");

/** Every `</` made safe for an inline <script>, by the kind of token it is in. */
export function escapeCloseTags(js: string): string {
  const at: number[] = [];
  for (let i = js.indexOf("</"); i >= 0; i = js.indexOf("</", i + 1)) at.push(i);
  if (at.length === 0) return js;
  const tokens: Token[] = [...tokenizer(js, { ecmaVersion: "latest", sourceType: "script" })];
  const edits: { pos: number; insert: string; remove?: number; text?: string }[] = [];
  let t = 0;
  for (const i of at) {
    while (t < tokens.length && tokens[t]!.end <= i) t++;
    const tok = tokens[t];
    if (tok && tok.start <= i && i + 2 <= tok.end) {
      const kind = tok.type.label;
      if (kind === "regexp") {
        // In a regex the `/` may be its closing delimiter (`/</g`), which
        // can't be escaped; write the `<` as \x3c instead (`\<` too).
        if (js[i - 1] === "\\") edits.push({ pos: i - 1, insert: "", remove: 2, text: "\\x3c" });
        else edits.push({ pos: i, insert: "", remove: 1, text: "\\x3c" });
      } else if (kind === "string" || kind === "template" || kind === "invalidTemplate") {
        // `\/` means `/` in a string or template.
        edits.push({ pos: i + 1, insert: "\\" });
      } else {
        throw new Error(`</ inside a ${kind} token at ${i}`);
      }
    } else if (tok && tok.start === i && js[i + 1] === "/") {
      // `<` then a token starting with `/` (a regex): separate them.
      edits.push({ pos: i + 1, insert: " " });
    } else {
      throw new Error(`</ at ${i} is not in a string, template or regex, nor a less-than before one`);
    }
  }
  let out = "";
  let last = 0;
  for (const e of edits) {
    out += js.slice(last, e.pos) + (e.text ?? e.insert);
    last = e.pos + (e.remove ?? 0);
  }
  return out + js.slice(last);
}

/** The program's tokens with the escape differences normalised away. */
function shape(js: string): string[] {
  return [...tokenizer(js, { ecmaVersion: "latest", sourceType: "script" })].map((tok) => {
    const v = (tok as unknown as { value: unknown }).value;
    if (tok.type.label === "regexp") {
      const r = v as { pattern: string; flags: string };
      return `regexp:${r.pattern.replaceAll("\\x3c", "<").replaceAll("\\<", "<")}/${r.flags}`;
    }
    return `${tok.type.label}:${typeof v === "string" ? v : String(v ?? "")}`;
  });
}

/** A raw-string delimiter count whose `"""#…` and `\#…` don't occur in `text`. */
export function hashesFor(text: string): number {
  for (let n = 1; n < 8; n++) {
    const h = "#".repeat(n);
    if (!text.includes(`"""${h}`) && !text.includes(`\\${h}`)) return n;
  }
  throw new Error("no safe raw-string delimiter");
}

const OUR_NOTICE = `SecureTest graphing calculator (packages/graphing) — MIT License.
Copyright (c) 2026 Peninsula School District (PSD401).
See the repository's LICENSE for the full text.`;

export async function buildPageScript(): Promise<string> {
  const out = await Bun.build({
    entrypoints: [join(ROOT, "src", "page.ts")],
    target: "browser",
    format: "iife",
    minify: true,
  });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  const bundle = await out.outputs[0]!.text();
  const safe = escapeCloseTags(bundle);
  if (safe.includes("</")) throw new Error("</ survived the rewrite");
  const before = shape(bundle);
  const after = shape(safe);
  if (before.length !== after.length || before.some((t, i) => t !== after[i])) {
    throw new Error("the </ rewrite changed the program");
  }
  // Parse the result as a whole too: a syntax error anywhere fails the build.
  Parser.parse(safe, { ecmaVersion: "latest", sourceType: "script" });

  const mathliveDir = dirname(fileURLToPath(import.meta.resolve("mathlive")));
  const mathliveLicense = readFileSync(join(mathliveDir, "LICENSE.txt"), "utf8").trim();
  const notice = (title: string, text: string) => `/*! ${title}\n${text.replaceAll("*/", "* /")}\n*/`;
  const wrapper = [
    notice("SecureTest graphing calculator", OUR_NOTICE),
    notice("MathLive 0.111.1 — https://github.com/arnog/mathlive", mathliveLicense),
    "function __secureTestGraphing() {",
    "  if (__secureTestGraphing.loaded) return __secureTestGraphing.loaded;",
    "  var __gcOut;",
    safe.trim(),
    "  __secureTestGraphing.loaded = __gcOut;",
    "  return __gcOut;",
    "}",
  ].join("\n");
  if (wrapper.includes("</")) throw new Error("a licence notice contains </");
  // `<!--` then `<script` inside an inline script switches the HTML parser
  // into its double-escaped state; refuse both rather than reason about it.
  if (wrapper.includes("<!--") || /<script/i.test(wrapper)) throw new Error("<!-- or <script in the page script");
  if (wrapper.includes("\r")) throw new Error("CR in the page script");
  return wrapper;
}

export function swiftFile(script: string): string {
  const h = "#".repeat(hashesFor(script));
  const body = script
    .split("\n")
    .map((l) => (l === "" ? "" : `    ${l}`))
    .join("\n");
  return `// Auto-generated by packages/graphing/scripts/build-page.ts. Do not edit by hand.
// The graphing calculator for the test page (docs/graphing-calculator-design.md
// D-3): licence notices, then __secureTestGraphing(), called only when a
// student first opens the calculator. Regenerate with:
//   cd packages/graphing && bun run build:page

extension AssessmentPage {
    static let graphingScript = ${h}"""
${body}
    """${h}
}
`;
}

if (import.meta.main) {
  const script = await buildPageScript();
  writeFileSync(OUT, swiftFile(script));
  console.log(`wrote ${OUT} (${(script.length / 1024).toFixed(0)} KB)`);
}
