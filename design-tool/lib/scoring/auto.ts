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
const FORMULA_MARKUP_RE = /[$\\{}^_]/;
export function shortTextMatches(response: string, key: string): boolean {
  const a = normalizeShortText(response);
  const b = normalizeShortText(key);
  if (a === b) return true;
  if (!FORMULA_MARKUP_RE.test(response) && !FORMULA_MARKUP_RE.test(key)) return false;
  return foldFormula(a) === foldFormula(b);
}
export function foldFormula(normalized: string): string {
  return normalized
    .replace(/\$/g, "")
    .replace(/\\(?:mathrm|textrm|text|mathit|mathbf)\s*\{([^{}]*)\}/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\\[,;!: ]/g, "")
    .replace(/\s+/g, "")
    .replace(/_/g, "");
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
