import type { ItemResponse } from "@secure-test/schema";
import type { ItemRow } from "@/db/schema";

// Slice 37: pure auto-scoring for the objectively markable types. Policy
// defaults resolved in docs/phase-3-slices.md ("Open policy decisions"):
//   - MC multi is exact-set, all-or-nothing (partial credit would change
//     the score shape; revisit only with a real request).
//   - short_text is normalized exact match — trim, collapse internal
//     whitespace, case-fold. Nothing fuzzier: fuzzy belongs to the ai
//     method, not auto.
// Every scorable item is worth 1 point in this slice; per-item point
// weights are a later feature and would live in items.config.
//
// Returns null when the (item, response) pair is not auto-scorable —
// essay items, items missing an answer key, or a response whose type
// doesn't match the item's (defensive: the write boundary should prevent
// that, but scoring must not crash on bad rows). Callers count nulls as
// "skipped", they are not zero scores.

export type AutoScoreResult = {
  points: number;
  max_points: number;
};

export function normalizeShortText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

// E7(b) (2026-09-02): a formula-aware student can type `H_2O`, `x^2`,
// `10^{-4}` or paste `$\mathrm{H_2O}$`, and E7(a) left keys as plain text
// (`H2O`, `45`). Rule (James, 2026-09-02, "plain or folded"): the plain
// comparison above decides first, unchanged ("cell wall" ≠ "cellwall"
// still); only when it fails AND either side carries formula markup are
// both sides folded and compared again. Folding: `$` delimiters go;
// `\mathrm{…}` / `\text{…}` / `\mathit{…}` unwrap; braces and TeX spacing
// go; all whitespace goes; and `_` goes, because a subscript reads the
// same inline (H_2O ≡ H2O, x_1 ≡ x1). `^` STAYS — an exponent changes the
// value (10^4 ≠ 104). Because the plain match is tried first, a stray
// underscore in a prose answer ("cell _wall_") can only ever add a match,
// never take one away.
//
// Roadmap 4b slice 1a (2026-09-08, docs/math-entry-design.md): the client
// grows a math keypad whose keys insert the Unicode character wherever one
// exists (× ÷ ± ≤ ≥ ≠ ° √ π Δ …) and LaTeX only where layout needs it
// (`\frac{}{}`, `\sqrt{}`, `^{}`, `_{}`), while E7(a) leaves the teacher's
// key plain text (`1/2`, `sqrt(2)`, `3.2 x 10^5`, `45°C`, `pi` as `π`). Two
// changes here, both additive:
//   - the trigger set grows past `[$\{}^_]` to the keypad's symbols, Greek
//     letters, Unicode super/subscript digits and the ASCII synonyms that
//     only appear in maths (`<=`, `>=`, `!=`, `+/-`, `sqrt`), so a student's
//     `3.2 × 10^5` against a key `3.2 x 10^5` reaches the fold at all;
//   - `foldFormula` gains a canonicalisation pass (below) that runs before
//     today's steps and rewrites both sides into one notation.
// The plain comparison still decides first and is unchanged, so — exactly as
// with E7(b) — this can only ever ADD a match to a pair the plain comparison
// rejected ("cell wall" ≠ "cellwall" still). It equates NOTATION, not value:
// `1/2` is not `0.5`, `\frac{1}{2}` is not `\frac{2}{4}`, `2×3` is not `3×2`,
// and a mixed number `1\frac{1}{2}` is not a teacher's `1 1/2` (a recorded
// limit, pinned by a test). Case is folded before we see the string, so `Δ`
// and `δ` are the same letter (a recorded cost; Greek case is a follow-up).
const FORMULA_MARKUP_RE =
  /[$\\{}^_×÷±≤≥≠°√→∞Α-ω²³¹⁰-⁹₀-₉]|<=|>=|!=|\+\/-|sqrt/i;

// Numeric equivalence (James, 2026-09-15, docs/math-entry-design.md
// §Follow-ups "Numeric equivalence"). Between the plain comparison and the
// fold sits one more chance to match: when BOTH sides parse as a number,
// they are compared BY VALUE, so a key of `1/2` scores `0.5`, `2/4` and
// `0.50`. Anything that does not parse as a number on both sides — units,
// letters, `√2`, `π`, an expression like `2×3` — falls through to the fold
// exactly as before, so this can only ever ADD a match. `exact_form` on the
// item turns it off for tasks where the form IS the answer ("in lowest
// terms"), restoring the pre-2026-09-15 behaviour byte for byte.
export type ShortTextMatchOptions = {
  /** Item config `exact_form`: compare forms, not values (default false). */
  exactForm?: boolean;
};

