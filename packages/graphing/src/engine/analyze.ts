// The expression list as a whole (D-4): parse every row, collect the
// definitions (`a=3`, `f(x)=x^2`), resolve them in any order with cycle
// detection, then classify each row — a curve to plot, a region, points, a
// value to show, or an error with the names a slider could supply.

import { calledFunctions, freeVariables, type Node, type Relation, type Statement } from "./ast";
import { BUILTINS, CONSTANTS, type FunctionGroup } from "./builtins";
import {
  CompileError,
  compileCondition,
  compileList,
  compileNumber,
  compilePoint,
  compilePoints,
  display,
  shapeOf as nodeShape,
  type Env,
  type ListFn,
  type NumFn,
  type PointFn,
  type PointsFn,
  type Scope,
  type Shape,
  type UserFunction,
} from "./compile";
import { ParseError, parse } from "./parser";

export interface Row {
  id: string;
  latex: string;
}

export interface Settings {
  degrees: boolean;
  disabled: ReadonlySet<FunctionGroup>;
}

export const DEFAULT_SETTINGS: Settings = { degrees: false, disabled: new Set() };

export type Analysis =
  | { kind: "empty" }
  | { kind: "error"; message: string; missing: string[] }
  /** A constant expression or a non-slider definition: shown as "= value". */
  | { kind: "value"; value: number | number[]; name?: string }
  /** `a=3`: a number a slider can drive. */
  | { kind: "slider"; name: string; value: number }
  /** `f(x)=…` — plotted too when its one parameter is x. */
  | { kind: "function"; name: string; params: string[]; plot: Curve | null }
  | Curve
  | { kind: "points"; points: [number, number][]; name?: string }
  /** An equation or inequality in x and y together (slice 4 draws it). */
  | {
      kind: "implicit";
      relation: Relation;
      /** lhs − rhs. */
      f: (x: number, y: number) => number;
      lhs: Node;
      rhs: Node;
      restrict: ((x: number, y: number) => boolean) | null;
      scope: Scope;
    }
  /** A chained inequality such as `0<y<x`. */
  | {
      kind: "region";
      test: (x: number, y: number) => boolean;
      node: Node;
      restrict: ((x: number, y: number) => boolean) | null;
      scope: Scope;
    };

export interface Curve {
  kind: "curve";
  /** "y": y = f(x). "x": x = f(y). */
  of: "x" | "y";
  f: (t: number) => number;
  /** Absent for `=`; an inequality shades above / below the boundary. */
  relation: Relation;
  /** Pointwise domain restriction, (x, y) in graph coordinates. */
  restrict: ((x: number, y: number) => boolean) | null;
}

const COORDS = new Set(["x", "y"]);
/** Names a user may not define. */
const RESERVED = new Set(["x", "y", "t", "r", "theta", "e", "pi", "tau"]);

interface VarDef {
  kind: "var";
  name: string;
  rhs: Node;
  row: number;
}
interface FnDef {
  kind: "fn";
  name: string;
  params: string[];
  body: Node;
  row: number;
}
type Def = VarDef | FnDef;

/** Is this statement a definition, and of what? */
function definitionOf(st: Statement, row: number): Def | null {
  const b = st.body;
  if (b.kind !== "compare" || b.ops.length !== 1 || b.ops[0] !== "=") return null;
  const lhs = b.operands[0]!;
  // `f(x)=x^2\{x>0\}`: the restriction is part of what is defined —
  // undefined where it fails.
  let rhs = b.operands[1]!;
  for (const r of st.restrictions) rhs = { kind: "piecewise", cases: [{ cond: r, value: rhs }], otherwise: null };
  if (lhs.kind === "var" && !COORDS.has(lhs.name)) {
    return { kind: "var", name: lhs.name, rhs, row };
  }
  if (lhs.kind === "call" && lhs.ambiguous && lhs.args.every((a) => a.kind === "var")) {
    const params = lhs.args.map((a) => (a as { name: string }).name);
    if (new Set(params).size === params.length) {
      return { kind: "fn", name: lhs.name, params, body: rhs, row };
    }
  }
  return null;
}

class ListScope implements Scope {
  readonly bound: ReadonlySet<string>;
  private readonly cache = new Map<string, unknown>();
  private readonly shapes = new Map<string, Shape>();
  private readonly resolving = new Set<string>();
  private readonly fnCache = new Map<string, UserFunction>();

  constructor(
    readonly degrees: boolean,
    readonly disabled: ReadonlySet<FunctionGroup>,
    private readonly vars: Map<string, VarDef>,
    private readonly fns: Map<string, FnDef>,
    bound: ReadonlySet<string> = new Set(),
    private readonly root?: ListScope,
  ) {
    this.bound = bound;
  }

