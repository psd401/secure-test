// Bridge mode (docs/server-delivered-renderer-design.md D-9): until slice 5
// moves the page code here, the served renderer is EXTRACTED from the
// client's Swift string literals, so it is byte-identical to the page a v1.x
// client builds at run time.
//
// This is not a Swift parser. It reads `static let <name> = """ … """` and
// `static let <name> = #""" … """#` declarations and implements exactly the
// literal semantics those declarations use — and refuses everything else, so
// a construct it does not understand fails the build instead of shipping a
// renderer that differs from the bundled one:
//
// - Multi-line literals only. The opening delimiter ends its line; the
//   closing delimiter stands alone on its line, and its leading spaces are
//   the indentation stripped from every content line. A content line must
//   start with that indentation or be completely empty (Swift's own rule —
//   a shorter whitespace-only line is a compile error there, and here). The
//   newline before the closing delimiter is not part of the value.
// - Raw literals (`#"""`, any number of `#`): `\` is literal except before
//   the matching number of `#`. Supported: `\#(name)` interpolation of
//   another extracted literal, spliced verbatim (cycles refused). Any other
//   `\#` escape is refused.
// - Plain literals (`"""`): the escapes `\\`, `\"`, `\'`, `\n`, `\t`, `\r`,
//   `\0` and `\u{…}`. Refused: `\(…)` interpolation, an escaped newline (line
//   continuation), and any other escape.
// - Refused anywhere: CR characters, tab indentation, a closing delimiter
//   sequence inside the content, an unterminated literal, a name declared
//   twice across the files read together.
//
// `scripts/check-extraction.sh` proves the result against Swift itself
// (macOS): it compiles SecureTestCore and compares SHA-256s.

export type SwiftLiteral = {
  name: string;
  file: string;
  /** 1-based line of the `static let`. */
  line: number;
  /** Number of `#` around the delimiters; 0 = a plain literal. */
  hashes: number;
  /** The content after indentation stripping, escapes NOT yet processed. */
  body: string;
};

const OPEN_RE =
  /^[ ]*(?:(?:public|internal|fileprivate|private)[ ]+)?static[ ]+let[ ]+([A-Za-z_][A-Za-z0-9_]*)(?:[ ]*:[ ]*String)?[ ]*=[ ]*(#*)"""[ ]*$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Every multi-line `static let` string literal in one Swift source file. */
export function findStringLiterals(source: string, file: string): SwiftLiteral[] {
  if (source.includes("\r")) throw new Error(`${file}: CR characters are not supported`);
  const lines = source.split("\n");
  const out: SwiftLiteral[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN_RE.exec(lines[i]!);
    if (!open) continue;
    const name = open[1]!;
    const hashes = open[2]!.length;
    const closing = `"""${"#".repeat(hashes)}`;
    const closeRe = new RegExp(`^([ \\t]*)${closing}[ ]*$`);
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closeRe.test(lines[j]!)) {
        end = j;
        break;
      }
      if (lines[j]!.includes(closing)) {
        throw new Error(
          `${file}:${j + 1}: ${closing} inside the content of ${name} (an early close) is not supported`,
        );
      }
    }
    if (end < 0) throw new Error(`${file}:${i + 1}: ${name} has no closing ${closing}`);
    const indent = closeRe.exec(lines[end]!)![1]!;
    if (indent.includes("\t")) {
      throw new Error(`${file}:${end + 1}: tab indentation of ${name} is not supported`);
    }
    const content = lines.slice(i + 1, end).map((line, k) => {
      if (line.startsWith(indent)) return line.slice(indent.length);
      if (line === "") return "";
      throw new Error(
        `${file}:${i + 2 + k}: insufficient indentation in ${name} (Swift refuses this line too)`,
      );
    });
    out.push({ name, file, line: i + 1, hashes, body: content.join("\n") });
    i = end;
  }
  return out;
}

/** The literals of several files, keyed by name; a repeated name throws. */
export function collectLiterals(
  sources: readonly { file: string; source: string }[],
): Map<string, SwiftLiteral> {
  const map = new Map<string, SwiftLiteral>();
  for (const { file, source } of sources) {
    for (const lit of findStringLiterals(source, file)) {
      const prior = map.get(lit.name);
      if (prior) {
        throw new Error(
          `${lit.name} is declared twice (${prior.file}:${prior.line} and ${file}:${lit.line})`,
        );
      }
      map.set(lit.name, lit);
    }
  }
  return map;
}