export function shortTextMatches(
  response: string,
  key: string,
  options?: ShortTextMatchOptions,
): boolean {
  const a = normalizeShortText(response);
  const b = normalizeShortText(key);
  if (a === b) return true;
  if (!options?.exactForm && numericAnswersEqual(response, key)) return true;
  if (!FORMULA_MARKUP_RE.test(response) && !FORMULA_MARKUP_RE.test(key)) return false;
  return foldFormula(a) === foldFormula(b);
}

// --- the numeric parser (numeric equivalence, 2026-09-15) -------------------
//
// Deliberately narrow: it recognises the shapes a student types AS A NUMBER
// and nothing else. A string it does not fully understand yields null and the
// caller falls back, so a widening here can never turn a right answer wrong.
//
// Accepted: integers and decimals (`.5`, `0.50`, `-3`), thousands separators
// (`1,000`), fractions `a/b`, mixed numbers `1 1/2`, scientific `3.2×10^5` /
// `3.2 x 10^5` / `3.2e5` (`\times`, a lone `x` between digit groups and
// Unicode superscripts all arrive as `×` / `^n` from canonicalizeMath), and a
// trailing `%`.
//
// Not accepted, on purpose: a bare `10^4` (so the recorded limit `104` ≠
// `10^4` still holds), arithmetic (`2×3` is not 6), anything carrying a unit
// or a letter, and a leading currency `$` — a `$` is stripped only when it
// wraps the WHOLE string, which is the KaTeX-delimiter case, never the money
// case, so `$57,600` keeps falling through to the fold.
export type NumericAnswer = {
  /** The value, with a trailing `%` already divided out. */
  value: number;
  /** Whether the string carried a trailing `%`. */
  percent: boolean;
};

// A magnitude with optional thousands separators: `7`, `0.50`, `.5`, `1,000`.
const PLAIN_NUMBER_RE = /^(?:\d{1,3}(?:,\d{3})+|\d*)(?:\.\d+)?$/;

function plainMagnitude(text: string): number | null {
  const t = text.trim();
  if (!t || !PLAIN_NUMBER_RE.test(t)) return null;
  const stripped = t.replace(/,/g, "");
  if (!/\d/.test(stripped)) return null; // "." alone, or ""
  const n = Number(stripped);
  return Number.isFinite(n) ? n : null;
}

/** A signed plain number, a fraction `a/b`, or a mixed number `1 1/2`. */
function parseSignedValue(text: string): number | null {
  let s = text.trim();
  let sign = 1;
  if (s.startsWith("-")) {
    sign = -1;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }

  const mixed = s.match(/^(\S+)\s+([^\s/]+)\s*\/\s*([^\s/]+)$/);
  if (mixed) {
    const whole = plainMagnitude(mixed[1]!);
    const numerator = plainMagnitude(mixed[2]!);
    const denominator = plainMagnitude(mixed[3]!);
    if (whole === null || numerator === null || denominator === null) return null;
    if (denominator === 0) return null;
    return sign * (whole + numerator / denominator);
  }

  const fraction = s.match(/^([^/]+)\/([^/]+)$/);
  if (fraction) {
    const numerator = plainMagnitude(fraction[1]!);
    const denominator = plainMagnitude(fraction[2]!);
    if (numerator === null || denominator === null || denominator === 0) return null;
    return (sign * numerator) / denominator;
  }

  const plain = plainMagnitude(s);
  return plain === null ? null : sign * plain;
}

// `<mantissa>×10^<exp>` — the exponent's braces are optional because
// canonicalizeMath leaves `^{-4}` braced and `^5` bare.
const SCIENTIFIC_RE = /^(.*?)\s*×\s*10\s*\^\s*(?:\{\s*([+-]?\d+)\s*\}|([+-]?\d+))$/;
// `<mantissa>e<exp>` — the string is lower-cased by the time we see it.
const E_NOTATION_RE = /^(.+?)e([+-]?\d+)$/;

