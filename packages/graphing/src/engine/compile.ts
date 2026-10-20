// Expression tree → closures (D-4). No `eval`, no `new Function`: the test
// page's CSP forbids both, so every node becomes a nested JS closure.
//
// Values have one of four shapes. Plotting runs the `number` path in a hot
// loop; the other shapes serve points, lists and aggregate functions.

import type { Node } from "./ast";
import { BUILTINS, CONSTANTS, DEGREE_TRIG, factorial, type FunctionGroup } from "./builtins";

export type Env = Record<string, number>;
export type NumFn = (env: Env) => number;
export type ListFn = (env: Env) => number[];
export type PointFn = (env: Env) => [number, number];
export type PointsFn = (env: Env) => [number, number][];
export type Shape = "number" | "list" | "point" | "points";

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

export interface UserFunction {
  params: string[];
  /** Compiled lazily by the scope so definitions may come in any order. */
  call: (args: number[], env: Env) => number;
}

/** What the compiler needs to know about the rest of the expression list. */
export interface Scope {
  degrees: boolean;
  disabled: ReadonlySet<FunctionGroup>;
  /** A user variable's shape, or undefined when it is not defined. */
  shapeOf(name: string): Shape | undefined;
  number(name: string): NumFn;
  list(name: string): ListFn;
  point(name: string): PointFn;
  points(name: string): PointsFn;
  userFunction(name: string): UserFunction | undefined;
  /** A user function's parameters and body, for interval evaluation. */
  functionBody?(name: string): { params: string[]; body: Node } | undefined;
  /** Names bound by the surrounding context (x, y, a function's params). */
  bound: ReadonlySet<string>;
}

const DEG = Math.PI / 180;

/** The shape a node evaluates to, without compiling it. */
export function shapeOf(node: Node, scope: Scope): Shape {
  switch (node.kind) {
    case "point":
      return "point";
    case "list": {
      if (node.items.length === 0) return "list";
      const first = shapeOf(node.items[0]!, scope);
      return first === "point" ? "points" : "list";
    }
    case "var":
      if (scope.bound.has(node.name)) return "number";
      return scope.shapeOf(node.name) ?? "number";
    default:
      return "number";
  }
}

export function compileNumber(node: Node, scope: Scope): NumFn {
  switch (node.kind) {
    case "num": {
      const v = node.value;
      return () => v;
    }
    case "var":
      return variable(node.name, scope);
    case "neg": {
      const a = compileNumber(node.arg, scope);
      return (e) => -a(e);
    }
    case "add": {
      const a = compileNumber(node.left, scope);
      const b = compileNumber(node.right, scope);
      return (e) => a(e) + b(e);
    }
    case "sub": {
      const a = compileNumber(node.left, scope);
      const b = compileNumber(node.right, scope);
      return (e) => a(e) - b(e);
    }
    case "mul": {
      const a = compileNumber(node.left, scope);
      const b = compileNumber(node.right, scope);
      return (e) => a(e) * b(e);
    }
    case "div": {
      const a = compileNumber(node.left, scope);
      const b = compileNumber(node.right, scope);
      return (e) => a(e) / b(e);
    }
    case "pow": {
      // `a(x-1)^2` with no function a is a·(x−1)², not (a·(x−1))².
      const split = splitProduct(node.left, scope);
      if (split) return compileNumber({ kind: "mul", left: split[0], right: { ...node, left: split[1] } }, scope);
      const a = compileNumber(node.left, scope);
      // A constant rational exponent with an odd denominator keeps real
      // roots of negatives: x^(1/3) at x = -8 is -2, as students expect.
      const odd = oddRootExponent(node.right);
      if (odd !== null) {
        const [p, q] = odd;
        return (e) => {
          const x = a(e);
          if (x >= 0) return Math.pow(x, p / q);
          const r = -Math.pow(-x, 1 / q);
          return Math.pow(r, p);
        };
      }
      const b = compileNumber(node.right, scope);
      return (e) => Math.pow(a(e), b(e));
    }
    case "factorial": {
      const split = splitProduct(node.arg, scope);
      if (split) return compileNumber({ kind: "mul", left: split[0], right: { ...node, arg: split[1] } }, scope);
      const a = compileNumber(node.arg, scope);
      return (e) => factorial(a(e));
    }
    case "abs": {
      if (shapeOf(node.arg, scope) === "point") {
        const p = compilePoint(node.arg, scope);
        return (e) => {
          const [x, y] = p(e);
          return Math.hypot(x, y);
        };
      }
      const a = compileNumber(node.arg, scope);
      return (e) => Math.abs(a(e));
    }
    case "root": {
      const a = compileNumber(node.arg, scope);
      if (!node.index) return (e) => Math.sqrt(a(e));
      const n = compileNumber(node.index, scope);
      return (e) => nthRoot(a(e), n(e));
    }
    case "call":
      return call(node, scope);
    case "compare": {
      const c = compileCondition(node, scope);
      return (e) => (c(e) ? 1 : NaN);
    }
    case "piecewise": {
      const cases = node.cases.map((c) => ({
        cond: compileCondition(c.cond, scope),
        value: c.value ? compileNumber(c.value, scope) : () => 1,
      }));
      const otherwise = node.otherwise ? compileNumber(node.otherwise, scope) : () => NaN;
      return (e) => {
        for (const c of cases) if (c.cond(e)) return c.value(e);
        return otherwise(e);
      };
    }
    case "point":
      throw new CompileError("A point can't be used as a number here");
    case "list":
      throw new CompileError("A list can't be used as a number here");
  }
}

