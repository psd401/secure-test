import { describe, expect, test } from "bun:test";
import type { ItemRow } from "../db/schema";
import { UpdateItemBody } from "../lib/api/items";
import { isAnswerKeyOnlyPatch } from "../lib/api/requireDraft";

// 2026-09-01: the publish lock's one door — a PATCH that changes nothing but
// the answer key. Pure predicate; the route test in items-api covers the
// wiring.

function row(over: Partial<ItemRow>): ItemRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    assessment_id: "00000000-0000-0000-0000-000000000002",
    position: 0,
    type: "multiple_choice_single",
    stem: "What is 2 + 2?",
    choices: [
      { id: "a", text: "3" },
      { id: "b", text: "4" },
    ],
    correct_choice_ids: [],
    correct_answer: null,
    config: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  } as unknown as ItemRow;
}

const base = {
  type: "multiple_choice_single" as const,
  stem: "What is 2 + 2?",
  choices: [
    { id: "a", text: "3" },
    { id: "b", text: "4" },
  ],
};

describe("isAnswerKeyOnlyPatch", () => {
  test("filling the MC key is key-only", () => {
    const body = UpdateItemBody.parse({ ...base, correct_choice_ids: ["b"] });
    expect(isAnswerKeyOnlyPatch(body, row({}))).toBe(true);
  });

  test("changing the stem is not", () => {
    const body = UpdateItemBody.parse({ ...base, stem: "reworded", correct_choice_ids: ["b"] });
    expect(isAnswerKeyOnlyPatch(body, row({}))).toBe(false);
  });

  test("changing a choice's text is not, even with the same key", () => {
    const body = UpdateItemBody.parse({
      ...base,
      choices: [
        { id: "a", text: "3" },
        { id: "b", text: "four" },
      ],
      correct_choice_ids: ["b"],
    });
    expect(isAnswerKeyOnlyPatch(body, row({ correct_choice_ids: ["b"] }))).toBe(false);
  });

  test("choice key order does not matter (jsonb round-trip)", () => {
    const body = UpdateItemBody.parse({ ...base, correct_choice_ids: ["a"] });
    const stored = row({
      choices: [
        { text: "3", id: "a" },
        { text: "4", id: "b" },
      ],
    });
    expect(isAnswerKeyOnlyPatch(body, stored)).toBe(true);
  });

  test("short_text: filling correct_answer is key-only; new stem is not", () => {
    const st = { type: "short_text" as const, stem: "Capital?" };
    const stored = row({ type: "short_text", stem: "Capital?", choices: [], correct_answer: "" });
    expect(isAnswerKeyOnlyPatch(UpdateItemBody.parse({ ...st, correct_answer: "Olympia" }), stored)).toBe(true);
    expect(
      isAnswerKeyOnlyPatch(UpdateItemBody.parse({ ...st, stem: "Capital of WA?", correct_answer: "Olympia" }), stored),
    ).toBe(false);
  });

  test("an explicit scoring_method change is not key-only", () => {
    const body = UpdateItemBody.parse({ ...base, correct_choice_ids: ["b"], scoring_method: "human" });
    expect(isAnswerKeyOnlyPatch(body, row({}))).toBe(false);
  });
});

// E3 slice 1: a table's cell_keys is its answer key — the publish lock admits
// filling or changing it, and nothing else about the grid.
describe("isAnswerKeyOnlyPatch: table (E3)", () => {
  const grid = {
    type: "table" as const,
    stem: "Fill in",
    columns: [{ id: "c1", label: "A" }, { id: "c2", label: "B" }],
    rows: [{ id: "r1", label: "x" }],
  };
  const stored = row({
    type: "table",
    stem: "Fill in",
    choices: [],
    config: { columns: grid.columns, rows: grid.rows },
  });

  test("filling cell_keys on a keyless table is key-only", () => {
    const body = UpdateItemBody.parse({ ...grid, cell_keys: { r1: { c1: "1" } } });
    expect(isAnswerKeyOnlyPatch(body, stored)).toBe(true);
  });

  test("changing a key is key-only; changing a label or adding a column is not", () => {
    const keyed = row({ ...stored, config: { ...stored.config, cell_keys: { r1: { c1: "1" } } } });
    expect(isAnswerKeyOnlyPatch(UpdateItemBody.parse({ ...grid, cell_keys: { r1: { c2: "2" } } }), keyed)).toBe(true);
    expect(
      isAnswerKeyOnlyPatch(
        UpdateItemBody.parse({ ...grid, rows: [{ id: "r1", label: "y" }], cell_keys: { r1: { c1: "1" } } }),
        keyed,
      ),
    ).toBe(false);
    expect(
      isAnswerKeyOnlyPatch(
        UpdateItemBody.parse({ ...grid, columns: [...grid.columns, { id: "c3", label: "C" }], cell_keys: { r1: { c1: "1" } } }),
        keyed,
      ),
    ).toBe(false);
  });
});
