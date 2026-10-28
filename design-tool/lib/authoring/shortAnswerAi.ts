// AI short answer (James, 2026-10-27; D2 partial credit): the new editor's
// short-answer key, as pure helpers over the holistic rubric it is stored as
// (lib/api/items.ts validateShortAnswerRubric). The teacher writes what earns
// each score and its points; the level names are derived from the points, so
// the stored rubric always reads No credit → Partial credit → Full credit.
import type { Rubric, RubricLevel, ScoringMethod } from "@secure-test/schema";

/** The level that earns nothing — every key has one, at 0 points. */
const NO_CREDIT = "No credit";

/** A new key: no credit, and full credit for `keyText` (the old correct
 * answer, so turning AI on keeps what the teacher already wrote). */
export function seedShortAnswerRubric(keyText: string): Rubric {
  return relabel({
    style: "holistic",
    criteria: [
      {
        id: "sa",
        name: "Answer",
        levels: [
          { id: "sa-0", label: NO_CREDIT, points: 0 },
          { id: "sa-1", label: "Full credit", points: 1, descriptor: keyText },
        ],
      },
    ],
  });
}

/** The levels a teacher edits: every level worth points, in stored order. */
export function creditLevels(rubric: Rubric): RubricLevel[] {
  return (rubric.criteria[0]?.levels ?? []).filter((l) => l.points > 0);
}

/** Change one level's text or points. */
export function updateLevel(
  rubric: Rubric,
  levelId: string,
  patch: { descriptor?: string; points?: number },
): Rubric {
  return mapLevels(rubric, (levels) => levels.map((l) => (l.id === levelId ? { ...l, ...patch } : l)));
}

/** Add a partial-credit level one point below full credit. On a 1-point
 * key (the seed) full credit goes up to 2 so the new level can be 1 and
 * partial (PR #137 review: it used to make a second 1-point Full credit
 * the teacher could not lower). */
export function addPartialLevel(rubric: Rubric): Rubric {
  return mapLevels(rubric, (levels) => {
    const top = Math.max(...levels.map((l) => l.points));
    const raised = top < 2 ? levels.map((l) => (l.points === top && top > 0 ? { ...l, points: 2 } : l)) : levels;
    const used = new Set(levels.map((l) => l.id));
    let n = levels.length;
    while (used.has(`sa-${n}`)) n++;
    return [...raised, { id: `sa-${n}`, label: "", points: Math.max(1, top - 1), descriptor: "" }];
  });
}

/** Remove a level that earns points, keeping at least one. */
export function removeLevel(rubric: Rubric, levelId: string): Rubric {
  if (creditLevels(rubric).length <= 1) return rubric;
  return mapLevels(rubric, (levels) => levels.filter((l) => l.id !== levelId || l.points <= 0));
}

/** The highest score the key gives. */
export function shortAnswerMax(rubric: Rubric): number {
  return Math.max(0, ...(rubric.criteria[0]?.levels ?? []).map((l) => l.points));
}

/** The scoring select's change for any card: on a short answer, AI brings a
 * key (seeded from the correct answer) and auto / human / default drop it
 * (D1: a key exists only while the item is AI scored). */
export function withScoringMethod<
  T extends { type: string; scoring_method: ScoringMethod | null; rubric: Rubric | null; correct_answer: string | null },
>(item: T, method: ScoringMethod | null): T {
  if (item.type !== "short_text") return { ...item, scoring_method: method };
  const ai = method === "ai" || method === "hybrid";
  return {
    ...item,
    scoring_method: method,
    rubric: ai ? (item.rubric ?? seedShortAnswerRubric(item.correct_answer ?? "")) : null,
  };
}

function mapLevels(rubric: Rubric, f: (levels: RubricLevel[]) => RubricLevel[]): Rubric {
  const [first, ...rest] = rubric.criteria;
  if (!first) return rubric;
  return relabel({ ...rubric, criteria: [{ ...first, levels: f(first.levels) }, ...rest] });
}

/** 0 is No credit, the top is Full credit, the rest partial. The order is
 * left alone, so a row does not jump while its points are being typed. */
function relabel(rubric: Rubric): Rubric {
  const [first, ...rest] = rubric.criteria;
  if (!first) return rubric;
  const top = Math.max(...first.levels.map((l) => l.points));
  const named = first.levels.map((l) => ({
    ...l,
    label: l.points <= 0 ? NO_CREDIT : l.points === top ? "Full credit" : "Partial credit",
  }));
  return { ...rubric, criteria: [{ ...first, levels: named }, ...rest] };
}