export function parseNumericAnswer(raw: string): NumericAnswer | null {
  let s = canonicalizeMath(normalizeShortText(raw)).trim();
  // KaTeX delimiters wrapping the whole answer (`$\frac{1}{2}$`) are markup,
  // not a currency sign; a leading-only `$` is money and disqualifies.
  if (s.length > 1 && s.startsWith("$") && s.endsWith("$")) s = s.slice(1, -1).trim();
  s = s
    .replace(/\\(?:mathrm|textrm|text|mathit|mathbf)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\[,;!: ]/g, "")
    .replace(/[{}]/g, "")
    .trim();

  let percent = false;
  if (s.endsWith("%")) {
    percent = true;
    s = s.slice(0, -1).trim();
  }
  if (!s) return null;

  const scientific = s.match(SCIENTIFIC_RE);
  if (scientific) {
    const mantissaText = scientific[1]!.trim();
    const exponent = Number(scientific[2] ?? scientific[3]);
    const mantissa = mantissaText === "" ? 1 : parseSignedValue(mantissaText);
    if (mantissa === null || !Number.isFinite(exponent)) return null;
    const value = mantissa * 10 ** exponent;
    return Number.isFinite(value) ? { value: percent ? value / 100 : value, percent } : null;
  }

  const eNotation = s.match(E_NOTATION_RE);
  if (eNotation) {
    const mantissa = parseSignedValue(eNotation[1]!);
    const exponent = Number(eNotation[2]);
    if (mantissa === null || !Number.isFinite(exponent)) return null;
    const value = mantissa * 10 ** exponent;
    return Number.isFinite(value) ? { value: percent ? value / 100 : value, percent } : null;
  }

  const plain = parseSignedValue(s);
  if (plain === null) return null;
  return { value: percent ? plain / 100 : plain, percent };
}

/** Relative tolerance for the float error a fraction or a power of ten
 * introduces (1/3 is not 0.333…), with an absolute floor near zero. */
export function numbersClose(a: number, b: number): boolean {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  if (diff <= 1e-12) return true;
  return diff <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

/** Both sides numeric, both or neither a percentage, and equal in value.
 * The percent rule is the teacher's: `50%` is not `0.5` — a student who
 * dropped the sign changed what they wrote. */
export function numericAnswersEqual(response: string, key: string): boolean {
  const a = parseNumericAnswer(response);
  const b = parseNumericAnswer(key);
  if (!a || !b) return false;
  if (a.percent !== b.percent) return false;
  return numbersClose(a.value, b.value);
}
export function foldFormula(normalized: string): string {
  return canonicalizeMath(normalized)
    .replace(/\$/g, "")
    .replace(/\\(?:mathrm|textrm|text|mathit|mathbf)\s*\{([^{}]*)\}/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\\[,;!: ]/g, "")
    .replace(/\s+/g, "")
    .replace(/_/g, "");
}

// --- the canonicalisation pass (roadmap 4b slice 1a) ------------------------
//
// Input is an already-normalised string: trimmed, whitespace-collapsed and
// LOWER-CASED, so `\Delta` and `\delta` both arrive as `\delta` and map to the
// same lower-case letter.
//
// "Atom" is the note's unit of structure: a decimal number or a single letter
// (Latin or Greek), either one optionally carrying `^…` / `_…` groups, so
// `10^{5}` and `x^2` each count as one atom. A `\frac` or `\sqrt` side that is
// one atom needs no parentheses; anything else gets them.
const ATOM_BASE = "(?:[0-9]*\\.?[0-9]+|[a-z\\u0391-\\u03c9])";
const ATOM_SCRIPT = "(?:[\\^_](?:\\{[^{}]*\\}|-?[0-9a-z\\u0391-\\u03c9]))";
const ATOM = `${ATOM_BASE}${ATOM_SCRIPT}*`;
const ATOM_RE = new RegExp(`^${ATOM}$`);
const SQRT_ATOM_RE = new RegExp(`\\\\?sqrt\\s*(${ATOM})`, "g");
// A `\frac` glued to the atom before it is a mixed number, not a product:
// `1\frac{1}{2}` folds to `1(1/2)` and so never meets a teacher's `1 1/2`.
const ADJACENT_RE = /[0-9a-zΑ-ω]/;
// A `{…}` group that may itself hold one level of braces, so a `\frac` side
// can be `10^{5}` or another `\frac{…}{…}`.
const GROUP = "\\{((?:[^{}]|\\{[^{}]*\\})*)\\}";
const FRAC_RE = new RegExp(`\\\\d?frac\\s*${GROUP}\\s*${GROUP}`, "g");
const SQRT_GROUP_RE = new RegExp(`\\\\sqrt\\s*${GROUP}`, "g");

function isAtom(side: string): boolean {
  return ATOM_RE.test(side.trim());
}
function wrapAtom(side: string): string {
  const inner = side.trim();
  return isAtom(inner) ? inner : `(${inner})`;
}

// Backslash commands whose meaning is a single character. A command ends at a
// non-letter, so `\le` never eats half of `\leq` and `\pi` is not `\varpi`.
const MATH_COMMANDS: Record<string, string> = {
  times: "×",
  cdot: "×",
  div: "÷",
  pm: "±",
  plusminus: "±",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  ne: "≠",
  neq: "≠",
  degree: "°",
  circ: "°",
  // Every Greek letter KaTeX names (the upper-case commands arrive
  // lower-cased), plus the `\var…` variants folded onto their base letter.
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  omicron: "ο",
  pi: "π",
  varpi: "π",
  rho: "ρ",
  varrho: "ρ",
  sigma: "σ",
  varsigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
};

const SUPERSCRIPTS: Record<string, string> = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
  "⁻": "-",
};
const SUBSCRIPTS: Record<string, string> = {
  "₀": "0",
  "₁": "1",
  "₂": "2",
  "₃": "3",
  "₄": "4",
  "₅": "5",
  "₆": "6",
  "₇": "7",
  "₈": "8",
  "₉": "9",
  "₋": "-",
};
const SUPERSCRIPT_RUN_RE = /[⁰¹²³⁴-⁹⁻]+/g;
const SUBSCRIPT_RUN_RE = /[₀-₉₋]+/g;
function scriptRun(marker: "^" | "_", run: string, table: Record<string, string>): string {
  const digits = [...run].map((c) => table[c] ?? "").join("");
  return digits.startsWith("-") ? `${marker}{${digits}}` : `${marker}${digits}`;
}

