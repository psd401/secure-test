import { describe, expect, test } from "bun:test";
import {
  addSliders,
  defaultRange,
  emptyRow,
  formatSliderValue,
  insertRow,
  latexName,
  nextColor,
  PALETTE,
  removeRow,
  setSliderValue,
  snapSlider,
  type RowState,
} from "../src/ui/state";
import { withoutEscape } from "../src/ui/shortcuts";
import { fromPx, gridStep, makeViewport, pan, resize, scale, tickLabel, ticks, toPx, zoomAt } from "../src/ui/viewport";

describe("viewport", () => {
  const v = makeViewport(600, 400);

  test("square scale, centred on the origin", () => {
    expect(v).toEqual({ xmin: -10, xmax: 10, ymin: -400 / 60, ymax: 400 / 60, width: 600, height: 400 });
    const [sx, sy] = scale(v);
    expect(sx).toBeCloseTo(sy, 12);
  });

  test("toPx and fromPx are inverse", () => {
    expect(toPx(v, 0, 0)).toEqual([300, 200]);
    expect(toPx(v, -10, v.ymax)).toEqual([0, 0]);
    const [x, y] = fromPx(v, 123, 77);
    const [px, py] = toPx(v, x, y);
    expect(px).toBeCloseTo(123, 9);
    expect(py).toBeCloseTo(77, 9);
  });

  test("zoom keeps the point under the pointer fixed", () => {
    const z = zoomAt(v, 2, 450, 100);
    const before = fromPx(v, 450, 100);
    const after = fromPx(z, 450, 100);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
    expect(z.xmax - z.xmin).toBeCloseTo(10, 9);
  });

  test("zoom refuses absurd spans", () => {
    expect(zoomAt(v, 1e20, 300, 200)).toBe(v);
    expect(zoomAt(v, 1e-20, 300, 200)).toBe(v);
  });

  test("dragging right reveals what was left", () => {
    const p = pan(v, 30, 0);
    expect(p.xmin).toBeCloseTo(-11, 9);
    expect(p.xmax).toBeCloseTo(9, 9);
    const q = pan(v, 0, 30);
    expect(q.ymax).toBeCloseTo(v.ymax + 1, 9);
  });

  test("resize keeps centre and scale", () => {
    const r = resize(v, 300, 400);
    expect(r.xmax - r.xmin).toBeCloseTo(10, 9);
    expect((r.xmin + r.xmax) / 2).toBeCloseTo(0, 12);
  });

  test("grid steps are 1, 2 or 5 × 10ⁿ", () => {
    expect(gridStep(20, 600)).toEqual({ major: 5, minor: 1 });
    expect(gridStep(20, 1200)).toEqual({ major: 2, minor: 0.5 });
    expect(gridStep(0.02, 600).major).toBeCloseTo(0.005, 15);
    expect(gridStep(2e6, 600).major).toBe(500000);
  });

  test("ticks don't drift and labels don't show float noise", () => {
    expect(ticks(-1, 1, 0.2).map((t) => tickLabel(t, 0.2))).toEqual([
      "−1.0", "−0.8", "−0.6", "−0.4", "−0.2", "0", "0.2", "0.4", "0.6", "0.8", "1.0",
    ]);
    expect(tickLabel(5, 5)).toBe("5");
    expect(tickLabel(-10, 5)).toBe("−10");
    expect(tickLabel(2e6, 5e5)).toBe("2×10^6");
    expect(ticks(0, 1e9, 1e-3)).toEqual([]);
    // Far past 2^53 a k++ counter never advances; this must return, not hang.
    expect(ticks(1e17, 1e17 + 32, 2)).toEqual([]);
    expect(ticks(-Infinity, 1, 1)).toEqual([]);
    expect(ticks(0, 1, 0)).toEqual([]);
  });
});

describe("state", () => {
  const row = (latex: string, color: string = PALETTE[0]): RowState => ({ id: latex, latex, color, hidden: false });

  test("next colour is the least used", () => {
    expect(nextColor([])).toBe(PALETTE[0]);
    expect(nextColor([row("a", PALETTE[0])])).toBe(PALETTE[1]);
    const all = PALETTE.map((c) => row(c, c));
    expect(nextColor(all)).toBe(PALETTE[0]);
  });

  test("insert after a row, and at the end", () => {
    const rows = [row("a"), row("b")];
    const [r1, id] = insertRow(rows, "a", "z");
    expect(r1.map((r) => r.latex)).toEqual(["a", "z", "b"]);
    expect(r1[1]!.id).toBe(id);
    const [r2] = insertRow(rows, null);
    expect(r2.map((r) => r.latex)).toEqual(["a", "b", ""]);
  });

  test("removing the last row leaves one empty row", () => {
    expect(removeRow([row("a")], "a").map((r) => r.latex)).toEqual([""]);
  });

  test("add sliders before the row that needs them", () => {
    const rows = [row("y=mx+b")];
    const out = addSliders(rows, ["m", "b"], "y=mx+b");
    expect(out.map((r) => r.latex)).toEqual(["m=1", "b=1", "y=mx+b"]);
    expect(out[0]!.slider).toEqual({ min: -10, max: 10, step: 0 });
    expect(out[0]!.color).not.toBe(out[1]!.color);
  });

  test("slider names as LaTeX", () => {
    expect(latexName("a")).toBe("a");
    expect(latexName("a_1")).toBe("a_{1}");
    expect(latexName("theta")).toBe("\\theta");
  });

  test("slider value edits keep the name", () => {
    expect(setSliderValue("a=3", 4.5)).toBe("a=4.5");
    expect(setSliderValue("a_{1}=-2", 0.1 + 0.2)).toBe("a_{1}=0.3");
    expect(formatSliderValue(-0)).toBe("0");
  });

  test("snapping", () => {
    expect(snapSlider(3.14159, { min: -10, max: 10, step: 0 })).toBe(3.2);
    expect(snapSlider(3.14159, { min: 0, max: 10, step: 0.5 })).toBe(3);
    expect(snapSlider(99, { min: 0, max: 10, step: 1 })).toBe(10);
  });

  test("default ranges widen to hold the value", () => {
    expect(defaultRange(3)).toEqual({ min: -10, max: 10, step: 0 });
    expect(defaultRange(250)).toEqual({ min: 0, max: 1000, step: 0 });
    expect(defaultRange(-42)).toEqual({ min: -100, max: 0, step: 0 });
  });

  test("ids are unique", () => {
    const ids = new Set(Array.from({ length: 100 }, () => emptyRow([]).id));
    expect(ids.size).toBe(100);
  });
});

describe("withoutEscape (finding E-1)", () => {
  test("drops MathLive's Escape bindings and keeps the rest", () => {
    const bindings = [
      { key: "[Escape]", ifMode: "math", command: ["switchMode", "latex"] },
      { key: "[Escape]", ifMode: "text", command: ["switchMode", "latex"] },
      { key: "shift+[Escape]", ifMode: "latex", command: ["complete", "reject"] },
      { key: "[Tab]", command: "moveToNextGroup" },
      { key: "[Enter]", ifMode: "latex", command: ["complete", "accept-all"] },
    ];
    expect(withoutEscape(bindings).map((b) => b.key)).toEqual(["[Tab]", "[Enter]"]);
  });
});
