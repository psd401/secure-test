// Regressions from the 2026-10-19 adversarial sweep of the engine (three
// independent testers, each finding re-verified). Every case here failed
// before its fix.

import { describe, expect, test } from "bun:test";
import { analyze, type Analysis, type Settings } from "../src/engine/analyze";
import { formatNumber } from "../src/engine/format";
import { restricted } from "../src/engine/index";
import { pointsOfInterest, intersections, zeros } from "../src/engine/poi";
import { sampleCurve } from "../src/engine/sample";

const rows = (...latex: string[]) => latex.map((l, i) => ({ id: String(i), latex: l }));
const DEG: Settings = { degrees: true, disabled: new Set() };
const last = (latex: string[], s?: Settings) => analyze(rows(...latex), s).at(-1)!;
const val = (latex: string, s?: Settings) => {
  const a = analyze(rows(latex), s)[0]!;
  if (a.kind !== "value") throw new Error(JSON.stringify(a));
  return a.value as number;
};
function fOf(a: Analysis): (t: number) => number {
  if (a.kind === "curve") return restricted(a);
  if (a.kind === "function" && a.plot) return a.plot.f;
  throw new Error(`not a curve: ${JSON.stringify(a)}`);
}

describe("parsing", () => {
  test("a(x−h)² with a slider a is a·(x−h)², not (a(x−h))²", () => {
    expect(fOf(last(["a=2", "y=a\\left(x-1\\right)^{2}"]))(-2.3)).toBeCloseTo(2 * 3.3 ** 2, 10);
    expect(fOf(last(["c=3", "y=c(0.5)^{x}"]))(-2.3)).toBeCloseTo(3 * 0.5 ** -2.3, 10);
    expect(fOf(last(["y=\\pi(x)^{2}"]))(-2.3)).toBeCloseTo(Math.PI * 2.3 ** 2, 10);
    expect(last(["a=2", "a(2)^{2}"])).toEqual({ kind: "value", value: 8 });
    expect(last(["a=2", "a(3)!"])).toEqual({ kind: "value", value: 12 });
  });

  test("a user function still applies before the power", () => {
    expect(last(["f(x)=x+1", "f(2)^{2}"])).toEqual({ kind: "value", value: 9 });
  });

  test("a piecewise is an ordinary factor", () => {
    const f = fOf(last(["y=2\\left\\{x<0:1,3\\right\\}"]));
    expect(f(-1)).toBe(2);
    expect(f(1)).toBe(6);
    expect(fOf(last(["y=x\\left\\{x>0:1,-1\\right\\}"]))(-3)).toBe(3);
    expect(val("2\\left\\{1<0:1,3\\right\\}")).toBe(6);
    const g = fOf(last(["y=x\\left\\{x>0\\right\\}+1"]));
    expect(g(2)).toBe(3);
    expect(g(-2)).toBeNaN();
  });

  test("trailing condition braces are still a restriction of the whole row", () => {
    const f = fOf(last(["y=x+1\\left\\{x>0\\right\\}"]));
    expect(f(2)).toBe(3);
    expect(f(-2)).toBeNaN();
  });
});

describe("definitions", () => {
  test("a function calling an undefined name reports it on its callers", () => {
    const out = analyze(rows("f(x)=x+z", "y=f(x)", "g(x)=f(x)+1", "f(2)"));
    expect(out[0]).toMatchObject({ kind: "error", missing: ["z"] });
    expect(out[1]).toMatchObject({ kind: "error", missing: ["z"] });
    expect(out[2]).toMatchObject({ kind: "error", missing: ["z"] });
    expect(out[3]).toMatchObject({ kind: "error", missing: ["z"] });
  });

  test("f(x)=ax² before the slider exists offers the slider on y=f(x)", () => {
    expect(analyze(rows("f(x)=ax^2", "y=f(x)"))[1]).toMatchObject({ kind: "error", missing: ["a"] });
  });

  test("a restriction on a definition is part of it", () => {
    const out = analyze(rows("f(x)=x^{2}\\left\\{x>0\\right\\}", "f(-1)", "f(2)", "y=f(x)"));
    expect(out[1]).toMatchObject({ kind: "value" });
    expect((out[1] as { value: number }).value).toBeNaN();
    expect(out[2]).toEqual({ kind: "value", value: 4 });
    expect(fOf(out[3]!)(-1)).toBeNaN();
    expect(fOf(out[0]!)(-1)).toBeNaN();
    expect(val("a=2\\left\\{1<0\\right\\}".replace("a=", "")) ).toBeNaN();
  });
});

