// B1 slice 2 (docs/point-weighting-design.md): the editor's Points field —
// its parse rule, the hint, the outline labels, the save body and the
// publish-lock door — all pure, no DOM.
import { describe, expect, test } from "bun:test";
import type { Rubric } from "@secure-test/schema";
import { itemMaxPoints, pointsHint } from "../lib/scoring/maxPoints";

const model = await import("../app/dashboard/[id]/editorModel");
const { parsePoints } = await import("../app/dashboard/[id]/PointsField");
const { pointsLabel } = await import("../app/dashboard/[id]/OutlineRail");

type View = import("../app/dashboard/[id]/editorModel").ItemView;
const view = (type: View["type"], over: Partial<View> = {}): View =>
  ({ ...model.defaultItemFor(type), id: "i1", position: 0, ...over }) as View;

const RUBRIC = {
  style: "analytic",
  criteria: ["a", "b"].map((id) => ({
    id,
    name: id,
    levels: [1, 2, 3, 4].map((p) => ({ id: `${id}${p}`, label: `L${p}`, points: p })),
  })),
} as Rubric;

const table = (points: number | null) =>
  view("table", {
    columns: [{ id: "c1", label: "C" }],
    rows: [
      { id: "r1", label: "1" },
      { id: "r2", label: "2" },
      { id: "r3", label: "3" },
      { id: "r4", label: "4" },
    ],
    cell_keys: { r1: { c1: "a" }, r2: { c1: "b" }, r3: { c1: "c" }, r4: { c1: "d" } },
    points,
  } as Partial<View>);

describe("parsePoints (the field's D5 rule)", () => {
  test("empty = natural max (null)", () => {
    expect(parsePoints("")).toEqual({ ok: true, value: null });
    expect(parsePoints("  ")).toEqual({ ok: true, value: null });
  });
  test("valid values", () => {
    expect(parsePoints("6")).toEqual({ ok: true, value: 6 });
    expect(parsePoints("2.25")).toEqual({ ok: true, value: 2.25 });
    expect(parsePoints("100")).toEqual({ ok: true, value: 100 });
  });
  test("refusals name the rule", () => {
    expect(parsePoints("0")).toMatchObject({ ok: false, message: "Points must be more than 0." });
    expect(parsePoints("101")).toMatchObject({ ok: false, message: "Points can be at most 100." });
    expect(parsePoints("1.234")).toMatchObject({ ok: false, message: "Use at most 2 decimal places." });
    expect(parsePoints("abc")).toMatchObject({ ok: false });
  });
});

describe("the hint and the outline numbers run on an ItemView", () => {
  test("a table names each keyed cell's share", () => {
    expect(pointsHint(model.viewMaxInput(table(6)))).toBe("Worth 6 · 1.5 per keyed cell");
    expect(pointsHint(model.viewMaxInput(table(null)))).toBe("Worth 4 · 1 per keyed cell");
    expect(itemMaxPoints(model.viewMaxInput(table(6)))).toBe(6);
    expect(itemMaxPoints(model.viewMaxInput(table(null)))).toBe(4);
  });
  test("a rubric item names its scale", () => {
    const essay = view("essay", { rubric: RUBRIC, points: 4 });
    expect(pointsHint(model.viewMaxInput(essay))).toBe("Rubric is out of 8 · scaled to 4");
    expect(pointsHint(model.viewMaxInput({ ...essay, points: null }))).toBe("Rubric is out of 8");
  });
  test("an all-or-nothing type has no hint (the placeholder says it)", () => {
    expect(pointsHint(model.viewMaxInput(view("multiple_choice_single", { points: 3 })))).toBeNull();
    expect(itemMaxPoints(model.viewMaxInput(view("multiple_choice_single")))).toBe(1);
  });
  test("a graph with no key yet has no per-shape hint (it is worth 1)", () => {
    const graph = view("graph", { board: { x: [-5, 5], y: [-5, 5] } as never, graph_key: null });
    expect(pointsHint(model.viewMaxInput(graph))).toBeNull();
  });
  test("pointsLabel", () => {
    expect(pointsLabel(1, true)).toBe("1 pt");
    expect(pointsLabel(2.5, true)).toBe("2.5 pts");
    expect(pointsLabel(12)).toBe("12 points");
    expect(pointsLabel(1)).toBe("1 point");
  });
});

describe("saving points", () => {
  test("the save body always carries points (null clears)", () => {
    expect(model.itemPatchBody(view("multiple_choice_single", { points: 3 })).points).toBe(3);
    expect(model.itemPatchBody(view("multiple_choice_single")).points).toBeNull();
  });
  test("rowToView reads the column", () => {
    const row = { ...view("short_text"), config: {}, standards: [], points: 2.5 };
    expect(model.rowToView(row as never).points).toBe(2.5);
  });
  test("D7: a points-only edit passes the published card's door", () => {
    const before = view("multiple_choice_single", { points: null });
    expect(model.answerKeyOnlyChange(before, { ...before, points: 5 })).toBe(true);
    expect(model.answerKeyOnlyChange(before, { ...before, points: 5, stem: "new" })).toBe(false);
  });
});
