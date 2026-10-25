import { describe, expect, test } from "bun:test";
import { analyze, type Analysis, type Settings } from "../src/engine/analyze";

const rows = (...latex: string[]) => latex.map((l, i) => ({ id: String(i), latex: l }));
const one = (latex: string, settings?: Settings) => analyze(rows(latex), settings)[0]!;
const value = (latex: string, settings?: Settings) => {
  const a = one(latex, settings);
  if (a.kind !== "value") throw new Error(`expected value, got ${JSON.stringify(a)}`);
  return a.value;
};
const DEG: Settings = { degrees: true, disabled: new Set() };

function curveAt(a: Analysis, t: number): number {
  if (a.kind === "curve") return a.f(t);
  if (a.kind === "function" && a.plot) return a.plot.f(t);
  throw new Error(`not a curve: ${JSON.stringify(a)}`);
}

describe("values", () => {
  test.each([
    ["1+2*3", 7],
    ["2^{10}", 1024],
    ["\\frac{1}{4}", 0.25],
    ["\\sqrt{16}", 4],
    ["\\sqrt[3]{-27}", -3],
    ["(-8)^{\\frac{1}{3}}", -2],
    ["5!", 120],
    ["0!", 1],
    ["|-3|", 3],
    ["\\ln e", 1],
    ["\\log100", 2],
    ["\\log_2 8", 3],
    ["\\exp(0)", 1],
    ["mean(1,2,3,4)", 2.5],
    ["median(3,1,2)", 2],
    ["\\operatorname{median}(4,1,2,3)", 2.5],
    ["stdev(2,4,4,4,5,5,7,9)", Math.sqrt(32 / 7)],
    ["stdevp(2,4,4,4,5,5,7,9)", 2],
    ["total([1,2,3])", 6],
    ["length([1,2,3])", 3],
    ["max([4,9],2)", 9],
    ["nCr(5,2)", 10],
    ["nPr(5,2)", 20],
    ["mod(-1,3)", 2],
    ["gcd(12,18)", 6],
    ["lcm(4,6)", 12],
    ["round(2.567,2)", 2.57],
    ["floor(-1.5)", -2],
    ["\\sin(\\pi/2)", 1],
    ["\\arctan(1,1)", Math.PI / 4],
    ["50\\%", 0.5],
    ["\\{2>1:5,7\\}", 5],
    ["\\{2<1:5,7\\}", 7],
    ["\\sin(30°)", 0.5],
  ])("%s = %p", (latex, expected) => {
    expect(value(latex) as number).toBeCloseTo(expected as number, 12);
  });

  test("degree mode", () => {
    expect(value("\\sin(30)", DEG) as number).toBeCloseTo(0.5, 12);
    expect(value("\\arcsin(1)", DEG) as number).toBeCloseTo(90, 12);
    expect(value("\\sin^{-1}(0.5)", DEG) as number).toBeCloseTo(30, 10);
    // ° means "degrees" in either mode.
    expect(value("\\sin(90^\\circ)", DEG) as number).toBeCloseTo(1, 12);
  });

  test("undefined results are NaN, not errors", () => {
    expect(value("\\sqrt{-1}")).toBeNaN();
    expect(value("\\ln(-1)")).toBeNaN();
    expect(value("\\{2<1:5\\}")).toBeNaN();
  });

  test("a list shows as a list", () => {
    expect(value("[1,2,1+2]")).toEqual([1, 2, 3]);
  });
});

