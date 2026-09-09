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
export function shortTextMatches(response: string, key: string): boolean {
  const a = normalizeShortText(response);
  const b = normalizeShortText(key);
  if (a === b) return true;
  if (!FORMULA_MARKUP_RE.test(response) && !FORMULA_MARKUP_RE.test(key)) return false;
  return foldFormula(a) === foldFormula(b);
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
// student who writes `1.50` for a key of `1.5` is right. When BOTH sides are
// a plain decimal the numbers are compared; anything else falls through to
// the short-text rule above (so `H_2O` in a cell still folds against `H2O`).
// Exact equality only — a tolerance band is a later knob, and the teacher
// can always hand-score.
const PLAIN_DECIMAL_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
export function tableCellMatches(response: string, key: string): boolean {
  const a = response.trim();
  const b = key.trim();
  if (PLAIN_DECIMAL_RE.test(a) && PLAIN_DECIMAL_RE.test(b)) {
    return Number(a) === Number(b);
  }
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
    const match = shortTextMatches(response.text, item.correct_answer);
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
