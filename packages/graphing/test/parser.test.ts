import { describe, expect, test } from "bun:test";
import type { Node } from "../src/engine/ast";
import { ParseError, parse } from "../src/engine/parser";

/** A compact s-expression of a tree, for readable expectations. */
function s(n: Node): string {
  switch (n.kind) {
    case "num":
      return String(n.value);
    case "var":
      return n.name;
    case "call":
      return `${n.ambiguous ? "?" : ""}${n.name}(${n.args.map(s).join(" ")})`;
    case "neg":
      return `(- ${s(n.arg)})`;
    case "factorial":
      return `(! ${s(n.arg)})`;
    case "abs":
      return `|${s(n.arg)}|`;
    case "root":
      return n.index ? `(root ${s(n.arg)} ${s(n.index)})` : `(sqrt ${s(n.arg)})`;
    case "add":
      return `(+ ${s(n.left)} ${s(n.right)})`;
    case "sub":
      return `(- ${s(n.left)} ${s(n.right)})`;
    case "mul":
      return `(* ${s(n.left)} ${s(n.right)})`;
    case "div":
      return `(/ ${s(n.left)} ${s(n.right)})`;
    case "pow":
      return `(^ ${s(n.left)} ${s(n.right)})`;
    case "point":
      return `(pt ${n.coords.map(s).join(" ")})`;
    case "list":
      return `[${n.items.map(s).join(" ")}]`;
    case "compare":
      return `(${n.ops.map((o, i) => `${s(n.operands[i]!)} ${o}`).join(" ")} ${s(n.operands.at(-1)!)})`;
    case "piecewise":
      return `{${n.cases.map((c) => `${s(c.cond)}: ${c.value ? s(c.value) : "1"}`).join(", ")}${n.otherwise ? `; ${s(n.otherwise)}` : ""}}`;
  }
}

const p = (latex: string) => s(parse(latex).body);

describe("arithmetic and precedence", () => {
  test.each([
    ["1+2*3", "(+ 1 (* 2 3))"],
    ["1-2-3", "(- (- 1 2) 3)"],
    ["8/4/2", "(/ (/ 8 4) 2)"],
    ["-x^2", "(- (^ x 2))"],
    ["2^3^2", "(^ 2 (^ 3 2))"],
    ["2^{-1}", "(^ 2 (- 1))"],
    ["x^{2}+y^{2}", "(+ (^ x 2) (^ y 2))"],
    // MathLive writes a typed two-digit exponent without braces.
    ["x^23", "(^ x 23)"],
    ["2^10", "(^ 2 10)"],
    ["2\\cdot3", "(* 2 3)"],
    ["2\\times3", "(* 2 3)"],
    ["6\\div3", "(/ 6 3)"],
    ["3!", "(! 3)"],
    ["50\\%", "(/ 50 100)"],
    [".5", "0.5"],
    ["2.", "2"],
  ])("%s", (latex, tree) => expect(p(latex)).toBe(tree));
});

describe("implicit multiplication", () => {
  test.each([
    ["2x", "(* 2 x)"],
    ["xy", "(* x y)"],
    ["2(x+1)", "(* 2 (+ x 1))"],
    ["(x+1)(x-1)", "(* (+ x 1) (- x 1))"],
    ["2\\pi r", "(* (* 2 pi) r)"],
    ["3x^2", "(* 3 (^ x 2))"],
    // Negation binds tighter than implicit multiplication; the value is
    // the same either way.
    ["-2x", "(* (- 2) x)"],
    ["x\\sin x", "(* x sin(x))"],
    ["2\\sqrt{x}", "(* 2 (sqrt x))"],
    ["\\frac{1}{2}x", "(* (/ 1 2) x)"],
    ["2|x|", "(* 2 |x|)"],
  ])("%s", (latex, tree) => expect(p(latex)).toBe(tree));

  test("a(x+1) is left ambiguous for analysis", () => {
    expect(p("a(x+1)")).toBe("?a((+ x 1))");
  });

  test("x(x+1) is always a product", () => {
    expect(p("x(x+1)")).toBe("(* x (+ x 1))");
  });
});

