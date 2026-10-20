import { describe, expect, test } from "bun:test";
import { sampleCurve, type Polyline } from "../src/engine/sample";

// A 600×400 px view of x ∈ [-10, 10], y ∈ [-10, 10].
const VIEW = { pixels: 600, valueScale: 400 / 20, valueSpanPx: 400 };

function points(p: Polyline): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < p.length; k += 2) out.push([p[k]!, p[k + 1]!]);
  return out;
}

describe("sampleCurve", () => {
  test("a line is one piece across the range, with few points", () => {
    const pieces = sampleCurve((x) => 2 * x + 1, -10, 10, VIEW);
    expect(pieces.length).toBe(1);
    const pts = points(pieces[0]!);
    expect(pts[0]).toEqual([-10, -19]);
    expect(pts.at(-1)).toEqual([10, 21]);
    expect(pts.length).toBeLessThanOrEqual(602);
  });

  test("every emitted point lies on the curve", () => {
    const f = (x: number) => Math.sin(3 * x) * x;
    for (const piece of sampleCurve(f, -10, 10, VIEW)) {
      for (const [x, y] of points(piece)) expect(y).toBe(f(x));
    }
  });

  test("x-values increase monotonically within a piece", () => {
    for (const piece of sampleCurve((x) => x * x * x, -10, 10, VIEW)) {
      const pts = points(piece);
      for (let k = 1; k < pts.length; k++) expect(pts[k]![0]).toBeGreaterThan(pts[k - 1]![0]);
    }
  });

  test("tan breaks at each asymptote instead of drawing a vertical line", () => {
    const pieces = sampleCurve(Math.tan, -10, 10, VIEW);
    // Asymptotes at ±π/2, ±3π/2, ±5π/2: six in [-10, 10] → seven pieces.
    expect(pieces.length).toBe(7);
    for (const piece of pieces) {
      const pts = points(piece);
      for (let k = 1; k < pts.length; k++) {
        // No segment crosses an asymptote (from +big to −big).
        const [a, b] = [pts[k - 1]![1], pts[k]![1]];
        expect(Math.sign(a) !== Math.sign(b) && Math.abs(a) > 5 && Math.abs(b) > 5).toBe(false);
      }
    }
  });

  test("1/x breaks at 0", () => {
    expect(sampleCurve((x) => 1 / x, -10, 10, VIEW).length).toBe(2);
  });

  test("floor has a piece per step, no risers", () => {
    const pieces = sampleCurve(Math.floor, -3, 3, { pixels: 600, valueScale: 100, valueSpanPx: 50 });
    expect(pieces.length).toBe(6);
  });

  test("√x starts at the domain edge, not a pixel later", () => {
    const pieces = sampleCurve(Math.sqrt, -10, 10, VIEW);
    expect(pieces.length).toBe(1);
    const first = points(pieces[0]!)[0]!;
    expect(first[0]).toBeGreaterThanOrEqual(0);
    expect(first[0]).toBeLessThan(1e-6);
  });

  test("√(4−x²) reaches both edges", () => {
    const f = (x: number) => Math.sqrt(4 - x * x);
    const pts = points(sampleCurve(f, -10, 10, VIEW)[0]!);
    expect(pts[0]![0]).toBeCloseTo(-2, 5);
    expect(pts.at(-1)![0]).toBeCloseTo(2, 5);
  });

  test("an everywhere-undefined function gives nothing, cheaply", () => {
    let calls = 0;
    const pieces = sampleCurve(
      () => {
        calls++;
        return NaN;
      },
      -10,
      10,
      VIEW,
    );
    expect(pieces).toEqual([]);
    expect(calls).toBeLessThan(5_000);
  });

  test("sin(1/x) stays within the evaluation budget", () => {
    let calls = 0;
    sampleCurve(
      (x) => {
        calls++;
        return Math.sin(1 / x);
      },
      -1,
      1,
      { ...VIEW, budget: 20_000 },
    );
    expect(calls).toBeLessThan(20_000 + 1_000);
  });

  test("bends are refined: a sharp parabola vertex is sampled closely", () => {
    const pts = points(sampleCurve((x) => 100 * x * x, -1, 1, { pixels: 50, valueScale: 400, valueSpanPx: 400 })[0]!);
    const near = pts.filter(([x]) => Math.abs(x) < 0.04).length;
    expect(near).toBeGreaterThan(3);
  });

  test("a narrow spike between samples is found", () => {
    const f = (x: number) => (Math.abs(x - 0.0123) < 0.005 ? 5 : 0);
    const ys = sampleCurve(f, -10, 10, VIEW).flatMap((p) => points(p).map(([, y]) => y));
    expect(ys).toContain(5);
  });
});