  /** The same definitions with other names bound (x, y, a function's params). */
  with(bound: Iterable<string>): ListScope {
    return new ListScope(this.degrees, this.disabled, this.vars, this.fns, new Set(bound), this.root ?? this);
  }

  private top(): ListScope {
    return this.root ?? this;
  }

  shapeOf(name: string): Shape | undefined {
    const top = this.top();
    const def = top.vars.get(name);
    if (!def) return undefined;
    const known = top.shapes.get(name);
    if (known) return known;
    if (top.resolving.has(name)) throw new CompileError(`${display(name)} is defined in terms of itself`);
    top.resolving.add(name);
    try {
      const s = nodeShape(def.rhs, top);
      top.shapes.set(name, s);
      return s;
    } finally {
      top.resolving.delete(name);
    }
  }

  private memo<T>(name: string, make: () => T): T {
    const top = this.top();
    if (top.cache.has(name)) return top.cache.get(name) as T;
    if (top.resolving.has(name)) throw new CompileError(`${display(name)} is defined in terms of itself`);
    top.resolving.add(name);
    try {
      const v = make();
      top.cache.set(name, v);
      return v;
    } finally {
      top.resolving.delete(name);
    }
  }

  private rhs(name: string): Node {
    return this.top().vars.get(name)!.rhs;
  }

  number(name: string): NumFn {
    const v = this.memo(name, () => compileNumber(this.rhs(name), this.top())({}));
    return () => v as number;
  }

  list(name: string): ListFn {
    const v = this.memo(name, () => compileList(this.rhs(name), this.top())({}));
    return () => v as number[];
  }

  point(name: string): PointFn {
    const v = this.memo(name, () => compilePoint(this.rhs(name), this.top())({}));
    return () => v as [number, number];
  }

  points(name: string): PointsFn {
    const v = this.memo(name, () => compilePoints(this.rhs(name), this.top())({}));
    return () => v as [number, number][];
  }

  userFunction(name: string): UserFunction | undefined {
    const top = this.top();
    const def = top.fns.get(name);
    if (!def) return undefined;
    const cached = top.fnCache.get(name);
    if (cached) return cached;
    let body: NumFn | null = null;
    const params = def.params;
    const uf: UserFunction = {
      params,
      call: (args) => {
        if (!body) body = compileNumber(def.body, top.with(params));
        const env: Env = {};
        for (let k = 0; k < params.length; k++) env[params[k]!] = args[k]!;
        return body(env);
      },
    };
    top.fnCache.set(name, uf);
    return uf;
  }

  /** Compiles every function body now so errors surface at analysis time. */
  checkFunction(name: string): void {
    const def = this.top().fns.get(name)!;
    compileNumber(def.body, this.top().with(def.params));
  }
}

/** Names a statement reads that nothing defines — slider candidates. */
function missingNames(node: Node, scope: ListScope, bound: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const name of freeVariables(node)) {
    if (bound.has(name) || name in CONSTANTS) continue;
    if (scope.shapeOf(name) !== undefined) continue;
    if (scope.userFunction(name)) continue;
    out.push(name);
  }
  return out;
}

/** Function definitions that call themselves, directly or not. */
function recursiveFunctions(fns: Map<string, FnDef>): Set<string> {
  const bad = new Set<string>();
  for (const start of fns.keys()) {
    const seen = new Set<string>();
    const stack = [...calledFunctions(fns.get(start)!.body)];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === start) {
        bad.add(start);
        break;
      }
      if (seen.has(n) || !fns.has(n)) continue;
      seen.add(n);
      stack.push(...calledFunctions(fns.get(n)!.body));
    }
  }
  return bad;
}

function errorOf(e: unknown): string {
  if (e instanceof ParseError || e instanceof CompileError) return e.message;
  if (e instanceof RangeError) return "Too deeply nested";
  return "Couldn't understand this";
}

function flip(r: Relation): Relation {
  return r === "<" ? ">" : r === ">" ? "<" : r === "<=" ? ">=" : r === ">=" ? "<=" : "=";
}

function isVar(n: Node, name: string): boolean {
  return n.kind === "var" && n.name === name;
}

