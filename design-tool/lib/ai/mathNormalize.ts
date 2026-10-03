// Finding BG-E1 (docs/batch-item-generation-design.md, slice 7): under rule
// M-1 a single `$` followed by a digit opens math only when the run up to the
// next single `$` holds a LaTeX command, `^` or `_` (lib/math/renderLatex.ts,
// lib/items/renderItemContent.ts, the client's page JS). The prompt rule in
// ./mathPromptRule.ts asks the model to write such math as `${...}$`, but on
// Bedrock it mostly does not, so `$5x + 3 = 28$` rendered as raw text. This
// rewrites those runs before validation, server-side, for AI proposals only.
//
// A run is rewritten to `${run}$` only when M-1 would leave it raw AND it
// looks like math rather than two dollar amounts: it starts with a digit, has
// no space at either end, no word of two or more letters, and ends in a
// letter, digit, `)` or `}`. "$5 to $10", "$5-$10" and "$3.50/$4" fail those
// tests and stay as dollar signs. Escaped `\$`, `$$` and `${` are untouched.

const COMMAND_RUN = /\\[a-zA-Z]|[\^_]/;
const WORD = /[A-Za-z]{2,}/;
const ENDS_LIKE_MATH = /[A-Za-z0-9)}]$/;

function isSingleDollar(text: string, i: number): boolean {
  return (
    text[i] === "$" &&
    text[i - 1] !== "\\" &&
    text[i - 1] !== "$" &&
    text[i + 1] !== "$"
  );
}

function looksLikeMath(run: string): boolean {
  return (
    /^\d/.test(run) &&
    run === run.trim() &&
    !WORD.test(run) &&
    ENDS_LIKE_MATH.test(run)
  );
}

/** Rewrite digit-led math that M-1 would leave raw into `${...}$`. */
export function normalizeDigitLedMath(text: string): string {
  if (!text.includes("$")) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (isSingleDollar(text, i) && /\d/.test(text[i + 1] ?? "")) {
      let j = i + 1;
      while (j < text.length && !isSingleDollar(text, j)) j++;
      if (j < text.length) {
        const run = text.slice(i + 1, j);
        if (!COMMAND_RUN.test(run) && looksLikeMath(run)) {
          out += `\${${run}}$`;
          i = j + 1;
          continue;
        }
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

/**
 * Apply normalizeDigitLedMath to the student-visible text of one proposed
 * item: the stem, every choice's text and both sides of every match pair.
 * Answer keys (correct_answer) are plain text and never touched. Returns a
 * new object; anything not shaped as expected passes through for the schema
 * to judge.
 */
export function normalizeProposalMath<T>(item: T): T {
  if (!item || typeof item !== "object") return item;
  const obj = { ...(item as Record<string, unknown>) };
  if (typeof obj.stem === "string") obj.stem = normalizeDigitLedMath(obj.stem);
  if (Array.isArray(obj.choices)) {
    obj.choices = obj.choices.map((c) =>
      c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
        ? { ...c, text: normalizeDigitLedMath((c as { text: string }).text) }
        : c,
    );
  }
  if (Array.isArray(obj.pairs)) {
    obj.pairs = obj.pairs.map((p) => {
      if (!p || typeof p !== "object") return p;
      const pair = { ...(p as Record<string, unknown>) };
      if (typeof pair.left === "string") pair.left = normalizeDigitLedMath(pair.left);
      if (typeof pair.right === "string") pair.right = normalizeDigitLedMath(pair.right);
      return pair;
    });
  }
  return obj as T;
}
