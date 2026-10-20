import { describe, expect, test } from "bun:test";
import { analyze, type Analysis } from "../src/engine/analyze";
import { chainSegments, traceImplicit, traceRegion, type ImplicitView } from "../src/engine/implicit";
import { compileInterval, type Interval } from "../src/engine/interval";

const VIEW: ImplicitView = { xmin: -10, xmax: 10, ymin: -10, ymax: 10, widthPx: 400, heightPx: 400 };

function implicitOf(latex: string, context: string[] = []): Extract<Analysis, { kind: "implicit" }> {
  const rows = [...context, latex].map((l, i) => ({ id: String(i), latex: l }));
  const a = analyze(rows).at(-1)!;
  if (a.kind !== "implicit") throw new Error(`expected implicit, got ${JSON.stringify(a)}`);
  return a;
}

function regionOf(latex: string): Extract<Analysis, { kind: "region" }> {
  const a = analyze([{ id: "0", latex }])[0]!;
  if (a.kind !== "region") throw new Error(`expected region, got ${JSON.stringify(a)}`);
  return a;
}

function trace(latex: string, view = VIEW, context: string[] = []) {
  const a = implicitOf(latex, context);
  return traceImplicit({ f: a.f, fi: a.fi, relation: a.relation, restrict: a.restrict }, view);
}

function points(segments: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < segments.length; k += 2) out.push([segments[k]!, segments[k + 1]!]);
  return out;
}

// Seeded so a failure reproduces.
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe("interval arithmetic contains every value it summarises", () => {
  const EXPRESSIONS = [
    "x^2+y^2-4",
    "xy-1",
    "\\sin(x)+\\cos(y)",
    "\\tan(x)-y",
    "\\frac{1}{x}-y",
    "\\sqrt{x}-y",
    "\\ln(x)+y",
    "|x|-|y|",
    "x^3-3x-y",
    "e^{x}-y^{2}",
    "x^{\\frac{1}{3}}-y",
    "2^{x}-y",
    "x^{y}",
    "\\lfloor x\\rfloor".replace("\\lfloor x\\rfloor", "floor(x)") + "-y",
    "\\{x<0:-x,x\\}-y",
    "\\sin(xy)",
    "\\frac{x^2-1}{y-1}",
    "\\arctan(x)-y",
    "\\cosh(x)-y",
  ];
  for (const latex of EXPRESSIONS) {
    test(latex, () => {
      const a = analyze([{ id: "0", latex: `${latex}=0` }])[0]!;
      if (a.kind !== "implicit" && a.kind !== "curve") throw new Error(JSON.stringify(a));
      // Recompile through the same path the plotter uses.
      const impl = a.kind === "implicit" ? a : implicitOf(`${latex}+0y=0`);
      const r = rng(latex.length * 7919);
      for (let box = 0; box < 60; box++) {
        const x0 = -10 + 20 * r();
        const y0 = -10 + 20 * r();
        const w = Math.pow(10, -3 + 4 * r());
        const h = Math.pow(10, -3 + 4 * r());
        const I: Interval = impl.fi({
          x: { lo: x0, hi: x0 + w, def: "all" },
          y: { lo: y0, hi: y0 + h, def: "all" },
        });
        for (let k = 0; k < 40; k++) {
          const x = x0 + w * r();
          const y = y0 + h * r();
          const v = impl.f(x, y);
          if (!Number.isFinite(v)) continue;
          expect(I.def).not.toBe("none");
          const tol = 1e-9 * Math.max(1, Math.abs(v));
          expect(v).toBeGreaterThanOrEqual(I.lo - tol);
          expect(v).toBeLessThanOrEqual(I.hi + tol);
        }
      }
    });
  }
});

describe("interval primitives", () => {
  const box = (lo: number, hi: number): Interval => ({ lo, hi, def: "all" });
  test("x² over a box crossing 0 starts at 0", () => {
    const a = implicitOf("x^2-y=0");
    const I = a.fi({ x: box(-1, 2), y: box(0, 0) });
    expect(I.lo).toBe(0);
    expect(I.hi).toBe(4);
  });

  test("x·x is as tight as x²", () => {
    const a = implicitOf("xx-y=0");
    expect(a.fi({ x: box(-1, 2), y: box(0, 0) }).lo).toBe(0);
  });

  test("√x is partly defined over a box crossing 0, and not at all left of it", () => {
    const a = implicitOf("\\sqrt{x}-y=0");
    expect(a.fi({ x: box(-1, 4), y: box(0, 0) })).toMatchObject({ lo: 0, hi: 2, def: "some" });
    expect(a.fi({ x: box(-4, -1), y: box(0, 0) }).def).toBe("none");
  });

  test("1/x over a box containing 0 is unbounded", () => {
    const a = implicitOf("\\frac{1}{x}-y=0");
    const I = a.fi({ x: box(-0.1, 0.1), y: box(0, 0) });
    expect(I.lo).toBe(-Infinity);
    expect(I.hi).toBe(Infinity);
  });

  test("sin reaches ±1 when a peak is inside", () => {
    const a = implicitOf("\\sin(x)-y=0");
    expect(a.fi({ x: box(1, 2), y: box(0, 0) }).hi).toBe(1);
    const narrow = a.fi({ x: box(0.1, 0.2), y: box(0, 0) });
    expect(narrow.hi).toBeLessThan(0.2);
  });

  test("constants fold: a slider's value is a point", () => {
    const rows = [{ id: "a", latex: "r_1=3" }, { id: "b", latex: "x^2+y^2=r_1^2" }];
    const a = analyze(rows)[1]!;
    if (a.kind !== "implicit") throw new Error("expected implicit");
    expect(a.fi({ x: box(3, 3), y: box(0, 0) })).toMatchObject({ lo: 0, hi: 0 });
  });

  test("user functions are seen through", () => {
    const a = implicitOf("f(x)+f(y)=4", ["f(x)=x^2"]);
    const I = a.fi({ x: box(-1, 1), y: box(-1, 1) });
    expect(I.lo).toBe(-4);
    expect(I.hi).toBe(-2);
  });

  test("compileInterval is exported for the scorer later", () => {
    expect(typeof compileInterval).toBe("function");
  });
});