export function analyze(rows: readonly Row[], settings: Settings = DEFAULT_SETTINGS): Analysis[] {
  const parsed: (Statement | ParseError | null)[] = rows.map((r) => {
    if (r.latex.trim() === "") return null;
    try {
      return parse(r.latex);
    } catch (e) {
      return e instanceof ParseError ? e : new ParseError(errorOf(e), 0);
    }
  });

  const defs: (Def | null)[] = parsed.map((p, i) => (p && !(p instanceof ParseError) ? definitionOf(p, i) : null));
  const vars = new Map<string, VarDef>();
  const fns = new Map<string, FnDef>();
  const duplicated = new Set<string>();
  const badName = new Map<number, string>();
  for (const d of defs) {
    if (!d) continue;
    if (RESERVED.has(d.name)) {
      badName.set(d.row, `${display(d.name)} can't be redefined`);
      continue;
    }
    if (BUILTINS[d.name] || d.name === "distance") {
      badName.set(d.row, `${d.name} is a built-in function`);
      continue;
    }
    if (vars.has(d.name) || fns.has(d.name)) duplicated.add(d.name);
    if (d.kind === "var") vars.set(d.name, d);
    else fns.set(d.name, d);
  }
  for (const name of duplicated) {
    vars.delete(name);
    fns.delete(name);
  }
  const recursive = recursiveFunctions(fns);
  for (const name of recursive) fns.delete(name);

  const scope = new ListScope(settings.degrees, settings.disabled, vars, fns);
  const xy = scope.with(COORDS);
  const broken = brokenFunctions(fns, scope);

  return parsed.map((p, i): Analysis => {
    if (p === null) return { kind: "empty" };
    if (p instanceof ParseError) return { kind: "error", message: p.message, missing: [] };
    const def = defs[i];
    try {
      if (def) {
        if (badName.has(i)) return { kind: "error", message: badName.get(i)!, missing: [] };
        if (duplicated.has(def.name)) {
          return { kind: "error", message: `${display(def.name)} is defined more than once`, missing: [] };
        }
        if (def.kind === "fn") {
          if (recursive.has(def.name)) {
            return { kind: "error", message: `${def.name} is defined in terms of itself`, missing: [] };
          }
          const bad = broken.get(def.name);
          if (bad) return bad.missing.length ? undefinedError(bad.missing) : { kind: "error", message: bad.message, missing: [] };
          let plot: Curve | null = null;
          if (def.params.length === 1 && def.params[0] === "x") {
            const uf = scope.userFunction(def.name)!;
            plot = { kind: "curve", of: "y", f: (x) => uf.call([x], {}), relation: "=", restrict: null };
          }
          return { kind: "function", name: def.name, params: def.params, plot };
        }
        const via = callsBroken(def.rhs, broken);
        if (via) return via;
        return variableRow(def, scope);
      }
      for (const r of [p.body, ...p.restrictions]) {
        const via = callsBroken(r, broken);
        if (via) return via;
      }
      return plotRow(p, scope, xy);
    } catch (e) {
      return { kind: "error", message: errorOf(e), missing: [] };
    }
  });
}

interface Broken {
  message: string;
  missing: string[];
}

/**
 * Functions whose bodies can't compile — directly (`f(x)=x+z` with no z)
 * or through a function they call. Their callers report the same names,
 * so a row using `f` offers the slider rather than failing while drawing.
 */
function brokenFunctions(fns: Map<string, FnDef>, scope: ListScope): Map<string, Broken> {
  const out = new Map<string, Broken>();
  for (const [name, def] of fns) {
    const missing = missingNames(def.body, scope, new Set(def.params));
    if (missing.length) {
      out.set(name, { message: "", missing });
      continue;
    }
    try {
      scope.checkFunction(name);
    } catch (e) {
      out.set(name, { message: errorOf(e), missing: [] });
    }
  }
  // Spread to callers until nothing changes.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, def] of fns) {
      if (out.has(name)) continue;
      for (const called of calledFunctions(def.body)) {
        const bad = out.get(called);
        if (bad) {
          out.set(name, { message: bad.message || `${called} has an error`, missing: bad.missing });
          changed = true;
          break;
        }
      }
    }
  }
  return out;
}

/** An error for a row that calls a broken function, or null. */
function callsBroken(node: Node, broken: Map<string, Broken>): Analysis | null {
  const missing: string[] = [];
  let message = "";
  for (const name of calledFunctions(node)) {
    const bad = broken.get(name);
    if (!bad) continue;
    for (const m of bad.missing) if (!missing.includes(m)) missing.push(m);
    message ||= bad.message ? `${name} has an error: ${bad.message}` : "";
  }
  if (missing.length) return undefinedError(missing);
  if (message) return { kind: "error", message, missing: [] };
  return null;
}

