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
      // C-2 (docs/multi-source-stimulus-design.md): a single `$` whose next
      // character is a digit is a dollar amount, never a math opener — prose
      // like "$57,600 to $30,000" was rendering the run between two amounts
      // as math. `$$` display openers and `\$` are unchanged. An author who
      // wants math starting with a digit writes `${5x+3}$` or `$ 5x+3$`.
      if (!isDisplay && input[cursor + 1] !== undefined && input[cursor + 1]! >= "0" && input[cursor + 1]! <= "9") {
        cursor += 1;
        continue;
      }
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