describe("definitions and sliders", () => {
  test("a number literal is a slider", () => {
    expect(one("a=3")).toEqual({ kind: "slider", name: "a", value: 3 });
    expect(one("a=-2.5")).toEqual({ kind: "slider", name: "a", value: -2.5 });
  });

  test("a computed definition shows its value", () => {
    const [, b] = analyze(rows("a=3", "b=2a+1"));
    expect(b).toEqual({ kind: "value", value: 7, name: "b" });
  });

  test("definitions resolve in any order", () => {
    const [b, , y] = analyze(rows("b=2a", "a=5", "y=bx"));
    expect(b).toEqual({ kind: "value", value: 10, name: "b" });
    expect(curveAt(y!, 2)).toBe(20);
  });

  test("an undefined name is reported for a slider", () => {
    const a = one("y=mx+b");
    expect(a.kind).toBe("error");
    if (a.kind === "error") {
      expect(a.missing.sort()).toEqual(["b", "m"]);
      expect(a.message).toBe("m and b are not defined");
    }
  });

  test("circular definitions are errors, not hangs", () => {
    const [a, b] = analyze(rows("a=b+1", "b=a"));
    expect(a!.kind).toBe("error");
    expect(b!.kind).toBe("error");
    expect((a as { message: string }).message).toContain("terms of itself");
  });

  test("a self-referencing function is an error", () => {
    const [f] = analyze(rows("f(x)=f(x-1)"));
    expect(f).toMatchObject({ kind: "error", message: "f is defined in terms of itself" });
    const [g, h] = analyze(rows("g(x)=h(x)", "h(x)=g(x)"));
    expect(g!.kind).toBe("error");
    expect(h!.kind).toBe("error");
  });

  test("a name defined twice is an error on both rows", () => {
    const [a, b] = analyze(rows("a=1", "a=2"));
    expect(a).toMatchObject({ kind: "error", message: "a is defined more than once" });
    expect(b!.kind).toBe("error");
  });

  test("reserved and built-in names can't be redefined", () => {
    expect(one("e=3")).toMatchObject({ kind: "error" });
    expect(one("mean=3")).toMatchObject({ kind: "error" });
  });

  test("a variable can't depend on x", () => {
    expect(one("a=2x")).toMatchObject({ kind: "error" });
  });

  test("lists, points and point lists as definitions", () => {
    const [l, m, p, q] = analyze(rows("L=[1,2,3]", "m=mean(L)", "P=(1,2)", "Q=[(1,2),(3,4)]"));
    expect(l).toEqual({ kind: "value", value: [1, 2, 3], name: "L" });
    expect(m).toEqual({ kind: "value", value: 2, name: "m" });
    expect(p).toEqual({ kind: "points", points: [[1, 2]], name: "P" });
    expect(q).toEqual({ kind: "points", points: [[1, 2], [3, 4]], name: "Q" });
  });
});

describe("functions", () => {
  test("f(x)= is a definition and a curve", () => {
    const [f, v] = analyze(rows("f(x)=x^2", "f(3)"));
    expect(f!.kind).toBe("function");
    expect(curveAt(f!, -2)).toBe(4);
    expect(v).toEqual({ kind: "value", value: 9 });
  });

  test("a function of another variable is not plotted", () => {
    const [g] = analyze(rows("g(t)=2t"));
    expect(g).toMatchObject({ kind: "function", name: "g", params: ["t"], plot: null });
  });

  test("functions call functions and read definitions", () => {
    const [, , , y] = analyze(rows("k=10", "f(x)=kx", "g(x)=f(x)+1", "y=g(x)"));
    expect(curveAt(y!, 2)).toBe(21);
  });

  test("two-parameter functions", () => {
    const [, v] = analyze(rows("h(a,b)=a^2+b", "h(3,1)"));
    expect(v).toEqual({ kind: "value", value: 10 });
  });

  test("wrong argument count", () => {
    const [, v] = analyze(rows("f(x)=x", "f(1,2)"));
    expect(v).toMatchObject({ kind: "error", message: "f takes 1 argument" });
  });

  test("a(x+1) without a function a is a product", () => {
    const [, y] = analyze(rows("a=2", "y=a(x+1)"));
    expect(curveAt(y!, 1)).toBe(4);
  });

  test("a function body that references an undefined name", () => {
    expect(one("f(x)=kx")).toMatchObject({ kind: "error", missing: ["k"] });
  });
});

