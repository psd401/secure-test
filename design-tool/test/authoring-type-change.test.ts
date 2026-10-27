// R-6 (docs/editor-redesign-design.md, Phase 4 slice B): in-place type change
// and the new editor's empty new questions. Pure — what a change keeps, when
// it warns, and that every body the editor would send passes the item write
// boundary (parseItemBody with the R-12 empty-stem allowance).
import { describe, expect, test } from "bun:test";
import { ITEM_TYPES, type ItemType } from "../db/schema";
import { ALLOWED_SCORING_METHODS, parseItemBody } from "../lib/api/items";
import { changeItemType, hasAnswerKey, typeChangeTargets, TYPE_CHANGE_NOT_TARGETS } from "../lib/authoring/typeChange";
import { newItemSeed } from "../lib/authoring/insertTypes";

// The editor module is a client component; its pure helpers load under bun.
const editor = await import("../app/dashboard/[id]/AssessmentEditor");
type View = ReturnType<typeof editor.rowToView>;

const allowed = (t: ItemType) => ALLOWED_SCORING_METHODS[t];

function view(type: ItemType, over: Partial<View> = {}): View {
  return { ...editor.defaultItemFor(type), ...newItemSeed(type), id: "i1", position: 0, ...over } as View;
}

function change(item: View, target: ItemType) {
  return changeItemType(item, target, editor.defaultItemFor(target), allowed);
}

const MC = view("multiple_choice_single", {
  stem: "Which is a prime?",
  choices: [
    { id: "a", text: "4" },
    { id: "b", text: "7" },
    { id: "c", text: "9" },
  ],
  correct_choice_ids: ["b"],
  standards: ["Unit 2"],
  no_calculator: true,
});

describe("what a type change keeps", () => {
  test("multiple choice → multiple select keeps the choices and the key, with no warning", () => {
    const r = change(MC, "multiple_choice_multi");
    expect(r.item.type).toBe("multiple_choice_multi");
    expect(r.item.stem).toBe(MC.stem);
    expect(r.item.choices).toEqual(MC.choices);
    expect(r.item.correct_choice_ids).toEqual(["b"]);
    expect(r.item.standards).toEqual(["Unit 2"]);
    expect(r.item.no_calculator).toBe(true);
    expect(r.lost).toEqual([]);
    expect(r.keyLost).toBe(false);
  });

  test("multiple select with two correct → multiple choice warns that the key goes", () => {
    const multi = { ...MC, type: "multiple_choice_multi" as const, correct_choice_ids: ["a", "b"] };
    const r = change(multi, "multiple_choice_single");
    expect(r.item.choices).toEqual(MC.choices);
    expect(r.item.correct_choice_ids).toEqual([]);
    expect(r.keyLost).toBe(true);
    // One correct answer carries over silently.
    expect(change({ ...multi, correct_choice_ids: ["c"] }, "multiple_choice_single")).toMatchObject({
      lost: [],
      item: { correct_choice_ids: ["c"] },
    });
  });

  test("multiple choice → ordering: the choices become the steps; a key warns", () => {
    const r = change(MC, "order");
    expect(r.item.sequence).toEqual([
      { id: "s1", label: "4" },
      { id: "s2", label: "7" },
      { id: "s3", label: "9" },
    ]);
    expect(r.keyLost).toBe(true);
    expect(change({ ...MC, correct_choice_ids: [] }, "order").lost).toEqual([]);
  });

  test("ordering → multiple choice: the steps become choices; the order (its key) warns", () => {
    const ord = view("order", {
      stem: "Put in order",
      sequence: [
        { id: "s1", label: "One" },
        { id: "s2", label: "Two" },
      ],
    });
    const r = change(ord, "multiple_choice_single");
    expect(r.item.choices).toEqual([
      { id: "a", text: "One" },
      { id: "b", text: "Two" },
    ]);
    expect(r.item.sequence).toBeNull();
    expect(r.keyLost).toBe(true);
  });

  test("multiple choice → short answer drops the choices and the key, and says so", () => {
    const r = change(MC, "short_text");
    expect(r.item.choices).toEqual([]);
    expect(r.item.correct_choice_ids).toEqual([]);
    expect(r.lost).toEqual(["3 choices", "the correct answer"]);
    expect(r.keyLost).toBe(true);
  });

  test("short answer → essay warns only when there is an answer to lose", () => {
    const st = view("short_text", { stem: "Name it", correct_answer: "Mars" });
    expect(change(st, "essay").keyLost).toBe(true);
    expect(change({ ...st, correct_answer: "" }, "essay").lost).toEqual([]);
  });

  test("an essay's rubric is named before it is lost; an AI scoring method resets", () => {
    const essay = view("essay", {
      stem: "Explain",
      rubric: { style: "analytic", criteria: [] } as unknown as View["rubric"],
      scoring_method: "ai",
    });
    const r = change(essay, "short_text");
    expect(r.lost).toContain("the scoring rubric");
    expect(r.lost).toContain("the scoring method you picked (it goes back to the default)");
    expect(r.item.scoring_method).toBeNull();
    expect(r.item.rubric).toBeNull();
    // A method the new type allows stays.
    expect(change({ ...MC, scoring_method: "human" }, "short_text").item.scoring_method).toBe("human");
  });

  test("hotspot regions and table cells are named as the key", () => {
    const hs = view("hotspot", {
      stem: "Click it",
      image_asset_id: "00000000-0000-4000-8000-000000000001",
      regions: [{ id: "r1", x: 0, y: 0, w: 0.5, h: 0.5 }] as View["regions"],
      correct_region_ids: ["r1"],
    });
    expect(hasAnswerKey(hs)).toBe(true);
    const r = change(hs, "drawing_upload");
    expect(r.keyLost).toBe(true);
    expect(r.lost).toContain("the picture and its regions");
    expect(r.item.regions).toBeNull();
  });
});