/** `name(arg)` that is really `name · (arg)`: [variable, parenthesis]. */
function splitProduct(node: Node, scope: Scope): [Node, Node] | null {
  if (node.kind !== "call" || !node.ambiguous || node.args.length !== 1) return null;
  if (scope.userFunction(node.name)) return null;
  return [{ kind: "var", name: node.name }, node.args[0]!];
}

/** p/q when `node` is a constant fraction with an odd q, else null. */
function oddRootExponent(node: Node): [number, number] | null {
  let sign = 1;
  let n = node;
  if (n.kind === "neg") {
    sign = -1;
    n = n.arg;
  }
  if (n.kind === "div" && n.left.kind === "num" && n.right.kind === "num") {
    const p = n.left.value;
    const q = n.right.value;
    if (Number.isInteger(p) && Number.isInteger(q) && q % 2 !== 0 && q !== 0) return [sign * p, q];
  }
  return null;
}

export function nthRoot(x: number, n: number): number {
  if (x >= 0) return Math.pow(x, 1 / n);
  if (Number.isInteger(n) && Math.abs(n) % 2 === 1) return -Math.pow(-x, 1 / n);
  return NaN;
}

function variable(name: string, scope: Scope): NumFn {
  if (scope.bound.has(name)) return (e) => e[name] ?? NaN;
  const shape = scope.shapeOf(name);
  if (shape !== undefined) {
    if (shape !== "number") throw new CompileError(`${display(name)} is a ${shape}, not a number`);
    return scope.number(name);
  }
  if (name in CONSTANTS) {
    const c = CONSTANTS[name]!;
    return () => c;
  }
  throw new CompileError(`${display(name)} is not defined`);
}

export function display(name: string): string {
  return name === "theta" ? "θ" : name;
}

function checkGroup(name: string, scope: Scope): void {
  const b = BUILTINS[name];
  if (b && scope.disabled.has(b.group)) {
    throw new CompileError(`${name} is not available on this calculator`);
  }
}

