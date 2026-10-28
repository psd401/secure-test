// AI short answer (2026-10-27): the new editor's key helpers. Pure. Every
// key they build must pass the write boundary's short-answer rules.
import { describe, expect, test } from "bun:test";
import { isShortAnswerRubric } from "../lib/api/items";
import {
  addPartialLevel,
  creditLevels,
  keyUnfinished,
  removeLevel,
  seedShortAnswerRubric,
  shortAnswerMax,
  updateLevel,
  withScoringMethod,
} from "../lib/authoring/shortAnswerAi";

const labels = (r: ReturnType<typeof seedShortAnswerRubric>) => r.criteria[0]!.levels.map((l) => `${l.label}:${l.points}`);

describe("shortAnswerAi", () => {
  test("a seed keeps the old correct answer as full credit", () => {
    const r = seedShortAnswerRubric("births per 1000");
    expect(r.style).toBe("holistic");
    expect(labels(r)).toEqual(["No credit:0", "Full credit:1"]);
    expect(creditLevels(r)[0]!.descriptor).toBe("births per 1000");
    expect(isShortAnswerRubric(r)).toBe(true);
  });

  test("partial credit: add a level, set points, names follow the points", () => {
    let r = updateLevel(seedShortAnswerRubric("full"), "sa-1", { points: 2 });
    r = addPartialLevel(r);
    expect(labels(r)).toEqual(["No credit:0", "Partial credit:1", "Full credit:2"]);
    const partial = creditLevels(r).find((l) => l.label === "Partial credit")!;
    expect(isShortAnswerRubric(r)).toBe(false); // the new level has no text yet
    r = updateLevel(r, partial.id, { descriptor: "names births" });
    expect(isShortAnswerRubric(r)).toBe(true);
    expect(shortAnswerMax(r)).toBe(2);
    // Ids stay put through edits, so autosave diffs stay small.
    expect(r.criteria[0]!.levels.map((l) => l.id)).toEqual(["sa-0", "sa-2", "sa-1"]);
  });

  test("PR #137 review: partial credit on the seeded 1-point key raises full credit to 2", () => {
    const r = addPartialLevel(seedShortAnswerRubric("full"));
    expect(labels(r)).toEqual(["No credit:0", "Partial credit:1", "Full credit:2"]);
    expect(shortAnswerMax(r)).toBe(2);
  });

  test("raising partial above full swaps the names, not the rows", () => {
    let r = addPartialLevel(updateLevel(seedShortAnswerRubric("a"), "sa-1", { points: 2 }));
    r = updateLevel(r, "sa-2", { points: 3 });
    expect(labels(r)).toEqual(["No credit:0", "Full credit:3", "Partial credit:2"]);
  });

  test("a level can be removed, but never the last one that earns points", () => {
    const one = seedShortAnswerRubric("a");
    expect(removeLevel(one, "sa-1")).toBe(one);
    const two = addPartialLevel(updateLevel(one, "sa-1", { points: 2 }));
    expect(labels(removeLevel(two, "sa-2"))).toEqual(["No credit:0", "Full credit:2"]);
    // Hand-check row 838: a new partial level sits just below full credit, so
    // the editor, the queue and the Change dialog read lowest to highest.
    expect(labels(two)).toEqual(["No credit:0", "Partial credit:1", "Full credit:2"]);
    // The no-credit level is never removed.
    expect(labels(removeLevel(two, "sa-0"))).toEqual(labels(two));
  });

  test("withScoringMethod: AI seeds a key from the correct answer, other methods drop it", () => {
    type Card = Parameters<typeof withScoringMethod>[0];
    const item: Card = { type: "short_text", scoring_method: null, rubric: null, correct_answer: "x" };
    const on = withScoringMethod(item, "hybrid");
    expect(on.scoring_method).toBe("hybrid");
    expect(creditLevels(on.rubric!)[0]!.descriptor).toBe("x");
    // Switching between AI methods keeps the key the teacher wrote.
    expect(withScoringMethod(on, "ai").rubric).toBe(on.rubric);
    expect(withScoringMethod(on, "auto")).toMatchObject({ scoring_method: "auto", rubric: null, correct_answer: "x" });
    expect(withScoringMethod(on, null).rubric).toBeNull();
    // Other types: only the method changes.
    const essay: Card = { type: "essay", scoring_method: null, rubric: on.rubric, correct_answer: null };
    expect(withScoringMethod(essay, "human").rubric).toBe(on.rubric);
  });

  test("keyUnfinished: a level that earns points with no text, or none that earns points", () => {
    const seeded = seedShortAnswerRubric("x");
    expect(keyUnfinished(seeded)).toBe(false);
    expect(keyUnfinished(addPartialLevel(seeded))).toBe(true);
    expect(keyUnfinished(seedShortAnswerRubric(" "))).toBe(true);
  });
});
