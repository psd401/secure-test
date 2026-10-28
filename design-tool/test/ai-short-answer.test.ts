// AI short answer (James, 2026-10-27): the pure rules around a short answer
// scored with AI — what reaches the student, what counts as its key, how a
// type change treats it, and which editor offers it. No database.
import { describe, expect, test } from "bun:test";
import type { ItemType } from "../db/schema";
import { ALLOWED_SCORING_METHODS, isShortAnswerRubric, parseItemBody } from "../lib/api/items";
import { mapItemForDelivery } from "../lib/api/deliveryItem";
import { changeItemType } from "../lib/authoring/typeChange";
import { newItemSeed } from "../lib/authoring/insertTypes";
import { needsAnswerKey, questionGaps } from "../app/dashboard/[id]/readiness";

const editor = await import("../app/dashboard/[id]/AssessmentEditor");
type View = ReturnType<typeof editor.rowToView>;
const model = await import("../app/dashboard/[id]/editorModel");

const KEY = {
  style: "holistic" as const,
  criteria: [
    {
      id: "sa",
      name: "Answer",
      levels: [
        { id: "sa0", label: "No credit", points: 0 },
        { id: "sa1", label: "Partial credit", points: 1, descriptor: "Names births." },
        { id: "sa2", label: "Full credit", points: 2, descriptor: "Births per 1000 people." },
      ],
    },
  ],
};

function view(type: ItemType, over: Partial<View> = {}): View {
  return { ...editor.defaultItemFor(type), ...newItemSeed(type), id: "i1", position: 0, ...over } as View;
}

describe("delivery (ADR 0016)", () => {
  test("a short answer reaches the student with neither its key nor its method", () => {
    const out = mapItemForDelivery(
      {
        id: "i1",
        type: "short_text",
        stem: "Define birth rate.",
        choices: [],
        correct_answer: "x",
        config: { scoring_method: "hybrid", rubric: { ...KEY, student_visibility: { during_test: true } } },
      } as unknown as Parameters<typeof mapItemForDelivery>[0],
      { sealOption: (id: string) => id } as unknown as Parameters<typeof mapItemForDelivery>[1],
    );
    expect(out).toEqual({ type: "short_text", id: "i1", stem: "Define birth rate." });
  });
});

describe("isShortAnswerRubric", () => {
  test("holistic, with text on every level that earns points", () => {
    expect(isShortAnswerRubric(KEY)).toBe(true);
    expect(isShortAnswerRubric({ ...KEY, style: "analytic" })).toBe(false);
    const noText = { ...KEY, criteria: [{ ...KEY.criteria[0]!, levels: [{ id: "a", label: "A", points: 1 }, { id: "b", label: "B", points: 0 }] }] };
    expect(isShortAnswerRubric(noText)).toBe(false);
    const zero = { ...KEY, criteria: [{ ...KEY.criteria[0]!, levels: [{ id: "a", label: "A", points: 0 }, { id: "b", label: "B", points: 0 }] }] };
    expect(isShortAnswerRubric(zero)).toBe(false);
  });
});

describe("readiness", () => {
  test("an AI short answer is keyed by its rubric, not by correct_answer", () => {
    expect(needsAnswerKey({ type: "short_text", correct_answer: "", scoring_method: "hybrid", rubric: KEY })).toBe(false);
    expect(needsAnswerKey({ type: "short_text", correct_answer: "", config: { scoring_method: "ai", rubric: KEY } })).toBe(false);
    expect(needsAnswerKey({ type: "short_text", correct_answer: "x", scoring_method: "ai", rubric: null })).toBe(true);
    expect(needsAnswerKey({ type: "short_text", correct_answer: "" })).toBe(true);
  });

  test("its gap names what is missing", () => {
    const item = view("short_text", { stem: "Define it.", correct_answer: "", scoring_method: "hybrid", rubric: KEY });
    expect(questionGaps(item)).toEqual([]);
    const blankKey = {
      ...KEY,
      criteria: [{ ...KEY.criteria[0]!, levels: [{ id: "a", label: "No credit", points: 0 }, { id: "b", label: "Full", points: 1, descriptor: " " }] }],
    };
    expect(questionGaps({ ...item, rubric: blankKey })).toEqual(["needs what earns credit"]);
    // PR #137 review: one empty partial level is enough to flag it, as the
    // write boundary refuses it.
    const halfDone = {
      ...KEY,
      criteria: [{ ...KEY.criteria[0]!, levels: [...KEY.criteria[0]!.levels.slice(0, 2), { id: "x", label: "Partial credit", points: 1, descriptor: "" }] }],
    };
    expect(questionGaps({ ...item, rubric: halfDone })).toEqual(["needs what earns credit"]);
    expect(questionGaps({ ...item, scoring_method: null, rubric: null })).toEqual(["needs a correct answer"]);
  });
});

describe("the editor", () => {
  test("the patch body carries the key, and the write boundary takes it", () => {
    const item = view("short_text", { stem: "Define it.", scoring_method: "hybrid", rubric: KEY });
    const body = model.itemPatchBody(item);
    expect(body.rubric).toEqual(KEY);
    expect(parseItemBody({ ...body, scoring_method: "hybrid" })).toMatchObject({ type: "short_text", rubric: KEY });
  });

  test("the old editor offers AI on a short answer only when it already uses it", () => {
    const plain = view("short_text");
    expect(model.scoringOptionShown(plain, "hybrid", false)).toBe(false);
    expect(model.scoringOptionShown(plain, "hybrid", true)).toBe(true);
    expect(model.scoringOptionShown({ ...plain, scoring_method: "ai" }, "hybrid", false)).toBe(true);
    expect(model.scoringOptionShown(view("essay"), "ai", false)).toBe(true);
  });

  test("type change: the key is listed as lost, and an AI essay becomes an auto short answer", () => {
    const allowed = (t: ItemType) => ALLOWED_SCORING_METHODS[t];
    const short = view("short_text", { stem: "Q", scoring_method: "hybrid", rubric: KEY });
    const toMc = changeItemType(short, "multiple_choice_single", editor.defaultItemFor("multiple_choice_single"), allowed);
    expect(toMc.lost).toContain("what earns credit (the AI scoring key)");
    expect(toMc.item.rubric).toBeNull();
    const essay = view("essay", { stem: "Q", scoring_method: "hybrid", rubric: KEY });
    const toShort = changeItemType(essay, "short_text", editor.defaultItemFor("short_text"), allowed);
    expect(toShort.item.scoring_method).toBeNull();
    expect(toShort.item.rubric).toBeNull();
  });
});