function call(node: Extract<Node, { kind: "call" }>, scope: Scope): NumFn {
  const { name, args } = node;
  if (name === "__deg") {
    const a = compileNumber(args[0]!, scope);
    // ° converts to the current angle unit: radians mode ×π/180.
    return scope.degrees ? a : (e) => a(e) * DEG;
  }
  const user = scope.userFunction(name);
  if (user) {
    if (args.length !== user.params.length) {
      throw new CompileError(
        `${name} takes ${user.params.length} argument${user.params.length === 1 ? "" : "s"}`,
      );
    }
    const fs = args.map((a) => compileNumber(a, scope));
    if (fs.length === 1) {
      const f0 = fs[0]!;
      return (e) => user.call([f0(e)], e);
    }
    return (e) => user.call(fs.map((f) => f(e)), e);
  }
  if (node.ambiguous) {
    // `a(x+1)` with no function `a`: a variable times a parenthesis.
    if (args.length !== 1) throw new CompileError(`${display(name)} is not a function`);
    const a = variable(name, scope);
    const b = compileNumber(args[0]!, scope);
    return (e) => a(e) * b(e);
  }
  if (name === "distance") return distance(args, scope);
  const b = BUILTINS[name];
  if (!b) throw new CompileError(`Unknown function ${name}`);
  checkGroup(name, scope);
  if (b.arity === "aggregate") {
    const parts = args.map((a) => (shapeOf(a, scope) === "list" ? compileList(a, scope) : wrap(compileNumber(a, scope))));
    return (e) => {
      const xs: number[] = [];
      for (const p of parts) for (const v of p(e)) xs.push(v);
      return b.fn(...xs);
    };
  }
  if (args.length !== b.arity && args.length !== b.altArity) {
    throw new CompileError(`${name} takes ${b.arity} argument${b.arity === 1 ? "" : "s"}`);
  }
  const fs = args.map((a) => compileNumber(a, scope));
  const fn = b.fn;
  if (b.angle === "forward" && scope.degrees) {
    const f0 = fs[0]!;
    const deg = DEGREE_TRIG[name] ?? ((x: number) => fn(x * DEG));
    return (e) => deg(f0(e));
  }
  if (b.angle === "inverse" && scope.degrees) {
    // arcsin(½) is 30, not 30.000000000000004.
    const snap = (d: number) => {
      const r = Math.round(d);
      return Math.abs(d - r) < 1e-9 ? r : d;
    };
    if (fs.length === 1) {
      const f0 = fs[0]!;
      return (e) => snap(fn(f0(e)) / DEG);
    }
    return (e) => snap(fn(...fs.map((f) => f(e))) / DEG);
  }
  if (fs.length === 1) {
    const f0 = fs[0]!;
    return (e) => fn(f0(e));
  }
  if (fs.length === 2) {
    const f0 = fs[0]!;
    const f1 = fs[1]!;
    return (e) => fn(f0(e), f1(e));
  }
  return (e) => fn(...fs.map((f) => f(e)));
}

function distance(args: Node[], scope: Scope): NumFn {
  if (scope.disabled.has("geometry")) throw new CompileError("distance is not available on this calculator");
  if (args.length !== 2) throw new CompileError("distance takes 2 points");
  const p = compilePoint(args[0]!, scope);
  const q = compilePoint(args[1]!, scope);
  return (e) => {
    const [a, b] = p(e);
    const [c, d] = q(e);
    return Math.hypot(a - c, b - d);
  };
}

function wrap(f: NumFn): ListFn {
  return (e) => [f(e)];
}

export function compileList(node: Node, scope: Scope): ListFn {
  if (node.kind === "list") {
    const items = node.items.map((i) => compileNumber(i, scope));
    return (e) => items.map((f) => f(e));
  }
  if (node.kind === "var" && scope.shapeOf(node.name) === "list") return scope.list(node.name);
  throw new CompileError("Expected a list");
}

export function compilePoint(node: Node, scope: Scope): PointFn {
  if (node.kind === "point") {
    if (node.coords.length !== 2) throw new CompileError("Points have two coordinates");
    const a = compileNumber(node.coords[0]!, scope);
    const b = compileNumber(node.coords[1]!, scope);
    return (e) => [a(e), b(e)];
  }
  if (node.kind === "var" && scope.shapeOf(node.name) === "point") return scope.point(node.name);
  throw new CompileError("Expected a point");
}

export function compilePoints(node: Node, scope: Scope): PointsFn {
  if (node.kind === "list") {
    const items = node.items.map((i) => compilePoint(i, scope));
    return (e) => items.map((f) => f(e));
  }
  if (node.kind === "var" && scope.shapeOf(node.name) === "points") return scope.points(node.name);
  throw new CompileError("Expected a list of points");
}

const EPS = 1e-12;

/** A comparison as a predicate. `=` is equality within a tiny tolerance. */
export function compileCondition(node: Node, scope: Scope): (env: Env) => boolean {
  if (node.kind !== "compare") {
    throw new CompileError("A condition needs <, >, ≤, ≥ or =");
  }
  const fs = node.operands.map((o) => compileNumber(o, scope));
  const ops = node.ops;
  return (e) => {
    let left = fs[0]!(e);
    for (let k = 0; k < ops.length; k++) {
      const right = fs[k + 1]!(e);
      if (Number.isNaN(left) || Number.isNaN(right)) return false;
      switch (ops[k]) {
        case "<":
          if (!(left < right)) return false;
          break;
        case ">":
          if (!(left > right)) return false;
          break;
        case "<=":
          if (!(left <= right + EPS)) return false;
          break;
        case ">=":
          if (!(left + EPS >= right)) return false;
          break;
        case "=":
          if (Math.abs(left - right) > EPS * Math.max(1, Math.abs(left), Math.abs(right))) return false;
          break;
      }
      left = right;
    }
    return true;
  };
}