describe("exact values", () => {
  test.each([
    ["\\sin(180)", 0],
    ["\\cos(90)", 0],
    ["\\cos(270)", 0],
    ["\\sin(360)", 0],
    ["\\cot(90)", 0],
    ["\\sin(30)", 0.5],
    ["\\sin(150)", 0.5],
    ["\\tan(45)", 1],
    ["\\cos(60)", 0.5],
  ])("degrees: %s = %p", (latex, expected) => expect(val(latex, DEG)).toBe(expected));

  test.each([
    ["\\sin(\\pi)", 0],
    ["\\cos(\\pi/2)", 0],
    ["\\sin 2\\pi", 0],
    ["\\cos(90°)", 0],
    ["\\cos(90^{\\circ})", 0],
    ["\\sin(\\pi/6)", 0.5],
  ])("radians: %s = %p", (latex, expected) => expect(val(latex)).toBe(expected));

  test("tan and sec at 90° are undefined", () => {
    expect(val("\\tan(90)", DEG)).toBeNaN();
    expect(val("\\sec(90)", DEG)).toBeNaN();
    expect(val("\\tan(90°)")).toBeNaN();
  });

  test("round and floor see the exact values", () => {
    expect(val("round(\\sin(30))", DEG)).toBe(1);
    expect(val("round(\\sin(150))", DEG)).toBe(1);
    expect(val("floor(\\tan(45))", DEG)).toBe(1);
  });

  test("inverse trig in degrees lands on whole degrees", () => {
    expect(val("\\arcsin(0.5)", DEG)).toBe(30);
    expect(val("\\arctan(1)", DEG)).toBe(45);
  });

  test("logs of exact powers are exact", () => {
    expect(val("floor(\\log_{10}(1000))")).toBe(3);
    expect(val("ceil(\\log_5 125)")).toBe(3);
    expect(val("\\log_{10}(1000)")).toBe(3);
    expect(val("\\log_2 1024")).toBe(10);
  });

  test("170.5! is finite", () => {
    const v = val("170.5!");
    expect(Number.isFinite(v)).toBe(true);
    // Γ(171.5) = 170! · ~13.07 ≈ 9.483×10³⁰⁷.
    expect(v / 9.4834e307).toBeCloseTo(1, 3);
  });

  test("round(1.005, 2) is 1.01", () => {
    expect(val("round(1.005,2)")).toBe(1.01);
    expect(val("round(-2.675,2)")).toBe(-2.67);
  });
});

describe("formatting", () => {
  test.each([
    [2 ** 35, "34359738368"],
    [12345678901, "12345678901"],
    [123456789012, "123456789012"],
    [2 ** 39, "549755813888"],
    [99999999999 + 2, "100000000001"],
    [999999999999.9, "1×10^12"],
    [1e12, "1×10^12"],
  ])("%p → %s", (x, s) => expect(formatNumber(x)).toBe(s));
});

const VIEW = { pixels: 600, valueScale: 20, valueSpanPx: 400, visible: [-10, 10] as [number, number] };

/** Does the sampled curve cover every x where f is on screen? */
function coverage(f: (x: number) => number, a: number, b: number): string[] {
  const pieces = sampleCurve(f, a, b, VIEW);
  const missing: string[] = [];
  for (let k = 0; k <= 2000; k++) {
    const x = a + ((b - a) * k) / 2000;
    const y = f(x);
    if (!(Math.abs(y) < 9)) continue;
    const covered = pieces.some((p) => p[0]! <= x && x <= p[p.length - 2]!);
    if (!covered) missing.push(x.toFixed(3));
  }
  return missing;
}

describe("sampling: steep curves are drawn in full", () => {
  test.each([
    ["sec²", (x: number) => 1 / Math.cos(x) ** 2],
    ["tan²", (x: number) => Math.tan(x) ** 2],
    ["tan 3x", (x: number) => Math.tan(3 * x)],
    ["tan πx", (x: number) => Math.tan(Math.PI * x)],
    ["1/sin πx", (x: number) => 1 / Math.sin(Math.PI * x)],
    ["x¹⁰", (x: number) => x ** 10],
    ["x⁸+2", (x: number) => x ** 8 + 2],
    ["e^{x²}", (x: number) => Math.exp(x * x)],
    ["1/x³", (x: number) => 1 / x ** 3],
    ["1/x⁴", (x: number) => 1 / x ** 4],
  ])("%s on [-10, 10]", (_name, f) => {
    expect(coverage(f, -10, 10)).toEqual([]);
  });

  test("tan x across a wide view", () => {
    expect(coverage(Math.tan, -50, 50)).toEqual([]);
    expect(coverage(Math.tan, -100, 100)).toEqual([]);
  });

  test("a steep straight line costs no more than a gentle one", () => {
    let n = 0;
    sampleCurve(
      (x) => {
        n++;
        return 10000 * (x - 1.234);
      },
      -10,
      10,
      VIEW,
    );
    expect(n).toBeLessThan(2500);
  });
});