describe("tracing equations", () => {
  test("the circle x²+y²=16: every point on it, all the way round", () => {
    const r = trace("x^2+y^2=16");
    expect(r.truncated).toBe(false);
    const pts = points(r.segments);
    expect(pts.length).toBeGreaterThan(200);
    for (const [x, y] of pts) expect(Math.abs(Math.hypot(x, y) - 4)).toBeLessThan(0.02);
    const covered = new Set(pts.map(([x, y]) => Math.min(71, Math.floor(((Math.atan2(y, x) + Math.PI) / (2 * Math.PI)) * 72))));
    expect(covered.size).toBe(72);
    expect(r.fills).toEqual([]);
  });

  test("the hyperbola xy=1 has two branches and no line along the axes", () => {
    const r = trace("xy=1");
    for (const [x, y] of points(r.segments)) {
      expect(Math.abs(x * y - 1)).toBeLessThan(0.1);
      expect(Math.abs(x)).toBeGreaterThan(0.09);
    }
    const lines = chainSegments(r.segments, 20);
    expect(lines.length).toBe(2);
  });

  test("1/x = y draws no line at the pole x = 0", () => {
    // Written so it stays implicit (y alone on a side would make it y = 1/x).
    const r = trace("\\frac{1}{x}-y=0");
    for (const [x] of points(r.segments)) expect(Math.abs(x)).toBeGreaterThan(0.04);
  });

  test("x² = 4 is two vertical lines", () => {
    const r = trace("x^2=4");
    const xs = points(r.segments).map(([x]) => x);
    // Linear interpolation inside a 2 px leaf: within a hundredth.
    expect(xs.every((x) => Math.abs(Math.abs(x) - 2) < 0.01)).toBe(true);
    expect(chainSegments(r.segments, 20).length).toBe(2);
  });

  test("a curve with nothing in view draws nothing, cheaply", () => {
    const r = trace("x^2+y^2=10000");
    expect(r.segments).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  test("a restriction trims the curve", () => {
    const r = trace("x^2+y^2=16\\{x>0\\}");
    for (const [x] of points(r.segments)) expect(x).toBeGreaterThan(-0.1);
  });

  test("a dense curve stops at the budget and says so", () => {
    const a = implicitOf("\\sin(x^2y^2)=0.5");
    const r = traceImplicit({ f: a.f, fi: a.fi, relation: a.relation, restrict: a.restrict }, { ...VIEW, budget: 5000 });
    expect(r.truncated).toBe(true);
  });

  test("the tracer is fast enough to redraw", () => {
    const t0 = performance.now();
    trace("x^2+y^2=16", { ...VIEW, widthPx: 800, heightPx: 600 });
    trace("\\sin(x)+\\cos(y)=0.5", { ...VIEW, widthPx: 800, heightPx: 600 });
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe("tracing inequalities", () => {
  test("x²+y² < 16 fills the disc and dashes its edge", () => {
    const a = implicitOf("x^2+y^2<16");
    const r = traceImplicit({ f: a.f, fi: a.fi, relation: a.relation, restrict: a.restrict }, VIEW);
    let area = 0;
    for (let k = 0; k < r.fills.length; k += 4) {
      area += r.fills[k + 2]! * r.fills[k + 3]!;
      // Every filled box is inside (or straddles the edge of) the disc.
      const cx = r.fills[k]! + r.fills[k + 2]! / 2;
      const cy = r.fills[k + 1]! + r.fills[k + 3]! / 2;
      expect(Math.hypot(cx, cy)).toBeLessThan(4.1);
    }
    expect(Math.abs(area - Math.PI * 16) / (Math.PI * 16)).toBeLessThan(0.02);
    expect(r.segments.length).toBeGreaterThan(0);
  });

  test("y > x² (written implicitly) fills above the parabola", () => {
    const a = implicitOf("x^2-y<0");
    const r = traceImplicit({ f: a.f, fi: a.fi, relation: a.relation, restrict: a.restrict }, VIEW);
    let area = 0;
    for (let k = 0; k < r.fills.length; k += 4) area += r.fills[k + 2]! * r.fills[k + 3]!;
    // ∫ (10 − x²) dx over |x| ≤ √10.
    const exact = (4 / 3) * Math.pow(10, 1.5);
    expect(Math.abs(area - exact) / exact).toBeLessThan(0.02);
  });

  test("a chained region: 0 < y < x", () => {
    const a = regionOf("0<y<x");
    const r = traceRegion({ test: a.test, truth: a.truth, restrict: a.restrict }, VIEW);
    let area = 0;
    for (let k = 0; k < r.fills.length; k += 4) area += r.fills[k + 2]! * r.fills[k + 3]!;
    expect(Math.abs(area - 50) / 50).toBeLessThan(0.02);
    expect(r.segments.length).toBeGreaterThan(0);
  });
});

describe("chainSegments", () => {
  test("joins a square's four sides into one closed line", () => {
    const lines = chainSegments([0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 0, 1, 0, 0], 1);
    expect(lines.length).toBe(1);
    expect(lines[0]!.length).toBe(10);
  });

  test("keeps separate pieces separate", () => {
    expect(chainSegments([0, 0, 1, 0, 5, 5, 6, 5], 10).length).toBe(2);
  });
});