/** The run-time value of literal `name`, interpolations resolved. */
export function resolveLiteral(
  name: string,
  literals: ReadonlyMap<string, SwiftLiteral>,
  stack: readonly string[] = [],
): string {
  if (stack.includes(name)) {
    throw new Error(`interpolation cycle: ${[...stack, name].join(" → ")}`);
  }
  const lit = literals.get(name);
  if (!lit) {
    throw new Error(
      stack.length
        ? `${stack[stack.length - 1]} interpolates ${name}, which is not an extracted multi-line literal`
        : `no multi-line string literal named ${name}`,
    );
  }
  const where = `${lit.file}:${lit.line} (${name})`;
  return lit.hashes > 0
    ? processRaw(lit.body, lit.hashes, where, (inner) =>
        resolveLiteral(inner, literals, [...stack, name]),
      )
    : processPlain(lit.body, where);
}

function processRaw(
  body: string,
  hashes: number,
  where: string,
  interpolate: (name: string) => string,
): string {
  const escape = `\\${"#".repeat(hashes)}`;
  let out = "";
  let i = 0;
  for (;;) {
    const at = body.indexOf(escape, i);
    if (at < 0) return out + body.slice(i);
    out += body.slice(i, at);
    const after = at + escape.length;
    // `\##` with one-hash delimiters is still an escape (`\#` then `#`), and
    // nothing here needs one — refuse rather than guess.
    if (body[after] !== "(") {
      throw new Error(
        `${where}: escape ${JSON.stringify(body.slice(at, after + 1))} is not supported (only ${escape}(name))`,
      );
    }
    const close = body.indexOf(")", after);
    const inner = close < 0 ? "" : body.slice(after + 1, close);
    if (!IDENT_RE.test(inner)) {
      throw new Error(
        `${where}: interpolation ${JSON.stringify(body.slice(at, close < 0 ? after + 20 : close + 1))} is not a bare literal name`,
      );
    }
    out += interpolate(inner);
    i = close + 1;
  }
}

const SIMPLE_ESCAPES: Record<string, string> = {
  "\\": "\\",
  '"': '"',
  "'": "'",
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
};

function processPlain(body: string, where: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next !== undefined && next in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[next]!;
      i += 1;
      continue;
    }
    if (next === "u") {
      const m = /^\{([0-9A-Fa-f]{1,8})\}/.exec(body.slice(i + 2));
      if (!m) throw new Error(`${where}: malformed \\u{…} escape`);
      out += String.fromCodePoint(parseInt(m[1]!, 16));
      i += 1 + m[0].length;
      continue;
    }
    if (next === "(") throw new Error(`${where}: \\( interpolation in a plain literal is not supported`);
    if (next === undefined || next === "\n" || next === " ") {
      throw new Error(`${where}: an escaped newline (line continuation) is not supported`);
    }
    throw new Error(`${where}: escape \\${next} is not supported`);
  }
  return out;
}

// ---------- the renderer's own composition ----------

/** Client sources the renderer is extracted from, relative to the repo root. */
export const CLIENT_SOURCES = [
  "client/SecureTestCore/Sources/SecureTestCore/AssessmentPage.swift",
  "client/SecureTestCore/Sources/SecureTestCore/AssessmentPageRichText.swift",
] as const;

/**
 * renderer.js = `AssessmentPage.rendererScript` (with `mathPassFunctions` and
 * `richTextFunctions` spliced in, as Swift does).
 * renderer.css = `itemStyles + "\n" + richTextStyles`. The page inlines those
 * two as SEPARATE `<style>` elements (`PageShell.document` joins its style
 * blocks with "\n"); the served file is their concatenation with one newline,
 * and the v2.0 shell inlines it as ONE style element. Equivalent CSS: neither
 * sheet carries an @import / @charset that would care which element it is in.
 */
export function extractRenderer(
  sources: readonly { file: string; source: string }[],
): { js: string; css: string } {
  const literals = collectLiterals(sources);
  const js = resolveLiteral("rendererScript", literals);
  const css = `${resolveLiteral("itemStyles", literals)}\n${resolveLiteral("richTextStyles", literals)}`;
  return { js, css };
}