export function canonicalizeMath(normalized: string): string {
  let out = normalized;

  // Symbol synonyms → the Unicode character the keypad inserts. `^\circ` and
  // `^{\circ}` first, because the degree sign carries no exponent.
  out = out.replace(/\^(?:\{\s*\\circ\s*\}|\\circ(?![a-z]))/g, "°");
  out = out.replace(/\\([a-z]+)(?![a-z])/g, (m, name: string) => MATH_COMMANDS[name] ?? m);
  out = out.replace(/\+\/-/g, "±").replace(/\+-/g, "±");
  out = out.replace(/<=/g, "≤").replace(/>=/g, "≥").replace(/!=/g, "≠");
  out = out.replace(/[·*]/g, "×");

  // Unicode super/subscript digits (Option-key chords, or a pasted `x²`) →
  // `^n` / `_n`, which today's steps already equate with `^{n}` / `_{n}`.
  out = out.replace(SUPERSCRIPT_RUN_RE, (run) => scriptRun("^", run, SUPERSCRIPTS));
  out = out.replace(SUBSCRIPT_RUN_RE, (run) => scriptRun("_", run, SUBSCRIPTS));

  // `\frac{A}{B}` / `\dfrac{A}{B}` → `A/B`; two passes carry one level of
  // nesting (the outer fraction folds first, then the inner one).
  for (let pass = 0; pass < 2; pass++) {
    out = out.replace(
      FRAC_RE,
      (_m, a: string, b: string, offset: number, whole: string) => {
        const body = `${wrapAtom(a)}/${wrapAtom(b)}`;
        return ADJACENT_RE.test(whole[offset - 1] ?? "") ? `(${body})` : body;
      },
    );
  }

  // Roots: `\sqrt{A}`, `sqrt(A)` and `sqrt A` all reach `√A` / `√(A)`.
  out = out.replace(SQRT_GROUP_RE, (_m, a: string) => `√${wrapAtom(a)}`);
  out = out.replace(/\\?sqrt\s*\(([^()]*)\)/g, (_m, a: string) => `√${wrapAtom(a)}`);
  out = out.replace(SQRT_ATOM_RE, (_m, a: string) => `√${a}`);

  // Parentheses around a single atom carry no meaning beside a `/` or a `√` —
  // the two places this pass itself writes them — so a teacher's `(1)/(2)`
  // and `√(2)` meet the keypad's `1/2` and `√2`. Anywhere else they are left
  // alone: `(2)(3)` is a product, not `23`, and `f(x)` stays `f(x)`.
  out = out.replace(/\(([^()]*)\)(?=\s*\/)/g, (m, inner: string) => (isAtom(inner) ? inner.trim() : m));
  out = out.replace(/(\/|√)\s*\(([^()]*)\)/g, (m, lead: string, inner: string) =>
    isAtom(inner) ? `${lead}${inner.trim()}` : m,
  );

  // D-1.3: a lone `x` between two digit groups is a times sign (`3.2 x 10^5`,
  // `2x3`). Narrow on purpose — `2x` and `x^2` have no digit on both sides.
  out = out.replace(/(\d)\s*x\s*(?=\d)/g, "$1×");

  return out;
}

