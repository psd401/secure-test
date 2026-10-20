import { describe, expect, test } from "bun:test";
import { clean, extrema, intersections, pointsOfInterest, zeros } from "../src/engine/poi";

describe("zeros", () => {
  test("simple roots, exact", () => {
    expect(zeros((x) => x * x - 4, -10, 10)).toEqual([-2, 2]);
    expect(zeros((x) => 2 * x + 1, -10, 10)).toEqual([-0.5]);
  });

  test("irrational roots to full precision", () => {
    const [a, b] = zeros((x) => x * x - 2, -10, 10);
    expect(a).toBeCloseTo(-Math.SQRT2, 12);
    expect(b).toBeCloseTo(Math.SQRT2, 12);
  });

  test("a touching zero (double root) is found once", () => {
    expect(zeros((x) => (x - 1) * (x - 1), -10, 10)).toEqual([1]);
  });

  test("a pole is not a zero", () => {
    expect(zeros((x) => 1 / x, -10, 10)).toEqual([]);
    const tz = zeros(Math.tan, -5, 5);
    expect(tz.length).toBe(3);
    expect(tz[0]).toBeCloseTo(-Math.PI, 10);
    expect(tz[1]).toBe(0);
  });

  test("zeros of sin across the view", () => {
    expect(zeros(Math.sin, -10, 10).length).toBe(7);
  });

  test("nothing for a function with no real zeros", () => {
    expect(zeros((x) => x * x + 1, -10, 10)).toEqual([]);
  });
});

describe("extrema", () => {
  test("parabola vertex", () => {
    expect(extrema((x) => (x - 3) ** 2 + 1, -10, 10)).toEqual([{ t: 3, v: 1, max: false }]);
    expect(extrema((x) => -((x + 2) ** 2) + 5, -10, 10)).toEqual([{ t: -2, v: 5, max: true }]);
  });

  test("cubic has one max and one min", () => {
    const e = extrema((x) => x ** 3 - 3 * x, -10, 10);
    expect(e).toEqual([
      { t: -1, v: 2, max: true },
      { t: 1, v: -2, max: false },
    ]);
  });

  test("no extremum next to a pole", () => {
    expect(extrema((x) => 1 / x, -10, 10)).toEqual([]);
  });

  test("lines and constants have none", () => {
    expect(extrema((x) => 2 * x, -10, 10)).toEqual([]);
    expect(extrema(() => 3, -10, 10)).toEqual([]);
  });

  test("|x|+1 has a corner minimum; |x| touches zero instead", () => {
    expect(extrema((x) => Math.abs(x) + 1, -10, 10)).toEqual([{ t: 0, v: 1, max: false }]);
    expect(extrema(Math.abs, -10, 10)).toEqual([]);
    expect(pointsOfInterest(Math.abs, -10, 10)).toEqual([{ kind: "zero", t: 0, v: 0 }]);
  });
});

describe("pointsOfInterest", () => {
  test("parabola: two zeros, a minimum, and the y-intercept", () => {
    const p = pointsOfInterest((x) => x * x - 4, -10, 10);
    expect(p).toEqual([
      { kind: "zero", t: -2, v: 0 },
      { kind: "min", t: 0, v: -4 },
      { kind: "zero", t: 2, v: 0 },
    ]);
  });

  test("the intercept is reported when it is nothing else", () => {
    expect(pointsOfInterest((x) => 2 * x + 6, -10, 10)).toEqual([
      { kind: "zero", t: -3, v: 0 },
      { kind: "intercept", t: 0, v: 6 },
    ]);
  });

  test("a vertex on the axis is a zero, once", () => {
    expect(pointsOfInterest((x) => (x - 2) ** 2, -10, 10)).toEqual([
      { kind: "intercept", t: 0, v: 4 },
      { kind: "zero", t: 2, v: 0 },
    ]);
  });

  test("no intercept when 0 is outside the range", () => {
    expect(pointsOfInterest((x) => x, 1, 5)).toEqual([]);
  });
});

describe("intersections", () => {
  test("line and parabola", () => {
    expect(intersections((x) => x * x, (x) => x + 2, -10, 10)).toEqual([
      { kind: "intersection", t: -1, v: 1 },
      { kind: "intersection", t: 2, v: 4 },
    ]);
  });

  test("parallel lines never meet", () => {
    expect(intersections((x) => x, (x) => x + 1, -10, 10)).toEqual([]);
  });

  test("tangent line touches once", () => {
    expect(intersections((x) => x * x, (x) => 2 * x - 1, -10, 10)).toEqual([{ kind: "intersection", t: 1, v: 1 }]);
  });
});

describe("clean", () => {
  test("snaps float noise", () => {
    expect(clean(0.9999999999998, 20)).toBe(1);
    expect(clean(0.1 + 0.2, 20)).toBe(0.3);
    expect(clean(-1e-15, 20)).toBe(0);
    expect(clean(Math.SQRT2, 20)).toBe(Math.SQRT2);
  });
});