describe("MathLive's LaTeX", () => {
  test.each([
    ["\\frac{x+1}{2}", "(/ (+ x 1) 2)"],
    ["\\frac12", "(/ 1 2)"],
    ["\\sqrt{x}", "(sqrt x)"],
    ["\\sqrt[3]{x}", "(root x 3)"],
    ["\\left(x+1\\right)^2", "(^ (+ x 1) 2)"],
    ["\\mleft(x\\mright)", "x"],
    ["\\left|x-1\\right|", "|(- x 1)|"],
    ["|x|+|y|", "(+ |x| |y|)"],
    ["\\left\\vert x\\right\\vert", "|x|"],
    ["\\operatorname{mean}\\left(1,2,3\\right)", "mean(1 2 3)"],
    ["\\exponentialE^{x}", "(^ e x)"],
    ["\\theta", "theta"],
    ["a_1+a_{12}", "(+ a_1 a_12)"],
    ["2\\,x", "(* 2 x)"],
    ["x\\le3", "(x <= 3)"],
    ["x\\geq3", "(x >= 3)"],
    ["x≤3", "(x <= 3)"],
    ["\\infty", "Infinity"],
  ])("%s", (latex, tree) => expect(p(latex)).toBe(tree));
});

describe("functions", () => {
  test.each([
    ["\\sin(x)", "sin(x)"],
    ["\\sin x", "sin(x)"],
    ["\\sin2x", "sin((* 2 x))"],
    ["\\sin x\\cos x", "(* sin(x) cos(x))"],
    ["\\sin^2x", "(^ sin(x) 2)"],
    ["\\sin^{2}\\left(x\\right)", "(^ sin(x) 2)"],
    ["\\sin^{-1}x", "arcsin(x)"],
    ["\\tan^{-1}(x)", "arctan(x)"],
    ["\\ln x+1", "(+ ln(x) 1)"],
    ["\\log_2x", "logb(x 2)"],
    ["\\log_{10}(100)", "logb(100 10)"],
    ["\\sin -x", "sin((- x))"],
    ["mean(1,2)", "mean(1 2)"],
    ["\\max(1,2,3)", "max(1 2 3)"],
    ["max(x,0)", "max(x 0)"],
    ["nCr(5,2)", "nCr(5 2)"],
    ["\\arctan(y,x)", "arctan(y x)"],
    ["f(x)", "?f(x)"],
    ["\\sin(30^\\circ)", "sin(__deg(30))"],
    ["30°", "__deg(30)"],
  ])("%s", (latex, tree) => expect(p(latex)).toBe(tree));

  test("letters that only start a function name stay variables", () => {
    expect(p("ma")).toBe("(* m a)");
    expect(p("max")).toBe("(* (* m a) x)");
  });
});

describe("relations, points, lists, piecewise, restrictions", () => {
  test.each([
    ["y=2x+1", "(y = (+ (* 2 x) 1))"],
    ["y<x", "(y < x)"],
    ["0<y<x", "(0 < y < x)"],
    ["(1,2)", "(pt 1 2)"],
    ["(1,2),(3,4)", "[(pt 1 2) (pt 3 4)]"],
    ["[1,2,3]", "[1 2 3]"],
    ["[]", "[]"],
    ["\\{x<0:-x,x\\}", "{(x < 0): (- x); x}"],
    ["\\left\\{x>0\\right\\}", "{(x > 0): 1}"],
    ["\\{x<0:1,x>2:2\\}", "{(x < 0): 1, (x > 2): 2}"],
  ])("%s", (latex, tree) => expect(p(latex)).toBe(tree));

  test("trailing braces are restrictions, not a product", () => {
    const st = parse("y=x^2\\left\\{x>0\\right\\}\\{x<3\\}");
    expect(s(st.body)).toBe("(y = (^ x 2))");
    expect(st.restrictions.map(s)).toEqual(["(x > 0)", "(x < 3)"]);
  });

  test("several conditions in one brace", () => {
    expect(parse("y=x\\{x>0,x<3\\}").restrictions.map(s)).toEqual(["(x > 0)", "(x < 3)"]);
  });
});

describe("errors", () => {
  test.each([
    [""],
    ["1+"],
    ["(1+2"],
    ["1+2)"],
    ["\\frac{1}{}"],
    ["x=y=1"],
    ["x\\ne1"],
    ["\\placeholder{}+1"],
    ["\\foo"],
    ["\\operatorname{zzz}(1)"],
    ["|x"],
    ["$"],
    ["\\sin"],
  ])("%s throws ParseError", (latex) => {
    expect(() => parse(latex)).toThrow(ParseError);
  });

  test("errors carry a position", () => {
    try {
      parse("1+)");
      throw new Error("no throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).position).toBe(2);
    }
  });
});
