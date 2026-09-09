// Combined renderer for an item's stem / choice text. Walks the input
// in one pass, replacing `![alt](asset:<uuid>)` image refs with <img>
// tags and `$...$` / `$$...$$` math with KaTeX HTML; all other text is
// HTML-escaped. The image step is owner-scoped: a `resolved` Map of
// uuid → asset row is built by the caller via extractAssetRefs +
// extractAssetRefsFromMany + a single owner-filtered DB lookup. Anything
// not in the map renders as an inline-red `[image not found]`
// placeholder — that's the failure mode for refs to other users'
// assets or to deleted assets.

import katex from "katex";
import { escapeHtml } from "@/lib/escapeHtml";
import { K12_MACROS } from "@/lib/math/macros";

const IMG_RE =
  /!\[([^\]]*)\]\(asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

export interface ResolvedAsset {
  id: string;
  content_type: string;
}

function renderMath(tex: string, displayMode: boolean): string {
  // E16: fresh shallow copy per call — see the long note in
  // lib/math/renderLatex.ts. KaTeX mutates the macros object for user-defined
  // macros, so the frozen export throws on `\def` and a shared copy would leak
  // `\gdef` macros between stems.
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: false,
    errorColor: "#cc0000",
    macros: { ...K12_MACROS },
    output: "html",
    strict: "ignore",
  });
}

function renderImageRef(
  alt: string,
  id: string,
  resolved: Map<string, ResolvedAsset>,
): string {
  const lowerId = id.toLowerCase();
  const asset = resolved.get(lowerId);
  if (!asset) {
    return `<span class="image-missing">[image not found: ${escapeHtml(alt || lowerId)}]</span>`;
  }
  return (
    `<img class="item-image" src="/api/assets/${encodeURIComponent(lowerId)}" ` +
    `alt="${escapeHtml(alt)}" loading="lazy">`
  );
}

interface MathToken {
  kind: "math";
  value: string;
  displayMode: boolean;
}

interface TextToken {
  kind: "text";
  value: string;
}

type Token = MathToken | TextToken;

// Math tokenizer (copied logic from renderLatex.ts) — pulled in here so
// the whole content pipeline can be one pass without going through the
// public renderLatex API.
function tokenizeMath(input: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  let textStart = 0;
  const len = input.length;

  function pushText(end: number) {
    if (end > textStart) {
      const raw = input.slice(textStart, end);
      tokens.push({ kind: "text", value: raw.replace(/\\\$/g, "$") });
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

// E6 (decision James 2026-09-02): `**bold**` and `_italic_` in authored
// text — stems, choices, pairs, stimulus — rendered here for the editor
// preview, the print view and the scoring surfaces, and by the same rules
// in the client's page script (AssessmentPage.swift). Only ever applied to
// a text token, so math (`$a_b$`) and image refs are never touched. Guards
// keep ordinary text literal: an italic run opens at a word boundary and
// closes before one (snake_case and H_2O outside math stay as typed), a
// run is never empty, never starts or ends with whitespace, never crosses
// a newline, and a blank line of underscores or asterisks is not a run.
// Bold is parsed first with italic inside it; nothing else nests. No
// escape syntax yet — a literal `**` in prose is a known limitation.
const BOLD_RE = /\*\*([^*\s](?:[^*\n]*?[^*\s])?)\*\*/g;
const ITALIC_RE = /(^|[\s(\[{"'\u201c\u2018])_([^_\s](?:[^_\n]*?[^_\s])?)_(?=$|[\s.,;:!?)\]}"'\u201d\u2019])/g;

function renderItalic(text: string): string {
  let out = "";
  let last = 0;
  ITALIC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ITALIC_RE.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, m.index)) + escapeHtml(m[1]!) + "<em>" + escapeHtml(m[2]!) + "</em>";
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

/** HTML-escaped text with `**bold**` → <strong> and `_italic_` → <em>. */
export function renderEmphasis(text: string): string {
  let out = "";
  let last = 0;
  BOLD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BOLD_RE.exec(text)) !== null) {
    out += renderItalic(text.slice(last, m.index)) + "<strong>" + renderItalic(m[1]!) + "</strong>";
    last = m.index + m[0].length;
  }
  return out + renderItalic(text.slice(last));
}

function renderMathTokens(text: string): string {
  const tokens = tokenizeMath(text);
  return tokens
    .map((t) => {
      if (t.kind === "text") return renderEmphasis(t.value);
      try {
        return renderMath(t.value, t.displayMode);
      } catch {
        return `<span class="math-error">[${escapeHtml(t.value)}]</span>`;
      }
    })
    .join("");
}

export function renderItemContent(
  input: string,
  resolved: Map<string, ResolvedAsset>,
): string {
  if (typeof input !== "string" || input.length === 0) return "";

  // Single-pass: outer split on image refs, then math+text renderer on
  // each non-image segment. Image alt-text is rendered as HTML-escaped
  // (no math inside alt — keeps the substitution rules predictable).
  const parts: string[] = [];
  let cursor = 0;
  IMG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMG_RE.exec(input)) !== null) {
    const start = match.index;
    if (start > cursor) {
      parts.push(renderMathTokens(input.slice(cursor, start)));
    }
    parts.push(renderImageRef(match[1] ?? "", match[2]!, resolved));
    cursor = start + match[0].length;
  }
  if (cursor < input.length) {
    parts.push(renderMathTokens(input.slice(cursor)));
  }
  return parts.join("");
}