describe("classification", () => {
  test("y = f(x), and f(x) = y written backwards", () => {
    expect(one("y=2x+1")).toMatchObject({ kind: "curve", of: "y", relation: "=" });
    const back = one("2x+1=y");
    expect(back).toMatchObject({ kind: "curve", of: "y" });
    expect(curveAt(back, 1)).toBe(3);
  });

  test("x = f(y)", () => {
    const a = one("x=y^2");
    expect(a).toMatchObject({ kind: "curve", of: "x" });
    expect(curveAt(a, 3)).toBe(9);
    expect(one("x=3")).toMatchObject({ kind: "curve", of: "x" });
  });

  test("a bare expression in x is graphed as y =", () => {
    expect(one("x^2")).toMatchObject({ kind: "curve", of: "y" });
  });

  test("inequalities keep their direction", () => {
    expect(one("y\\le x")).toMatchObject({ kind: "curve", relation: "<=" });
    expect(one("x<y")).toMatchObject({ kind: "curve", of: "y", relation: ">" });
  });

  test("implicit equations and inequalities", () => {
    const c = one("x^2+y^2=4");
    expect(c.kind).toBe("implicit");
    if (c.kind === "implicit") expect(c.f(2, 0)).toBe(0);
    expect(one("xy>1")).toMatchObject({ kind: "implicit", relation: ">" });
    // x alone on one side: x = f(y), not implicit.
    expect(one("y^2=x")).toMatchObject({ kind: "curve", of: "x" });
    expect(one("\\sin(x)=x")).toMatchObject({ kind: "implicit" });
  });

  test("chained inequality is a region", () => {
    const r = one("0<y<x");
    expect(r.kind).toBe("region");
    if (r.kind === "region") {
      expect(r.test(2, 1)).toBe(true);
      expect(r.test(1, 2)).toBe(false);
    }
  });

  test("points", () => {
    expect(one("(1,2)")).toEqual({ kind: "points", points: [[1, 2]] });
    expect(one("(1,2),(3,4)")).toEqual({ kind: "points", points: [[1, 2], [3, 4]] });
    const [, p] = analyze(rows("a=4", "(a,\\sqrt{a})"));
    expect(p).toEqual({ kind: "points", points: [[4, 2]] });
  });

  test("restrictions apply pointwise", () => {
    const a = one("y=x\\{x>0\\}");
    if (a.kind !== "curve" || !a.restrict) throw new Error("expected a restricted curve");
    expect(a.restrict(1, 1)).toBe(true);
    expect(a.restrict(-1, -1)).toBe(false);
  });

  test("piecewise curves", () => {
    const a = one("y=\\{x<0:-x,x\\}");
    expect(curveAt(a, -3)).toBe(3);
    expect(curveAt(a, 2)).toBe(2);
  });

  test("an equation with no variables says whether it holds", () => {
    expect(one("2+2=4")).toMatchObject({ kind: "error", message: "This is true, but there's nothing to graph" });
    expect(one("2+2=5")).toMatchObject({ kind: "error", message: "This is false" });
  });

  test("an expression in y alone asks for y= or x=", () => {
    expect(one("y^2+1")).toMatchObject({ kind: "error" });
  });

  test("empty rows and parse errors", () => {
    expect(one("")).toEqual({ kind: "empty" });
    expect(one("  ")).toEqual({ kind: "empty" });
    expect(one("1+")).toMatchObject({ kind: "error", message: "Expression is incomplete" });
  });

  test("parametric and polar names are not offered as sliders", () => {
    expect(one("(\\cos t,\\sin t)")).toMatchObject({ kind: "error", missing: [] });
    expect(one("r=\\theta")).toMatchObject({ kind: "error", missing: [] });
  });

  test("one bad row doesn't spoil the others", () => {
    const out = analyze(rows("y=", "y=x"));
    expect(out[0]!.kind).toBe("error");
    expect(out[1]!.kind).toBe("curve");
  });
});

describe("configuration", () => {
  test("a disabled group refuses its functions", () => {
    const s: Settings = { degrees: false, disabled: new Set(["hyperbolic", "reciprocalTrig"]) };
    expect(one("\\sinh(1)", s)).toMatchObject({ kind: "error", message: "sinh is not available on this calculator" });
    expect(one("\\sec(1)", s)).toMatchObject({ kind: "error" });
    expect(one("\\sin(1)", s).kind).toBe("value");
  });

  test("geometry off disables distance", () => {
    const s: Settings = { degrees: false, disabled: new Set(["geometry"]) };
    expect(one("distance((0,0),(3,4))").kind).toBe("value");
    expect(value("distance((0,0),(3,4))")).toBe(5);
    expect(one("distance((0,0),(3,4))", s).kind).toBe("error");
  });
});

describe("robustness", () => {
  test("deep nesting is an error, not a crash", () => {
    expect(one("(".repeat(500) + "1" + ")".repeat(500))).toEqual({ kind: "value", value: 1 });
    const deep = "(".repeat(200_000) + "1" + ")".repeat(200_000);
    expect(one(deep)).toMatchObject({ kind: "error", message: "Too deeply nested" });
  });

  test("evaluation is fast enough to plot", () => {
    const a = one("y=\\sin(x)^2+\\cos(3x)/(1+x^2)");
    if (a.kind !== "curve") throw new Error("expected curve");
    const t0 = performance.now();
    let s = 0;
    for (let k = 0; k < 200_000; k++) s += a.f(k / 1000);
    expect(Number.isFinite(s)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
