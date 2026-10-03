// Instant feedback (docs/instant-feedback-design.md, slice 1): the pure
// builder. The rule this file exists for: no key reaches a student before the
// teacher's chosen moment — asserted on the serialized JSON.
import { describe, expect, test } from "bun:test";
import {
  ANSWERS_NOTE,
  answersShown,
  buildFeedback,
  correctAnswerText,
  plainText,
  yourAnswerText,
  type FeedbackInput,
  type FeedbackItemInput,
  type FeedbackSettings,
} from "../lib/feedback/buildFeedback";

function item(partial: Partial<FeedbackItemInput> & Pick<FeedbackItemInput, "id" | "position" | "type">): FeedbackItemInput {
  return {
    choices: [],
    correct_choice_ids: [],
    correct_answer: null,
    config: {},
    ...partial,
  } as FeedbackItemInput;
}

const MC = item({
  id: "i-mc",
  position: 0,
  type: "multiple_choice_single",
  choices: [
    { id: "a", text: "Paris" },
    { id: "b", text: "Lyon ![a map](asset:11111111-1111-1111-1111-111111111111)" },
  ],
  correct_choice_ids: ["a"],
});
const MULTI = item({
  id: "i-multi",
  position: 1,
  type: "multiple_choice_multi",
  choices: [
    { id: "x", text: "$2$" },
    { id: "y", text: "$3$" },
    { id: "z", text: "![](asset:22222222-2222-2222-2222-222222222222)" },
  ],
  correct_choice_ids: ["x", "y"],
});
const SHORT = item({ id: "i-short", position: 2, type: "short_text", correct_answer: "1/2" });
const MATCH = item({
  id: "i-match",
  position: 3,
  type: "match",
  config: {
    pairs: [
      { id: "p1", left: "Dog", right: "Puppy" },
      { id: "p2", left: "Cat", right: "Kitten" },
    ],
  },
});
const ORDER = item({
  id: "i-order",
  position: 4,
  type: "order",
  config: {
    sequence: [
      { id: "e1", label: "First" },
      { id: "e2", label: "Second" },
    ],
  },
});
const HOTSPOT = item({
  id: "i-hot",
  position: 5,
  type: "hotspot",
  config: {
    regions: [
      { id: "r-a", x: 0, y: 0, w: 0.5, h: 0.5 },
      { id: "r-b", x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
    correct_region_ids: ["r-b"],
  },
});
const TABLE = item({
  id: "i-table",
  position: 6,
  type: "table",
  config: {
    columns: [
      { id: "c1", label: "Mass" },
      { id: "c2", label: "Volume" },
    ],
    rows: [
      { id: "t1", label: "Trial 1" },
      { id: "t2", label: "" },
    ],
    cell_keys: { t1: { c1: "2.5", c2: "10" }, t2: { c1: "3" } },
  },
});
const ESSAY = item({ id: "i-essay", position: 7, type: "essay" });
const DRAWING = item({ id: "i-draw", position: 8, type: "drawing_upload" });
const KEYLESS = item({ id: "i-keyless", position: 9, type: "short_text", correct_answer: null });
const HUMAN_SHORT = item({
  id: "i-human",
  position: 10,
  type: "short_text",
  correct_answer: "x",
  config: { scoring_method: "human" },
});

const ALL = [MC, MULTI, SHORT, MATCH, ORDER, HOTSPOT, TABLE, ESSAY, DRAWING, KEYLESS, HUMAN_SHORT];

const RESPONSES = new Map<string, Record<string, unknown>>([
  ["i-mc", { type: "multiple_choice_single", choice_id: "b" }],
  ["i-multi", { type: "multiple_choice_multi", choice_ids: ["x", "y"] }],
  ["i-short", { type: "short_text", text: "0.5" }],
  ["i-match", { type: "match", matches: { p2: "p1", p1: "p2" } }],
  ["i-order", { type: "order", ordered_ids: ["e1", "e2"] }],
  ["i-hot", { type: "hotspot", region_ids: ["r-a"] }],
  ["i-table", { type: "table", cells: { t1: { c1: "2.50", c2: "11" }, t2: { c1: "3" } } }],
  ["i-essay", { type: "essay", text: "My essay." }],
  ["i-draw", { type: "drawing_upload" }],
  ["i-keyless", { type: "short_text", text: "something" }],
  ["i-human", { type: "short_text", text: "x" }],
]);

// Finals as the auto pass would write them for RESPONSES.
const FINALS = new Map([
  ["i-mc", { points: 0, max_points: 1 }],
  ["i-multi", { points: 1, max_points: 1 }],
  ["i-short", { points: 1, max_points: 1 }],
  ["i-match", { points: 0, max_points: 1 }],
  ["i-order", { points: 1, max_points: 1 }],
  ["i-hot", { points: 0, max_points: 1 }],
  ["i-table", { points: 2, max_points: 3 }],
]);

function settings(over: Partial<FeedbackSettings>): FeedbackSettings {
  return { student_feedback: "off", answers_release: "on_release", answers_released_at: null, ...over };
}

function input(s: Partial<FeedbackSettings>, over: Partial<FeedbackInput> = {}): FeedbackInput {
  return { settings: settings(s), items: ALL, responses: RESPONSES, finals: FINALS, ...over };
}

describe("buildFeedback — levels", () => {
  test("off (and an unknown level) builds nothing", () => {
    expect(buildFeedback(input({ student_feedback: "off" }))).toBeNull();
    expect(buildFeedback(input({ student_feedback: "everything" }))).toBeNull();
  });

  test("score: totals only, no items, no key anywhere", () => {
    const fb = buildFeedback(input({ student_feedback: "score", answers_release: "at_hand_in" }))!;
    expect(fb).toEqual({ level: "score", earned: 5, max_auto: 9, pending_count: 4 });
    expect(JSON.stringify(fb)).not.toContain("correct_answer");
  });

  test("right_wrong: items with the student's answer, no key anywhere", () => {
    const fb = buildFeedback(input({ student_feedback: "right_wrong", answers_release: "at_hand_in" }))!;
    expect(fb.items).toHaveLength(ALL.length);
    expect(fb.answers_note).toBeUndefined();
    expect(JSON.stringify(fb)).not.toContain("correct_answer");
  });

  test("answers + on_release, before release: right / wrong plus the note, no key", () => {
    const fb = buildFeedback(input({ student_feedback: "answers" }))!;
    expect(fb.level).toBe("answers");
    expect(fb.answers_note).toBe(ANSWERS_NOTE);
    expect(ANSWERS_NOTE).toBe("Your teacher will go over the correct answers.");
    expect(fb.items).toHaveLength(ALL.length);
    expect(JSON.stringify(fb)).not.toContain("correct_answer");
  });

  test("answers + on_release, after release: the key on each missed item", () => {
    const fb = buildFeedback(
      input({ student_feedback: "answers", answers_released_at: new Date("2026-10-03T20:00:00Z") }),
    )!;
    expect(fb.answers_note).toBeUndefined();
    const keyed = fb.items!.filter((i) => i.correct_answer !== undefined).map((i) => i.item_id);
    // Missed = incorrect or partial; correct and pending items never carry one.
    expect(keyed).toEqual(["i-mc", "i-match", "i-hot", "i-table"]);
  });

  test("answers + at_hand_in: the key without a release", () => {
    const fb = buildFeedback(input({ student_feedback: "answers", answers_release: "at_hand_in" }))!;
    expect(fb.answers_note).toBeUndefined();
    expect(fb.items!.find((i) => i.item_id === "i-mc")!.correct_answer).toBe("Paris");
  });

  test("answersShown follows D-4", () => {
    expect(answersShown(settings({ student_feedback: "right_wrong", answers_release: "at_hand_in" }))).toBe(false);
    expect(answersShown(settings({ student_feedback: "answers" }))).toBe(false);
    expect(answersShown(settings({ student_feedback: "answers", answers_release: "at_hand_in" }))).toBe(true);
    expect(answersShown(settings({ student_feedback: "answers", answers_released_at: "2026-10-03T20:00:00Z" }))).toBe(true);
  });
});

describe("buildFeedback — per-item results", () => {
  const fb = buildFeedback(input({ student_feedback: "answers", answers_release: "at_hand_in" }))!;
  const byId = new Map(fb.items!.map((i) => [i.item_id, i]));

  test("numbers run 1..n by position, whatever order the items arrive in", () => {
    const shuffled = buildFeedback(input({ student_feedback: "right_wrong" }, { items: [...ALL].reverse() }))!;
    expect(shuffled.items!.map((i) => i.number)).toEqual(ALL.map((_, n) => n + 1));
    expect(shuffled.items![0]!.item_id).toBe("i-mc");
  });

  test("every auto type: result, points, the student's answer and the key as text", () => {
    expect(byId.get("i-mc")).toEqual({
      item_id: "i-mc",
      number: 1,
      result: "incorrect",
      earned: 0,
      max: 1,
      your_answer: "Lyon a map",
      correct_answer: "Paris",
    });
    expect(byId.get("i-multi")).toMatchObject({ result: "correct", earned: 1, max: 1, your_answer: "$2$\n$3$" });
    expect(byId.get("i-multi")!.correct_answer).toBeUndefined();
    expect(byId.get("i-short")).toMatchObject({ result: "correct", your_answer: "0.5" });
    expect(byId.get("i-match")).toMatchObject({
      result: "incorrect",
      your_answer: "Dog → Kitten\nCat → Puppy",
      correct_answer: "Dog → Puppy\nCat → Kitten",
    });
    expect(byId.get("i-order")).toMatchObject({ result: "correct", your_answer: "1. First\n2. Second" });
    expect(byId.get("i-hot")).toMatchObject({
      result: "incorrect",
      your_answer: "Region 1",
      correct_answer: "Region 2",
    });
    expect(byId.get("i-table")).toMatchObject({
      result: "partial",
      earned: 2,
      max: 3,
      your_answer: "Trial 1, Mass: 2.50\nTrial 1, Volume: 11\nRow 2, Mass: 3",
      correct_answer: "Trial 1, Mass: 2.5\nTrial 1, Volume: 10\nRow 2, Mass: 3",
    });
  });

  test("pending: essays, drawings, keyless and human items — no points, no key", () => {
    for (const id of ["i-essay", "i-draw", "i-keyless", "i-human"]) {
      const line = byId.get(id)!;
      expect(line.result).toBe("pending");
      expect(line.earned).toBeNull();
      expect(line.max).toBeNull();
      expect(line.correct_answer).toBeUndefined();
    }
    expect(byId.get("i-essay")!.your_answer).toBe("My essay.");
    expect(byId.get("i-draw")!.your_answer).toBe("[drawing]");
    expect(fb.pending_count).toBe(4);
  });

  test("ai / hybrid methods are pending even with a final present", () => {
    const aiEssay = item({ id: "i-ai", position: 0, type: "essay", config: { scoring_method: "ai" } });
    const out = buildFeedback({
      settings: settings({ student_feedback: "right_wrong" }),
      items: [aiEssay],
      responses: new Map([["i-ai", { type: "essay", text: "t" }]]),
      finals: new Map([["i-ai", { points: 3, max_points: 4 }]]),
    })!;
    expect(out.items![0]!.result).toBe("pending");
    expect(out).toMatchObject({ earned: 0, max_auto: 0, pending_count: 1 });
  });

  test("an answered auto item without a final is pending", () => {
    const out = buildFeedback({
      settings: settings({ student_feedback: "right_wrong" }),
      items: [SHORT],
      responses: new Map([["i-short", { type: "short_text", text: "0.5" }]]),
      finals: new Map(),
    })!;
    expect(out.items![0]!.result).toBe("pending");
    expect(out.pending_count).toBe(1);
  });

  test("a skipped KEYED auto item is incorrect, 0 of its max; a skipped keyless one is pending", () => {
    const out = buildFeedback({
      settings: settings({ student_feedback: "answers", answers_release: "at_hand_in" }),
      items: [MC, TABLE, KEYLESS],
      responses: new Map(),
      finals: new Map(),
    })!;
    expect(out.items!.map((i) => [i.result, i.earned, i.max, i.your_answer])).toEqual([
      ["incorrect", 0, 1, null],
      ["incorrect", 0, 3, null],
      ["pending", null, null, null],
    ]);
    expect(out).toMatchObject({ earned: 0, max_auto: 4, pending_count: 1 });
    expect(out.items![0]!.correct_answer).toBe("Paris");
  });
});

describe("text helpers", () => {
  test("asset refs become alt text or [image]; no asset id survives", () => {
    expect(plainText("See ![the cell](asset:abc) and ![ ](asset:def).")).toBe("See the cell and [image].");
    const fb = buildFeedback(input({ student_feedback: "answers", answers_release: "at_hand_in" }))!;
    expect(JSON.stringify(fb)).not.toContain("asset:");
  });

  test("an image-only choice reads [image]", () => {
    expect(yourAnswerText(MULTI, { type: "multiple_choice_multi", choice_ids: ["z"] })).toBe("[image]");
  });

  test("a keyless item has no key text", () => {
    expect(correctAnswerText(KEYLESS)).toBeNull();
    expect(correctAnswerText(ESSAY)).toBeNull();
  });
});
