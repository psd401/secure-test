// The expression tree every other engine module works on
// (docs/graphing-calculator-design.md D-4). The parser builds it from the
// LaTeX MathLive emits; analysis classifies it; the compiler turns it into
// closures. Pure data — no DOM, no evaluation — so it runs in Bun, in the
// browser and in the client's JSC harness alike.

export type Relation = "=" | "<" | ">" | "<=" | ">=";

export type Node =
  | { kind: "num"; value: number }
  | { kind: "var"; name: string }
  // `name(args)` where `name` is a single identifier that may be either a
  // user function or a variable times a parenthesis — decided in analysis,
  // once the definitions are known (`f(x)` vs `a(x+1)`).
  | { kind: "call"; name: string; args: Node[]; ambiguous: boolean }
  | { kind: "neg"; arg: Node }
  | { kind: "add" | "sub" | "mul" | "div" | "pow"; left: Node; right: Node }
  | { kind: "factorial"; arg: Node }
  | { kind: "abs"; arg: Node }
  | { kind: "root"; arg: Node; index: Node | null }
  | { kind: "point"; coords: Node[] }
  | { kind: "list"; items: Node[] }
  // A chained comparison `a < b <= c`: operands.length === ops.length + 1.
  | { kind: "compare"; operands: Node[]; ops: Relation[] }
  // `\{x<0: -x, x>=0: x\}` — the first case whose condition holds wins; a
  // case written without `: value` yields 1; nothing matching yields
  // `otherwise`, or undefined (NaN) when there is none.
  | { kind: "piecewise"; cases: { cond: Node; value: Node | null }[]; otherwise: Node | null };

/** One parsed expression-list row: the body plus any `{…}` restrictions. */
export interface Statement {
  body: Node;
  restrictions: Node[];
}

export function num(value: number): Node {
  return { kind: "num", value };
}

export function v(name: string): Node {
  return { kind: "var", name };
}

/** Every variable name a node reads (not function names). */
export function freeVariables(node: Node, out: Set<string> = new Set()): Set<string> {
  switch (node.kind) {
    case "num":
      break;
    case "var":
      out.add(node.name);
      break;
    case "call":
      // An ambiguous call may turn out to be `name * (args)`, so its name
      // counts as a possible variable; analysis drops it when `name` is a
      // defined function.
      if (node.ambiguous) out.add(node.name);
      for (const a of node.args) freeVariables(a, out);
      break;
    case "neg":
    case "factorial":
    case "abs":
      freeVariables(node.arg, out);
      break;
    case "root":
      freeVariables(node.arg, out);
      if (node.index) freeVariables(node.index, out);
      break;
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "pow":
      freeVariables(node.left, out);
      freeVariables(node.right, out);
      break;
    case "point":
      for (const c of node.coords) freeVariables(c, out);
      break;
    case "list":
      for (const c of node.items) freeVariables(c, out);
      break;
    case "compare":
      for (const c of node.operands) freeVariables(c, out);
      break;
    case "piecewise":
      for (const c of node.cases) {
        freeVariables(c.cond, out);
        if (c.value) freeVariables(c.value, out);
      }
      if (node.otherwise) freeVariables(node.otherwise, out);
      break;
  }
  return out;
}

/** Every function name a node calls. */
export function calledFunctions(node: Node, out: Set<string> = new Set()): Set<string> {
  const walk = (n: Node): void => {
    switch (n.kind) {
      case "call":
        out.add(n.name);
        n.args.forEach(walk);
        break;
      case "neg":
      case "factorial":
      case "abs":
        walk(n.arg);
        break;
      case "root":
        walk(n.arg);
        if (n.index) walk(n.index);
        break;
      case "add":
      case "sub":
      case "mul":
      case "div":
      case "pow":
        walk(n.left);
        walk(n.right);
        break;
      case "point":
        n.coords.forEach(walk);
        break;
      case "list":
        n.items.forEach(walk);
        break;
      case "compare":
        n.operands.forEach(walk);
        break;
      case "piecewise":
        for (const c of n.cases) {
          walk(c.cond);
          if (c.value) walk(c.value);
        }
        if (n.otherwise) walk(n.otherwise);
        break;
      default:
        break;
    }
  };
  walk(node);
  return out;
}
