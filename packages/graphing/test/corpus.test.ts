// What MathLive 0.111.1 actually serialises when a student types (captured
// by real keystrokes in the slice-2 playground, 2026-10-19, with the
// calculator's own shortcut table), and what each must mean (D-4).
import { describe, expect, test } from "bun:test";
import corpus from "./fixtures/mathlive-corpus.json";
import { analyze, type Analysis } from "../src/engine/analyze";
import { restricted } from "../src/engine/index";

const EXPECT: Record<string, (a: Analysis, all: Analysis[]) => void> = {};
const curveAt = (a: Analysis, t: number) => {
  if (a.kind === "curve") return restricted(a)(t);
  if (a.kind === "function" && a.plot) return a.plot.f(t);
  throw new Error(`not a curve: ${JSON.stringify(a)}`);
};
const value = (a: Analysis) => {
  if (a.kind !== "value") throw new Error(`not a value: ${JSON.stringify(a)}`);
  return a.value;
};
const at = (x: number, y: number) => (a: Analysis) => expect(curveAt(a, x)).toBeCloseTo(y, 10);
const is = (v: number) => (a: Analysis) => expect(value(a) as number).toBeCloseTo(v, 10);

Object.assign(EXPECT, {
  "y=2x+1": at(2, 5),
  "y=x^2-4x+3": at(1, 0),
  "y=-3x^2": at(2, -12),
  "y=1/2x": at(2, 0.25),
  "y=sinx": at(Math.PI / 2, 1),
  "y=2sin(3x)": at(Math.PI / 6, 2),
  "y=cos(x)+tan(x)": at(0, 1),
  "y=e^x": at(1, Math.E),
  "y=e^-x^2": at(1, Math.exp(-1)),
  "y=ln(x)": at(Math.E, 1),
  "y=log(x)": at(100, 2),
  "y=2^x": at(3, 8),
  "y=3(0.5)^x": at(2, 0.75),
  "y=x^3-2x": at(2, 4),
  "y<2x+1": (a: Analysis) => expect(a).toMatchObject({ kind: "curve", relation: "<" }),
  "y>=x^2": (a: Analysis) => expect(a).toMatchObject({ kind: "curve", relation: ">=" }),
  "x^2+y^2=9": (a: Analysis) => expect(a.kind).toBe("implicit"),
  "x=y^2": (a: Analysis) => expect(a).toMatchObject({ kind: "curve", of: "x" }),
  "(1,2)": (a: Analysis) => expect(a).toEqual({ kind: "points", points: [[1, 2]] }),
  "(-3,4),(5,6)": (a: Analysis) => expect(a).toEqual({ kind: "points", points: [[-3, 4], [5, 6]] }),
  "mean(1,2,3)": is(2),
  "mean(1,2) (keypad / autocomplete form)": is(1.5),
  "y=abs(x-3)": at(1, 2),
  "3!": is(6),
  "nCr(5,2)": is(10),
  "2pi": is(2 * Math.PI),
  "y=sqrt(x": at(9, 3),
  "y=1/x": at(4, 0.25),
  "y=floor(x)": at(2.5, 2),
  "y=arcsin(x)": at(1, Math.PI / 2),
  "8/4": is(2),
  "2*3": is(6),
  "-x^2": at(3, -9),
  "(x-1)(x+2)": at(2, 4),
  "y=xe^x": at(1, Math.E),
  "a=5": (a: Analysis) => expect(a).toEqual({ kind: "slider", name: "a", value: 5 }),
  "b=-2.5": (a: Analysis) => expect(a).toEqual({ kind: "slider", name: "b", value: -2.5 }),
  "10%": is(0.1),
  "y=max(x,0)": at(-3, 0),
  "2^10": is(1024),
  "y<=-x": (a: Analysis) => expect(a).toMatchObject({ kind: "curve", relation: "<=" }),
  "x>=3": (a: Analysis) => expect(a).toMatchObject({ kind: "curve", of: "x", relation: ">=" }),
  "y=|x|": at(-4, 4),
  "y=x^(1/3)": at(-8, -2),
  "y={x<0:-x,x}": at(-3, 3),
  "y=x{x>0}": (a: Analysis) => {
    expect(curveAt(a, 2)).toBe(2);
    expect(curveAt(a, -2)).toBeNaN();
  },
  "y=cos(pi x) with Space as a thin space": at(1, -1),
});

describe("MathLive corpus", () => {
  for (const [typed, latex] of corpus as [string, string][]) {
    test(`${typed}  ⇒  ${latex}`, () => {
      // Rows that need context get it: sliders for a/h/k, a definition of f.
      const context: Record<string, string[]> = {
        "y=a(x-h)^2+k": ["a=2", "h=1", "k=3"],
        "f(2)": ["f\\left(x\\right)=x^3-2x"],
        "pi r^2": ["r=2"], // r is kept for polar graphs, as in other calculators
      };
      const rows = [...(context[typed] ?? []), latex].map((l, i) => ({ id: String(i), latex: l }));
      const all = analyze(rows);
      const a = all.at(-1)!;
      if (typed === "pi r^2") {
        expect(all[0]).toMatchObject({ kind: "error", message: "r can't be redefined" });
        return expect(a).toMatchObject({ kind: "error", message: "r is not defined", missing: [] });
      }
      expect(a.kind).not.toBe("error");
      if (typed === "y=a(x-h)^2+k") return expect(curveAt(a, 0)).toBe(5);
      if (typed === "f(2)") return expect(value(a)).toBe(4);
      if (typed === "f(x)=x^3-2x") return EXPECT["y=x^3-2x"]!(a, all);
      const check = EXPECT[typed];
      if (!check) throw new Error(`no expectation for ${typed}`);
      check(a, all);
    });
  }
});
