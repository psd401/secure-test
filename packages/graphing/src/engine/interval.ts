// Interval arithmetic over the expression tree (D-4, decided: our own). For
// a box of the plane it answers "what values could F take here?", which is
// what lets the implicit plotter throw away every box where x²+y²−4 can't
// be 0 — and fill every box where y > x² surely holds — without sampling.
//
// An interval is [lo, hi] plus `def`, how much of the box F is defined on:
// "all", "some" (√x over a box crossing 0) or "none". Every operation is
// conservative: the true range is always inside [lo, hi]. Anything not
// worth the precision (aggregates, user functions with odd shapes) widens to
// (−∞, ∞) — never wrong, only less sharp. Sub-expressions with no x or y are
// evaluated once as plain numbers.

import { freeVariables, type Node, type Relation } from "./ast";
import { BUILTINS } from "./builtins";
import { CompileError, compileNumber, type Scope } from "./compile";

export type Def = "all" | "some" | "none";

export interface Interval {
  lo: number;
  hi: number;
  def: Def;
}

export type IntervalEnv = Record<string, Interval>;
export type IntervalFn = (env: IntervalEnv) => Interval;

const WHOLE: Interval = { lo: -Infinity, hi: Infinity, def: "some" };
const NONE: Interval = { lo: NaN, hi: NaN, def: "none" };

function point(v: number): Interval {
  return Number.isNaN(v) ? NONE : { lo: v, hi: v, def: "all" };
}

function both(a: Def, b: Def): Def {
  if (a === "none" || b === "none") return "none";
  return a === "all" && b === "all" ? "all" : "some";
}

function iv(lo: number, hi: number, def: Def): Interval {
  if (def === "none" || Number.isNaN(lo) || Number.isNaN(hi)) return def === "none" ? NONE : { lo: -Infinity, hi: Infinity, def };
  return { lo, hi, def };
}

export function add(a: Interval, b: Interval): Interval {
  return iv(a.lo + b.lo, a.hi + b.hi, both(a.def, b.def));
}

export function sub(a: Interval, b: Interval): Interval {
  return iv(a.lo - b.hi, a.hi - b.lo, both(a.def, b.def));
}

function mulBound(x: number, y: number): number {
  // 0 · ∞ is 0 for bounds: the product of a zero-width factor stays zero.
  if (x === 0 || y === 0) return 0;
  return x * y;
}

export function mul(a: Interval, b: Interval): Interval {
  const ps = [mulBound(a.lo, b.lo), mulBound(a.lo, b.hi), mulBound(a.hi, b.lo), mulBound(a.hi, b.hi)];
  return iv(Math.min(...ps), Math.max(...ps), both(a.def, b.def));
}

export function div(a: Interval, b: Interval): Interval {
  const def = both(a.def, b.def);
  if (def === "none") return NONE;
  if (b.lo === 0 && b.hi === 0) return NONE;
  if (b.lo > 0 || b.hi < 0) return mul(a, iv(1 / b.hi, 1 / b.lo, def));
  // The divisor's box contains 0: a pole may be inside; F is undefined at it.
  return { lo: -Infinity, hi: Infinity, def: "some" };
}

export function neg(a: Interval): Interval {
  return iv(-a.hi, -a.lo, a.def);
}

/** x^n for an integer n. */
function powInt(a: Interval, n: number): Interval {
  if (n === 0) return point(1);
  if (n < 0) return div(point(1), powInt(a, -n));
  const lo = Math.pow(a.lo, n);
  const hi = Math.pow(a.hi, n);
  if (n % 2 === 1) return iv(lo, hi, a.def);
  // Even power: smallest at the point nearest 0.
  if (a.lo >= 0) return iv(lo, hi, a.def);
  if (a.hi <= 0) return iv(hi, lo, a.def);
  return iv(0, Math.max(lo, hi), a.def);
}

export function pow(a: Interval, b: Interval, oddRoot: [number, number] | null): Interval {
  const def = both(a.def, b.def);
  if (def === "none") return NONE;
  if (b.lo === b.hi && Number.isInteger(b.lo)) return powInt(a, b.lo);
  if (oddRoot) {
    // x^(p/q), q odd: defined for negatives too (the real root).
    const [p, q] = oddRoot;
    const root = (x: number) => (x < 0 ? -Math.pow(-x, 1 / q) : Math.pow(x, 1 / q));
    return powInt(iv(root(a.lo), root(a.hi), def), p);
  }
  if (b.lo === b.hi) {
    // A constant non-integer exponent: defined for x ≥ 0 only.
    const e = b.lo;
    if (a.hi < 0) return NONE;
    const lo = Math.max(a.lo, 0);
    const vals = [Math.pow(lo, e), Math.pow(a.hi, e)];
    return iv(Math.min(...vals), Math.max(...vals), a.lo < 0 ? "some" : def);
  }
  // Variable exponent: positive base only, via exp(b·ln a).
  if (a.hi <= 0) return a.lo === a.hi && a.lo === 0 ? iv(0, 0, "some") : WHOLE;
  return exp(mul(b, ln(iv(Math.max(a.lo, 0), a.hi, a.lo <= 0 ? "some" : def))));
}