describe("points of interest", () => {
  const kinds = (ps: { kind: string; t: number; v: number }[]) => ps.map((p) => `${p.kind}@${p.t}:${p.v}`);

  test("no extrema or zeros at vertical asymptotes", () => {
    expect(pointsOfInterest((x) => 1 / (x - 0.3), -10, 10)).toEqual([{ kind: "intercept", t: 0, v: -1 / 0.3 }]);
    expect(pointsOfInterest((x) => (x * x - 1) / (x - 0.7), -10, 10).every((p) => p.kind !== "max" || p.t !== 0.7)).toBe(true);
    const p = pointsOfInterest((x) => 1 / (x * x - 0.09), -10, 10);
    expect(kinds(p)).toEqual([`max@0:${1 / -0.09}`]);
  });

  test("rational with a hole-free pole pair: zeros at ±2 and the min at 0", () => {
    const p = pointsOfInterest((x) => (x * x - 4) / (x * x - 0.04), -10, 10);
    expect(kinds(p)).toEqual(["zero@-2:0", "min@0:100", "zero@2:0"]);
  });

  test("1/sin(πx): extrema at the half-integers, nothing at the poles", () => {
    const p = pointsOfInterest((x) => 1 / Math.sin(Math.PI * x), -3, 3);
    expect(p.every((q) => q.kind === "max" || q.kind === "min")).toBe(true);
    expect(p.map((q) => q.t)).toEqual([-2.5, -1.5, -0.5, 0.5, 1.5, 2.5]);
  });

  test("tan has zeros only", () => {
    for (const f of [(x: number) => Math.tan(Math.PI * x), (x: number) => Math.tan((Math.PI * x) / 4)]) {
      expect(pointsOfInterest(f, -10, 10).every((p) => p.kind === "zero")).toBe(true);
    }
  });

  test("degree-mode tan has no maxima at ±90", () => {
    const a = last(["y=\\tan(x)"], DEG);
    expect(pointsOfInterest(fOf(a), -200, 200).every((p) => p.kind === "zero")).toBe(true);
  });

  test("big curves don't turn their minima into zeros", () => {
    expect(kinds(pointsOfInterest((x) => x ** 10 + 1, -10, 10))).toEqual(["min@0:1"]);
    expect(kinds(pointsOfInterest((x) => (x * x + 1) ** 5, -10, 10))).toEqual(["min@0:1"]);
    expect(kinds(pointsOfInterest((x) => 10 ** x + 10 ** -x, -10, 10))).toEqual(["min@0:2"]);
    const xx = pointsOfInterest((x) => x ** x, 0.01, 10);
    expect(xx).toHaveLength(1);
    expect(xx[0]!.kind).toBe("min");
    expect(xx[0]!.t).toBeCloseTo(1 / Math.E, 9);
  });

  test("flat zero stretches are not rows of dots", () => {
    expect(pointsOfInterest(() => 0, -10, 10)).toEqual([]);
    expect(zeros((x) => Math.max(x, 0), -10, 10)).toEqual([]);
    expect(pointsOfInterest(Math.floor, -3, 3)).toEqual([]);
  });

  test("coincident curves have no intersection dots", () => {
    expect(intersections((x) => x, (x) => x, -10, 10)).toEqual([]);
    expect(intersections((x) => 2 * x + 1, (x) => 2 * x + 1, -10, 10)).toEqual([]);
    expect(intersections(Math.floor, () => 1, -10, 10)).toEqual([]);
  });

  test("plateaus and step edges are not extrema", () => {
    for (const f of [Math.floor, Math.round, Math.sign, (x: number) => Math.min(x * x, 4)]) {
      expect(pointsOfInterest(f, -10, 10).filter((p) => p.kind === "max" || p.kind === "min")).toEqual([]);
    }
  });

  test("tiny-scale curves keep their real zeros and minima", () => {
    const a = pointsOfInterest((x) => x * x - 1e-12, -1e-5, 1e-5);
    expect(a.filter((p) => p.kind === "zero").map((p) => p.t)).toEqual([-1e-6, 1e-6]);
    expect(a.find((p) => p.kind === "min")).toMatchObject({ t: 0, v: -1e-12 });
    const b = pointsOfInterest((x) => x * x - 2 * x + 1.0000001, -10, 10);
    // The minimum's value is f(1) as floating point computes it.
    expect(kinds(b).map((s) => s.split(":")[0])).toEqual(["intercept@0", "min@1"]);
    expect(b[1]!.v).toBeCloseTo(1e-7, 15);
  });

  test("a shallow dip below the axis has both crossings", () => {
    const z = zeros((x) => Math.sin(x) + 0.999999, -10, 10);
    expect(z).toHaveLength(6);
  });

  test("a vertex reads cleanly at any zoom, once", () => {
    for (const [a, b] of [
      [-1, 1],
      [-2, 2],
      [-3, 3],
    ] as const) {
      expect(kinds(pointsOfInterest((x) => x * x - 4, a, b))).toEqual(
        a <= -2 ? ["zero@-2:0", "min@0:-4", "zero@2:0"] : ["min@0:-4"],
      );
    }
    expect(kinds(pointsOfInterest((x) => (x - 5.5) ** 2 - 1, 5, 6))).toEqual(["min@5.5:-1"]);
    expect(kinds(pointsOfInterest((x) => x ** 8 + 2, -10, 10))).toEqual(["min@0:2"]);
  });
});