function undefinedError(missing: string[]): Analysis {
  const names = missing.map(display);
  const message =
    names.length === 1 ? `${names[0]} is not defined` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are not defined`;
  // t / θ / r belong to parametric and polar graphs, which come later.
  const sliders = missing.filter((m) => !RESERVED.has(m));
  return { kind: "error", message, missing: sliders };
}

function variableRow(def: VarDef, scope: ListScope): Analysis {
  const fv = freeVariables(def.rhs);
  if (fv.has("x") || fv.has("y")) {
    return { kind: "error", message: `${display(def.name)} can't depend on x or y — try ${display(def.name)}(x)=…`, missing: [] };
  }
  const missing = missingNames(def.rhs, scope, new Set());
  if (missing.length) return undefinedError(missing);
  const shape = scope.shapeOf(def.name)!;
  if (shape === "number") {
    const value = scope.number(def.name)({});
    if (isLiteral(def.rhs)) return { kind: "slider", name: def.name, value };
    return { kind: "value", value, name: def.name };
  }
  if (shape === "list") return { kind: "value", value: scope.list(def.name)({}), name: def.name };
  if (shape === "point") return { kind: "points", points: [scope.point(def.name)({})], name: def.name };
  return { kind: "points", points: scope.points(def.name)({}), name: def.name };
}

function isLiteral(n: Node): boolean {
  return n.kind === "num" || (n.kind === "neg" && n.arg.kind === "num");
}

function restriction(st: Statement, xy: ListScope): ((x: number, y: number) => boolean) | null {
  if (st.restrictions.length === 0) return null;
  const conds = st.restrictions.map((r) => compileCondition(r, xy));
  const env: Env = { x: 0, y: 0 };
  return (x, y) => {
    env.x = x;
    env.y = y;
    for (const c of conds) if (!c(env)) return false;
    return true;
  };
}

function curve(of: "x" | "y", expr: Node, relation: Relation, st: Statement, xy: ListScope): Curve {
  const variable = of === "y" ? "x" : "y";
  const f = compileNumber(expr, xy.with([variable]));
  const env: Env = {};
  return {
    kind: "curve",
    of,
    f: (t) => {
      env[variable] = t;
      return f(env);
    },
    relation,
    restrict: restriction(st, xy),
  };
}

function plotRow(st: Statement, scope: ListScope, xy: ListScope): Analysis {
  const missing = missingNames(st.body, scope, COORDS);
  for (const r of st.restrictions) for (const m of missingNames(r, scope, COORDS)) if (!missing.includes(m)) missing.push(m);
  if (missing.length) return undefinedError(missing);
  const b = st.body;
  const fv = freeVariables(b);

  if (b.kind !== "compare") {
    const shape = nodeShape(b, scope);
    if (shape === "point") {
      if (fv.has("x") || fv.has("y")) return { kind: "error", message: "Points can't depend on x or y", missing: [] };
      return { kind: "points", points: [compilePoint(b, scope)({})] };
    }
    if (shape === "points") return { kind: "points", points: compilePoints(b, scope)({}) };
    if (shape === "list") return { kind: "value", value: compileList(b, scope)({}) };
    if (fv.has("y")) {
      return { kind: "error", message: "Add y= or x= to graph this, or define y in an equation", missing: [] };
    }
    if (fv.has("x")) return curve("y", b, "=", st, xy);
    const value = compileNumber(b, scope)({});
    // `2\{1<0\}` — a restriction that fails leaves the value undefined.
    const holds = st.restrictions.every((r) => compileCondition(r, scope)({}));
    return { kind: "value", value: holds ? value : NaN };
  }

  if (b.ops.length > 1) {
    const test = compileCondition(b, xy);
    const env: Env = { x: 0, y: 0 };
    return {
      kind: "region",
      test: (x, y) => {
        env.x = x;
        env.y = y;
        return test(env);
      },
      node: b,
      restrict: restriction(st, xy),
      scope: xy,
    };
  }

  const [lhs, rhs] = b.operands as [Node, Node];
  const rel = b.ops[0]!;
  const lv = freeVariables(lhs);
  const rv = freeVariables(rhs);
  if (isVar(lhs, "y") && !rv.has("y")) return curve("y", rhs, rel, st, xy);
  if (isVar(rhs, "y") && !lv.has("y")) return curve("y", lhs, flip(rel), st, xy);
  if (isVar(lhs, "x") && !rv.has("x")) return curve("x", rhs, rel, st, xy);
  if (isVar(rhs, "x") && !lv.has("x")) return curve("x", lhs, flip(rel), st, xy);

  if (!fv.has("x") && !fv.has("y")) {
    // `2+2=4` — nothing to graph; show whether it holds.
    const holds = compileCondition(b, scope)({});
    return { kind: "error", message: holds ? "This is true, but there's nothing to graph" : "This is false", missing: [] };
  }
  const l = compileNumber(lhs, xy);
  const r = compileNumber(rhs, xy);
  const env: Env = { x: 0, y: 0 };
  return {
    kind: "implicit",
    relation: rel,
    f: (x, y) => {
      env.x = x;
      env.y = y;
      return l(env) - r(env);
    },
    lhs,
    rhs,
    restrict: restriction(st, xy),
    scope: xy,
  };
}