// E3 (D-3, James 2026-09-02): a table cell is usually a number, and a
// student who writes `1.50` for a key of `1.5` is right. That rule now lives
// in shortTextMatches itself (numeric equivalence, 2026-09-15) and the cell
// simply delegates: `1.50` ≡ `1.5` exactly as before, `H_2O` still folds
// against `H2O`, and `104` is still not `10^4`. A table has no `exact_form`
// switch of its own — the item-level opt-out is a short-text field — so a
// cell always compares by value.
export function tableCellMatches(response: string, key: string): boolean {
  return shortTextMatches(response, key);
}

// E3 slice 2: what a table is worth — the denominator every score path
// shares so one column never carries different maxima per student (the
// manual score route's standing rule). Keyed cells when there are any (the
// auto branch below counts the same cells); otherwise every body cell, the
// honest denominator for a hand-scored grid.
export function tableMaxPoints(config: ItemRow["config"] | null | undefined): number {
  const keys = config?.cell_keys ?? {};
  const keyed = Object.values(keys).reduce((n, cols) => n + Object.keys(cols).length, 0);
  if (keyed > 0) return keyed;
  return (config?.columns?.length ?? 0) * (config?.rows?.length ?? 0);
}

export function scoreResponse(
  item: ItemRow,
  response: ItemResponse,
): AutoScoreResult | null {
  if (response.type !== item.type) return null;

  if (response.type === "multiple_choice_single") {
    const correct = (item.correct_choice_ids as string[]) ?? [];
    if (correct.length !== 1) return null; // no answer key
    return { points: response.choice_id === correct[0] ? 1 : 0, max_points: 1 };
  }

  if (response.type === "multiple_choice_multi") {
    const correct = (item.correct_choice_ids as string[]) ?? [];
    if (correct.length === 0) return null; // no answer key
    const expected = new Set(correct);
    const received = new Set(response.choice_ids);
    const exact =
      expected.size === received.size &&
      [...expected].every((id) => received.has(id));
    return { points: exact ? 1 : 0, max_points: 1 };
  }

  if (response.type === "short_text") {
    if (!item.correct_answer) return null; // no answer key
    // Numeric equivalence (2026-09-15): on unless this item opted out.
    const match = shortTextMatches(response.text, item.correct_answer, {
      exactForm: item.config?.exact_form === true,
    });
    return { points: match ? 1 : 0, max_points: 1 };
  }

  // Slice 47: match — the pair list is the key; a fully correct response
  // maps every pair id to itself. Exact-set all-or-nothing (same policy as
  // MC multi): no extra keys, no missing keys, every mapping right.
  if (response.type === "match") {
    const pairs = item.config?.pairs ?? [];
    if (pairs.length === 0) return null; // no answer key
    const matches = response.matches;
    const exact =
      Object.keys(matches).length === pairs.length &&
      pairs.every((p) => matches[p.id] === p.id);
    return { points: exact ? 1 : 0, max_points: 1 };
  }

  // Slice 48: order — exact sequence, all-or-nothing. Correct = the
  // response lists every entry id in the authored order, nothing extra.
  if (response.type === "order") {
    const sequence = item.config?.sequence ?? [];
    if (sequence.length === 0) return null; // no answer key
    const expected = sequence.map((e) => e.id);
    const received = response.ordered_ids;
    const exact =
      received.length === expected.length &&
      expected.every((id, i) => received[i] === id);
    return { points: exact ? 1 : 0, max_points: 1 };
  }

  // Slice 49: hotspot — marked regions must equal the key exactly,
  // all-or-nothing. A draft/unconfigured hotspot has no key → skipped.
  if (response.type === "hotspot") {
    const correct = item.config?.correct_region_ids ?? [];
    if (correct.length === 0) return null; // no answer key
    const expected = new Set(correct);
    const received = new Set(response.region_ids);
    const exact =
      expected.size === received.size &&
      [...expected].every((id) => received.has(id));
    return { points: exact ? 1 : 0, max_points: 1 };
  }

  // E3 slice 1: table — one point per KEYED cell (D-2), max_points = the
  // number of keyed cells; an unkeyed cell is never counted either way. A
  // cell the student left out reads as "" and scores 0. No keys → skipped,
  // like a draft hotspot.
  if (response.type === "table") {
    const keys = item.config?.cell_keys ?? {};
    let points = 0;
    let max = 0;
    for (const [rowId, cols] of Object.entries(keys)) {
      for (const [colId, key] of Object.entries(cols)) {
        max++;
        const cell = response.cells[rowId]?.[colId] ?? "";
        if (tableCellMatches(cell, key)) points++;
      }
    }
    if (max === 0) return null; // no answer key
    return { points, max_points: max };
  }

  // essay (and any future type without an objective key)
  return null;
}