describe("which types are offered", () => {
  test("matching, table and fill-in-the-blank are never targets; the current type is not listed", () => {
    for (const from of ITEM_TYPES) {
      const targets = typeChangeTargets(view(from), ITEM_TYPES);
      expect(targets.map((t) => t.type)).not.toContain(from);
      for (const t of TYPE_CHANGE_NOT_TARGETS) expect(targets.map((x) => x.type)).not.toContain(t);
    }
  });

  test("ordering needs a multiple-choice question whose choices all have text", () => {
    const orderOf = (item: View) => typeChangeTargets(item, ITEM_TYPES).find((t) => t.type === "order")!;
    expect(orderOf(MC).available).toBe(true);
    expect(orderOf({ ...MC, choices: [{ id: "a", text: "4" }, { id: "b", text: " " }] }).available).toBe(false);
    expect(orderOf(view("short_text")).available).toBe(false);
  });
});

describe("the bodies the new editor sends pass the write boundary", () => {
  test("every new (empty) question, with the R-12 empty-stem allowance", () => {
    for (const type of ITEM_TYPES) {
      const body = editor.itemPatchBody(view(type));
      expect(() => parseItemBody(body, { allowEmptyStem: true })).not.toThrow();
      // The seeds a type needs are the only text it starts with.
      if (type !== "fill_blank") expect(body.stem).toBe("");
    }
  });

  test("without the allowance an empty stem is refused, as today", () => {
    const body = editor.itemPatchBody(view("multiple_choice_single"));
    expect(() => parseItemBody(body)).toThrow();
    expect(() => parseItemBody(body, { allowEmptyStem: false })).toThrow();
    // Every other rule still runs with the allowance (one choice is too few).
    expect(() =>
      parseItemBody({ ...body, choices: [{ id: "a", text: "" }] }, { allowEmptyStem: true }),
    ).toThrow();
  });

  test("every offered change of every type's question, empty or filled", () => {
    const filled: View[] = [MC, view("short_text", { stem: "x", correct_answer: "y" }), ...ITEM_TYPES.map((t) => view(t))];
    for (const item of filled) {
      for (const target of typeChangeTargets(item, ITEM_TYPES)) {
        if (!target.available) continue;
        const next = change(item, target.type).item;
        const body = editor.itemPatchBody(next);
        expect({ from: item.type, to: target.type, ok: safe(() => parseItemBody(body, { allowEmptyStem: true })) }).toEqual({
          from: item.type,
          to: target.type,
          ok: true,
        });
      }
    }
  });
});

function safe(fn: () => unknown): boolean | string {
  try {
    fn();
    return true;
  } catch (e) {
    return e instanceof Error ? e.message.slice(0, 300) : "error";
  }
}