export function sqrt(a: Interval): Interval {
  if (a.def === "none" || a.hi < 0) return NONE;
  return iv(Math.sqrt(Math.max(0, a.lo)), Math.sqrt(a.hi), a.lo < 0 ? "some" : a.def);
}

export function abs(a: Interval): Interval {
  if (a.lo >= 0) return a;
  if (a.hi <= 0) return neg(a);
  return iv(0, Math.max(-a.lo, a.hi), a.def);
}

export function exp(a: Interval): Interval {
  return iv(Math.exp(a.lo), Math.exp(a.hi), a.def);
}

export function ln(a: Interval): Interval {
  if (a.def === "none" || a.hi <= 0) return NONE;
  return iv(a.lo <= 0 ? -Infinity : Math.log(a.lo), Math.log(a.hi), a.lo <= 0 ? "some" : a.def);
}

/** sin over an interval: the endpoints, plus ±1 wherever a peak falls inside. */
export function sin(a: Interval): Interval {
  if (a.def === "none") return NONE;
  if (!Number.isFinite(a.lo) || !Number.isFinite(a.hi) || a.hi - a.lo >= 2 * Math.PI) return iv(-1, 1, a.def);
  let lo = Math.min(Math.sin(a.lo), Math.sin(a.hi));
  let hi = Math.max(Math.sin(a.lo), Math.sin(a.hi));
  // Peaks at π/2 + 2πk, troughs at −π/2 + 2πk.
  const contains = (phase: number) => Math.ceil((a.lo - phase) / (2 * Math.PI)) <= Math.floor((a.hi - phase) / (2 * Math.PI));
  if (contains(Math.PI / 2)) hi = 1;
  if (contains(-Math.PI / 2)) lo = -1;
  return iv(lo, hi, a.def);
}

export function cos(a: Interval): Interval {
  return sin(add(a, point(Math.PI / 2)));
}

export function tan(a: Interval): Interval {
  if (a.def === "none") return NONE;
  if (!Number.isFinite(a.lo) || !Number.isFinite(a.hi) || a.hi - a.lo >= Math.PI) return WHOLE;
  // A pole at π/2 + πk inside: undefined there.
  const k = Math.ceil((a.lo - Math.PI / 2) / Math.PI);
  if (Math.PI / 2 + k * Math.PI <= a.hi) return WHOLE;
  return iv(Math.tan(a.lo), Math.tan(a.hi), a.def);
}

/** For a monotone non-decreasing f (floor, atan, …): [f(lo), f(hi)]. */
function monotone(f: (x: number) => number, a: Interval, domain?: [number, number]): Interval {
  if (a.def === "none") return NONE;
  if (domain) {
    const [dlo, dhi] = domain;
    if (a.hi < dlo || a.lo > dhi) return NONE;
    const lo = Math.max(a.lo, dlo);
    const hi = Math.min(a.hi, dhi);
    return iv(f(lo), f(hi), lo !== a.lo || hi !== a.hi ? "some" : a.def);
  }
  return iv(f(a.lo), f(a.hi), a.def);
}

/** Tri-state comparison: 0 = surely false, 1 = maybe, 2 = surely true. */
export type Truth = 0 | 1 | 2;

export function compare(a: Interval, op: Relation, b: Interval): Truth {
  if (a.def === "none" || b.def === "none") return 0;
  const sure = a.def === "all" && b.def === "all";
  const d = sub(a, b);
  let t: Truth;
  switch (op) {
    case "<":
      t = d.hi < 0 ? 2 : d.lo >= 0 ? 0 : 1;
      break;
    case "<=":
      t = d.hi <= 0 ? 2 : d.lo > 0 ? 0 : 1;
      break;
    case ">":
      t = d.lo > 0 ? 2 : d.hi <= 0 ? 0 : 1;
      break;
    case ">=":
      t = d.lo >= 0 ? 2 : d.hi < 0 ? 0 : 1;
      break;
    case "=":
      t = d.lo > 0 || d.hi < 0 ? 0 : d.lo === 0 && d.hi === 0 ? 2 : 1;
      break;
  }
  // "Surely true" needs F defined on the whole box.
  return t === 2 && !sure ? 1 : t;
}

