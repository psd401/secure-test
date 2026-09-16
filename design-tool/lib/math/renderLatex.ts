import katex from "katex";
import { escapeHtml } from "@/lib/escapeHtml";
import { K12_MACROS } from "./macros";

// renderLatex walks plain text containing `$...$` (inline) and `$$...$$`
// (display) LaTeX delimiters and returns HTML with the math segments
// SSR-rendered via KaTeX. Non-math text is HTML-escaped. Bad LaTeX is
// rendered in red via KaTeX's errorColor option (no exception thrown).
//
// Delimiters: standard LaTeX `$` / `$$` per ADR 0009. Backslash-escaped
// dollars (`\$`) are passed through as literal `$` after escape removal.

function renderMath(tex: string, displayMode: boolean): string {
  // KaTeX renders broken expressions in red when throwOnError is false
  // and errorColor is set. The matching CSS spans are produced inline
  // and styled via the bundled KaTeX stylesheet (inlined into the
  // preview HTML's <style> block, and into the editor via globals.css).
  //
  // E16: a FRESH SHALLOW COPY per call, never K12_MACROS itself. KaTeX writes
  // user-defined macros straight into whatever object it is handed, so:
  //   - passing the frozen export makes any `\def` / `\gdef` / `\newcommand`
  //     stem throw "Attempting to define property on object that is not
  //     extensible" (verified against this repo's katex 0.18.4). That
  //     TypeError is NOT covered by throwOnError:false, so the stem renders as
  //     an error instead of math — while PoC-B's fresh-object path renders it
  //     fine, re-introducing exactly the renderer drift slice 16 removed.
  //   - a single shared mutable copy would be worse: `\gdef` in one stem
  //     would leak that macro into every later stem in the process.
  // Keeping the export frozen is correct; copy at the boundary.
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: false,
    errorColor: "#cc0000",
    macros: { ...K12_MACROS },
    output: "html",
    strict: "ignore",
  });
}

// C-2 (docs/multi-source-stimulus-design.md) as refined by M-1
// (docs/roadmap-2026-09.md, 2026-09-16): a single `$` whose next character is
// a digit opens math ONLY when a matching single `$` exists AND the run
// between the delimiters carries a math marker — a LaTeX command (`\` plus a
// letter), `^`, or `_`. Otherwise the `$` is a dollar sign and stays text, so
// prose like "$57,600 to $30,000" never renders as math, while `$6 \times 7$`
// and `$3.5 \times 10^{4}$` (the shape the importer prompt asks the model to
// write) do. `$$` display openers and `\$` escapes are unchanged.
const MATH_MARKER_RE = /\\[a-zA-Z]|[\^_]/;

function digitOpenerHasMathMarker(
  input: string,
  openAt: number,
  closeAt: number,
): boolean {
  return MATH_MARKER_RE.test(input.slice(openAt + 1, closeAt));
}

interface Token {
  kind: "text" | "math";
  value: string;
  displayMode: boolean;
}

// Single-pass tokenizer that splits a string into text / math runs.
// Respects backslash-escaped `\$`. `$$` is preferred over `$` when both
// match, so `$$x$$` parses as one display block, not two empty inlines.
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  let textStart = 0;
  const len = input.length;

  function pushText(end: number) {
    if (end > textStart) {
      const raw = input.slice(textStart, end);
      tokens.push({
        kind: "text",
        value: raw.replace(/\\\$/g, "$"),
        displayMode: false,
      });
    }
  }

  while (cursor < len) {
    const ch = input[cursor];
    if (ch === "\\" && input[cursor + 1] === "$") {
      cursor += 2;
      continue;
    }
    if (ch === "$") {
      const isDisplay = input[cursor + 1] === "$";
      const next = input[cursor + 1];
      const digitOpener =
        !isDisplay && next !== undefined && next >= "0" && next <= "9";
      const openLen = isDisplay ? 2 : 1;
      // Find the matching close, skipping backslash-escaped dollars.
      let scan = cursor + openLen;
      let closeAt = -1;
      while (scan < len) {
        if (input[scan] === "\\" && input[scan + 1] === "$") {
          scan += 2;
          continue;
        }
        if (input[scan] === "$") {
          if (isDisplay) {
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
        // Unterminated delimiter — leave the rest as text.
        cursor += 1;
        continue;
      }
      // C-2 / M-1: a digit opener needs a math marker inside the run, or the
      // `$` is a dollar sign (see digitOpenerHasMathMarker above).
      if (digitOpener && !digitOpenerHasMathMarker(input, cursor, closeAt)) {
        cursor += 1;
        continue;
      }
      pushText(cursor);
      const inner = input.slice(cursor + openLen, closeAt);
      tokens.push({ kind: "math", value: inner, displayMode: isDisplay });
      cursor = closeAt + openLen;
      textStart = cursor;
      continue;
    }
    cursor += 1;
  }
  pushText(len);
  return tokens;
}

export function renderLatex(input: string): string {
  if (typeof input !== "string" || input.length === 0) return "";
  const tokens = tokenize(input);
  return tokens
    .map((t) => {
      if (t.kind === "text") return escapeHtml(t.value);
      try {
        return renderMath(t.value, t.displayMode);
      } catch (err) {
        const message = err instanceof Error ? err.message : "math error";
        return `<span class="math-error" title="${escapeHtml(message)}">[${escapeHtml(t.value)}]</span>`;
      }
    })
    .join("");
}

export { K12_MACROS };