const DEG = Math.PI / 180;

function oddRootOf(node: Node): [number, number] | null {
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

/**
 * The tree as an interval function of the bound variables (x, y). Constant
 * sub-trees are folded through the ordinary compiler.
 */
export function compileInterval(node: Node, scope: Scope, depth = 0): IntervalFn {
  if (depth > 64) return () => WHOLE;
  const vars = freeVariables(node);
  const usesBound = [...vars].some((v) => scope.bound.has(v));
  if (!usesBound) {
    const f = compileNumber(node, scope);
    const v = f({});
    return () => point(v);
  }
  const c = (n: Node) => compileInterval(n, scope, depth + 1);
  switch (node.kind) {
    case "num": {
      const p = point(node.value);
      return () => p;
    }
    case "var": {
      const name = node.name;
      if (scope.bound.has(name)) return (e) => e[name] ?? WHOLE;
      const f = compileNumber(node, scope);
      const p = point(f({}));
      return () => p;
    }
    case "neg": {
      const a = c(node.arg);
      return (e) => neg(a(e));
    }
    case "add": {
      const a = c(node.left);
      const b = c(node.right);
      return (e) => add(a(e), b(e));
    }
    case "sub": {
      const a = c(node.left);
      const b = c(node.right);
      return (e) => sub(a(e), b(e));
    }
    case "mul": {
      // x·x is x², whose interval is tighter than the product's.
      if (sameTree(node.left, node.right)) {
        const a = c(node.left);
        return (e) => powInt(a(e), 2);
      }
      const a = c(node.left);
      const b = c(node.right);
      return (e) => mul(a(e), b(e));
    }
    case "div": {
      const a = c(node.left);
      const b = c(node.right);
      return (e) => div(a(e), b(e));
    }
    case "pow": {
      if (node.left.kind === "call" && node.left.ambiguous && node.left.args.length === 1 && !scope.userFunction(node.left.name)) {
        return c({ kind: "mul", left: { kind: "var", name: node.left.name }, right: { ...node, left: node.left.args[0]! } });
      }
      const a = c(node.left);
      const b = c(node.right);
      const odd = oddRootOf(node.right);
      return (e) => pow(a(e), b(e), odd);
    }
    case "abs": {
      const a = c(node.arg);
      return (e) => abs(a(e));
    }
    case "root": {
      const a = c(node.arg);
      if (!node.index) return (e) => sqrt(a(e));
      const nf = compileNumber(node.index, scope);
      const n = nf({});
      if (Number.isInteger(n) && Math.abs(n) % 2 === 1) return (e) => pow(a(e), point(1 / n), [1, n]);
      return (e) => pow(a(e), point(1 / n), null);
    }
    case "call":
      return callInterval(node, scope, depth);
    case "piecewise": {
      const cases = node.cases.map((k) => ({ cond: compileTruth(k.cond, scope, depth + 1), value: k.value ? c(k.value) : () => point(1) }));
      const otherwise = node.otherwise ? c(node.otherwise) : () => NONE;
      return (e) => {
        // Union of the branches that may apply, in order, until one surely does.
        let lo = Infinity;
        let hi = -Infinity;
        let anyDef = false;
        let allDef = true;
        let settled = false;
        for (const k of cases) {
          const t = k.cond(e);
          if (t === 0) continue;
          const v = k.value(e);
          if (v.def !== "none") {
            lo = Math.min(lo, v.lo);
            hi = Math.max(hi, v.hi);
            anyDef = true;
          }
          if (v.def !== "all" || t !== 2) allDef = allDef && v.def === "all" && t === 2;
          if (t === 2) {
            settled = true;
            break;
          }
        }
        if (!settled) {
          const v = otherwise(e);
          if (v.def !== "none") {
            lo = Math.min(lo, v.lo);
            hi = Math.max(hi, v.hi);
            anyDef = true;
          }
          allDef = false;
        }
        if (!anyDef) return NONE;
        return iv(lo, hi, allDef ? "all" : "some");
      };
    }
    default:
      return () => WHOLE;
  }
}

function sameTree(a: Node, b: Node): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function callInterval(node: Extract<Node, { kind: "call" }>, scope: Scope, depth: number): IntervalFn {
  const c = (n: Node) => compileInterval(n, scope, depth + 1);
  const { name, args } = node;
  if (name === "__deg") {
    const a = c(args[0]!);
    return scope.degrees ? a : (e) => mul(a(e), point(DEG));
  }
  const user = scope.userFunction(name);
  if (user) return userFunctionInterval(name, args, scope, depth);
  if (node.ambiguous) {
    const a = c({ kind: "var", name });
    const b = c(args[0]!);
    return (e) => mul(a(e), b(e));
  }
  const b = BUILTINS[name];
  if (!b) throw new CompileError(`Unknown function ${name}`);
  if (scope.disabled.has(b.group)) throw new CompileError(`${name} is not available on this calculator`);
  if (args.length !== 1) return () => WHOLE;
  const a0 = c(args[0]!);
  const toRad = b.angle === "forward" && scope.degrees ? (e: IntervalEnv) => mul(a0(e), point(DEG)) : a0;
  switch (name) {
    case "sin":
      return (e) => sin(toRad(e));
    case "cos":
      return (e) => cos(toRad(e));
    case "tan":
      return (e) => tan(toRad(e));
    case "sec":
      return (e) => div(point(1), cos(toRad(e)));
    case "csc":
      return (e) => div(point(1), sin(toRad(e)));
    case "cot":
      return (e) => div(cos(toRad(e)), sin(toRad(e)));
    case "sqrt":
      return (e) => sqrt(a0(e));
    case "abs":
      return (e) => abs(a0(e));
    case "exp":
      return (e) => exp(a0(e));
    case "ln":
      return (e) => ln(a0(e));
    case "log":
      return (e) => div(ln(a0(e)), point(Math.LN10));
    case "floor":
      return (e) => monotone(Math.floor, a0(e));
    case "ceil":
      return (e) => monotone(Math.ceil, a0(e));
    case "round":
      return (e) => monotone(Math.round, a0(e));
    case "sign":
      return (e) => monotone(Math.sign, a0(e));
    case "arctan":
    case "arcsin":
    case "arccos": {
      const f = b.fn;
      const scaleOut = scope.degrees ? 1 / DEG : 1;
      const domain: [number, number] | undefined = name === "arctan" ? undefined : [-1, 1];
      // arccos decreases; the others increase.
      return (e) => {
        const r = monotone((x) => f(x) * scaleOut, a0(e), domain);
        return name === "arccos" ? iv(r.hi, r.lo, r.def) : r;
      };
    }
    case "sinh":
    case "tanh":
      return (e) => monotone(b.fn, a0(e));
    case "cosh":
      return (e) => {
        const a = abs(a0(e));
        return iv(Math.cosh(a.lo), Math.cosh(a.hi), a.def);
      };
    default:
      return () => WHOLE;
  }
}

function userFunctionInterval(name: string, args: Node[], scope: Scope, depth: number): IntervalFn {
  // Substitute the arguments into the body as trees and compile that, so the
  // interval sees through f(x) = x² to x². Only for shallow nesting; deeper
  // chains widen to the whole line.
  const body = scope.functionBody?.(name);
  if (!body || depth > 16) return () => WHOLE;
  const subst = substitute(body.body, new Map(body.params.map((p, i) => [p, args[i]!])));
  return compileInterval(subst, scope, depth + 1);
}

function substitute(node: Node, map: Map<string, Node>): Node {
  const s = (n: Node) => substitute(n, map);
  switch (node.kind) {
    case "var":
      return map.get(node.name) ?? node;
    case "num":
      return node;
    case "call":
      return { ...node, args: node.args.map(s) };
    case "neg":
    case "factorial":
    case "abs":
      return { ...node, arg: s(node.arg) };
    case "root":
      return { ...node, arg: s(node.arg), index: node.index ? s(node.index) : null };
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "pow":
      return { ...node, left: s(node.left), right: s(node.right) };
    case "point":
      return { ...node, coords: node.coords.map(s) };
    case "list":
      return { ...node, items: node.items.map(s) };
    case "compare":
      return { ...node, operands: node.operands.map(s) };
    case "piecewise":
      return {
        ...node,
        cases: node.cases.map((k) => ({ cond: s(k.cond), value: k.value ? s(k.value) : null })),
        otherwise: node.otherwise ? s(node.otherwise) : null,
      };
  }
}

/** A condition (comparison, possibly chained) as a tri-state over a box. */
export function compileTruth(node: Node, scope: Scope, depth = 0): (env: IntervalEnv) => Truth {
  if (node.kind !== "compare") throw new CompileError("A condition needs <, >, ≤, ≥ or =");
  const fs = node.operands.map((o) => compileInterval(o, scope, depth + 1));
  const ops = node.ops;
  return (e) => {
    let result: Truth = 2;
    let left = fs[0]!(e);
    for (let k = 0; k < ops.length; k++) {
      const right = fs[k + 1]!(e);
      const t = compare(left, ops[k]!, right);
      if (t === 0) return 0;
      if (t === 1) result = 1;
      left = right;
    }
    return result;
  };
}
