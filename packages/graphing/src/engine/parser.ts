// LaTeX → expression tree (D-4). The input is what MathLive's `getValue()`
// emits for an expression-list row: `y=2x+1`, `\frac{1}{2}x^{2}`,
// `\sin\left(x\right)`, `f\left(x\right)=x^2`, `y\le x\left\{x>0\right\}`.
// The grammar follows the graphing calculator students already use:
// implicit multiplication (`2x`, `2(x+1)`, `xy`), unparenthesised function
// arguments (`\sin 2x`), `\sin^2x`, `\sin^{-1}x`, `\log_2 x`, piecewise
// `\{x<0: -x, x\}`, and trailing `\{…\}` domain restrictions.

import type { Node, Relation, Statement } from "./ast";
import { FUNCTION_NAMES, LATEX_FUNCTIONS } from "./builtins";

export class ParseError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

type TokenType =
  | "num"
  | "ident" // a single letter or a greek / named variable, possibly subscripted
  | "fn" // a built-in function by LaTeX command or \operatorname
  | "op" // + - * / ^ _ ! , : =
  | "rel" // < > <= >=
  | "(" | ")" | "[" | "]" | "{" | "}"
  | "abs" // a bare |, open or close by context
  | "absL" | "absR" // \left| / \right|
  | "setL" | "setR" // \{ \} \lbrace \rbrace — restriction / piecewise braces
  | "frac" | "sqrt" | "deg" | "placeholder" | "infty" | "ne"
  | "eof";

interface Token {
  type: TokenType;
  text: string;
  pos: number;
}

/** Commands that read as a named variable. */
const GREEK = new Set([
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta",
  "iota", "kappa", "lambda", "mu", "nu", "xi", "rho", "sigma", "upsilon", "phi", "varphi",
  "chi", "psi", "omega", "Gamma", "Delta", "Theta", "Lambda", "Xi", "Sigma", "Phi", "Psi", "Omega",
]);

/** Commands that are spacing or styling and carry no meaning here. */
const IGNORED = new Set([",", ";", ":", "!", " ", "quad", "qquad", "displaystyle", "textstyle", "mathit", "limits"]);

const UNICODE: Record<string, [TokenType, string]> = {
  "≤": ["rel", "<="],
  "≥": ["rel", ">="],
  "×": ["op", "*"],
  "÷": ["op", "/"],
  "·": ["op", "*"],
  "⋅": ["op", "*"],
  "−": ["op", "-"],
  "π": ["ident", "pi"],
  "θ": ["ident", "theta"],
  "∞": ["infty", "∞"],
  "≠": ["ne", "≠"],
  "°": ["deg", "°"],
};

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (type: TokenType, text: string, pos: number) => out.push({ type, text, pos });

  // Reads a braced word (`{abc}`) after \operatorname / \mathrm.
  const bracedWord = (): string => {
    while (src[i] === " ") i++;
    if (src[i] === "*") i++;
    if (src[i] !== "{") throw new ParseError("Expected a name in braces", i);
    const close = src.indexOf("}", i);
    if (close < 0) throw new ParseError("Unclosed brace", i);
    const word = src.slice(i + 1, close).replace(/\\,|\s/g, "");
    i = close + 1;
    return word;
  };

  while (i < src.length) {
    const c = src[i]!;
    const start = i;
    if (c === " " || c === "\t" || c === "\n" || c === "~") {
      i++;
      continue;
    }
    if ((c >= "0" && c <= "9") || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) {
        j++;
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      } else if (src[j] === "." && j > i && !/[0-9.]/.test(src[j + 1] ?? "")) {
        // "2." — a trailing point mid-typing still reads as 2.
        j++;
      }
      push("num", src.slice(i, j), start);
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      push("ident", c, start);
      i++;
      continue;
    }
    if (c === "\\") {
      // A control symbol (\{ \, \|) or a control word.
      const next = src[i + 1] ?? "";
      if (!/[A-Za-z]/.test(next)) {
        i += 2;
        if (next === "{") push("setL", "{", start);
        else if (next === "}") push("setR", "}", start);
        else if (next === "|") push("abs", "|", start);
        else if (next === "%") push("op", "%", start);
        else if (IGNORED.has(next)) continue;
        else throw new ParseError(`Unexpected \\${next}`, start);
        continue;
      }
      let j = i + 1;
      while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
      const word = src.slice(i + 1, j);
      i = j;
      if (IGNORED.has(word)) continue;
      switch (word) {
        case "left":
        case "mleft":
        case "right":
        case "mright":
        case "bigl":
        case "bigr":
        case "Bigl":
        case "Bigr": {
          const isLeft = word.endsWith("left") || word.endsWith("l");
          while (src[i] === " ") i++;
          // The delimiter: a char, \{ \}, or a word (\vert \lbrace …).
          let d = src[i] ?? "";
          if (d === "\\") {
            let k = i + 1;
            if (/[A-Za-z]/.test(src[k] ?? "")) {
              while (k < src.length && /[A-Za-z]/.test(src[k]!)) k++;
              d = src.slice(i + 1, k);
            } else {
              d = src[k] ?? "";
              k++;
            }
            i = k;
          } else {
            i++;
          }
          if (d === "(" || d === "lparen") push(isLeft ? "(" : ")", isLeft ? "(" : ")", start);
          else if (d === ")" || d === "rparen") push(")", ")", start);
          else if (d === "[" || d === "lbrack") push(isLeft ? "[" : "]", isLeft ? "[" : "]", start);
          else if (d === "]" || d === "rbrack") push("]", "]", start);
          else if (d === "{" || d === "lbrace") push(isLeft ? "setL" : "setR", isLeft ? "{" : "}", start);
          else if (d === "}" || d === "rbrace") push("setR", "}", start);
          else if (d === "|" || d === "vert" || d === "lvert" || d === "rvert")
            push(isLeft ? "absL" : "absR", "|", start);
          else if (d === ".") continue; // \left. — an invisible delimiter
          else throw new ParseError(`Unsupported delimiter ${d}`, start);
          continue;
        }
        case "lparen":
          push("(", "(", start);
          continue;
        case "rparen":
          push(")", ")", start);
          continue;
        case "lbrack":
          push("[", "[", start);
          continue;
        case "rbrack":
          push("]", "]", start);
          continue;
        case "lbrace":
          push("setL", "{", start);
          continue;
        case "rbrace":
          push("setR", "}", start);
          continue;
        case "vert":
        case "lvert":
        case "rvert":
        case "mid":
          push("abs", "|", start);
          continue;
        case "cdot":
        case "times":
        case "ast":
          push("op", "*", start);
          continue;
        case "div":
          push("op", "/", start);
          continue;
        case "le":
        case "leq":
        case "leqslant":
          push("rel", "<=", start);
          continue;
        case "ge":
        case "geq":
        case "geqslant":
          push("rel", ">=", start);
          continue;
        case "lt":
          push("rel", "<", start);
          continue;
        case "gt":
          push("rel", ">", start);
          continue;
        case "ne":
        case "neq":
          push("ne", "≠", start);
          continue;
        case "frac":
        case "dfrac":
        case "tfrac":
          push("frac", "frac", start);
          continue;
        case "sqrt":
          push("sqrt", "sqrt", start);
          continue;
        case "circ":
        case "degree":
          push("deg", "°", start);
          continue;
        case "infty":
          push("infty", "∞", start);
          continue;
        case "placeholder":
          push("placeholder", "placeholder", start);
          // Skip its optional [..] and {..} arguments.
          if (src[i] === "[") i = src.indexOf("]", i) + 1 || src.length;
          if (src[i] === "{") i = src.indexOf("}", i) + 1 || src.length;
          continue;
        case "exponentialE":
          push("ident", "e", start);
          continue;
        case "pi":
          push("ident", "pi", start);
          continue;
        case "tau":
          push("ident", "tau", start);
          continue;
        case "operatorname":
        case "mathrm":
        case "text":
        case "mathit":
        case "mathbf": {
          const name = bracedWord();
          if (FUNCTION_NAMES.has(name)) push("fn", name, start);
          else if (name.length === 1) push("ident", name, start);
          else throw new ParseError(`Unknown function ${name}`, start);
          continue;
        }
        default:
          if (word in LATEX_FUNCTIONS) push("fn", LATEX_FUNCTIONS[word]!, start);
          else if (FUNCTION_NAMES.has(word)) push("fn", word, start);
          else if (GREEK.has(word)) push("ident", word, start);
          else throw new ParseError(`Unknown command \\${word}`, start);
          continue;
      }
    }
    if (c in UNICODE) {
      const [type, text] = UNICODE[c]!;
      push(type, text, start);
      i++;
      continue;
    }
    if (c === "<" || c === ">") {
      if (src[i + 1] === "=") {
        push("rel", c + "=", start);
        i += 2;
      } else {
        push("rel", c, start);
        i++;
      }
      continue;
    }
    if ("+-*/^_!,:=".includes(c)) {
      push("op", c, start);
      i++;
      continue;
    }
    if ("()[]{}".includes(c)) {
      push(c as TokenType, c, start);
      i++;
      continue;
    }
    if (c === "|") {
      push("abs", "|", start);
      i++;
      continue;
    }
    if (c === "%") {
      push("op", "%", start);
      i++;
      continue;
    }
    throw new ParseError(`Unexpected character ${c}`, start);
  }
  out.push({ type: "eof", text: "", pos: src.length });
  return out;
}

/** Names that are coordinates or parameters, never functions. */
const NEVER_CALLED = new Set(["x", "y", "t", "r", "theta"]);

class Parser {
  private i = 0;
  private absDepth = 0;

  constructor(private readonly toks: Token[]) {}

  private peek(offset = 0): Token {
    return this.toks[Math.min(this.i + offset, this.toks.length - 1)]!;
  }

  private next(): Token {
    const t = this.peek();
    if (t.type !== "eof") this.i++;
    return t;
  }

  private isOp(text: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === "op" && t.text === text;
  }

  private expect(type: TokenType, what: string): Token {
    const t = this.peek();
    if (t.type !== type) throw new ParseError(`Expected ${what}`, t.pos);
    return this.next();
  }

  statement(): Statement {
    if (this.peek().type === "eof") throw new ParseError("Empty expression", 0);
    let body = this.comparison();
    // Top-level `(1,2),(3,4)` is a list of points.
    if (this.isOp(",")) {
      const items = [body];
      while (this.isOp(",")) {
        this.next();
        items.push(this.comparison());
      }
      body = { kind: "list", items };
    }
    const restrictions: Node[] = [];
    while (this.peek().type === "setL") {
      this.next();
      restrictions.push(this.comparison());
      // `\{x>0, x<5\}` — several conditions in one brace all apply.
      while (this.isOp(",")) {
        this.next();
        restrictions.push(this.comparison());
      }
      this.expect("setR", "}");
    }
    const t = this.peek();
    if (t.type !== "eof") {
      if (t.type === ")" || t.type === "]" || t.type === "}" || t.type === "absR" || t.type === "setR")
        throw new ParseError("Unbalanced bracket", t.pos);
      if (t.type === "ne") throw new ParseError("≠ is not supported", t.pos);
      throw new ParseError(`Unexpected ${t.text}`, t.pos);
    }
    return { body, restrictions };
  }

  comparison(): Node {
    const first = this.expr();
    const operands = [first];
    const ops: Relation[] = [];
    for (;;) {
      const t = this.peek();
      if (t.type === "rel") {
        this.next();
        ops.push(t.text as Relation);
      } else if (t.type === "op" && t.text === "=") {
        this.next();
        ops.push("=");
      } else if (t.type === "ne") {
        throw new ParseError("≠ is not supported", t.pos);
      } else break;
      operands.push(this.expr());
    }
    if (ops.length === 0) return first;
    if (ops.includes("=") && ops.length > 1) {
      throw new ParseError("An equation can have only one =", this.peek().pos);
    }
    return { kind: "compare", operands, ops };
  }

  expr(): Node {
    let left = this.term();
    for (;;) {
      if (this.isOp("+")) {
        this.next();
        left = { kind: "add", left, right: this.term() };
      } else if (this.isOp("-")) {
        this.next();
        left = { kind: "sub", left, right: this.term() };
      } else return left;
    }
  }

  term(): Node {
    let left = this.unary();
    for (;;) {
      if (this.isOp("*")) {
        this.next();
        left = { kind: "mul", left, right: this.unary() };
      } else if (this.isOp("/")) {
        this.next();
        left = { kind: "div", left, right: this.unary() };
      } else if (this.startsOperand()) {
        left = { kind: "mul", left, right: this.power() };
      } else return left;
    }
  }

  /** Can the next token begin an implicitly multiplied factor? */
  private startsOperand(): boolean {
    const t = this.peek();
    switch (t.type) {
      case "num":
      case "ident":
      case "fn":
      case "(":
      case "[":
      case "absL":
      case "frac":
      case "sqrt":
      case "infty":
      case "placeholder":
        return true;
      case "abs":
        // Inside |…| a bar closes; outside it opens a new absolute value.
        return this.absDepth === 0;
      case "setL":
        // `2\{x<0:1,3\}` multiplies by a piecewise; braces that end the
        // row with only conditions in them are its domain restriction.
        return !this.trailingRestrictions();
      case "{":
        return true;
      default:
        return false;
    }
  }

  /** From here: only `\{conditions\}` groups, then the end of the row? */
  private trailingRestrictions(): boolean {
    let k = this.i;
    while (this.toks[k]?.type === "setL") {
      let depth = 0;
      for (;;) {
        const t = this.toks[k];
        if (!t || t.type === "eof") return false;
        if (t.type === "setL") depth++;
        else if (t.type === "setR") {
          depth--;
          if (depth === 0) break;
        } else if (depth === 1 && t.type === "op" && t.text === ":") return false;
        k++;
      }
      k++;
    }
    return this.toks[k]?.type === "eof";
  }

  unary(): Node {
    if (this.isOp("-")) {
      this.next();
      return { kind: "neg", arg: this.unary() };
    }
    if (this.isOp("+")) {
      this.next();
      return this.unary();
    }
    return this.power();
  }

  power(): Node {
    const base = this.postfix();
    if (this.isOp("^")) {
      this.next();
      if (this.peek().type === "deg") {
        this.next();
        return this.postfixOn({ kind: "call", name: "__deg", args: [base], ambiguous: false });
      }
      if (this.peek().type === "{" && this.peek(1).type === "deg" && this.peek(2).type === "}") {
        this.i += 3;
        return this.postfixOn({ kind: "call", name: "__deg", args: [base], ambiguous: false });
      }
      const exponent = this.exponent();
      return this.postfixOn({ kind: "pow", left: base, right: exponent });
    }
    return base;
  }

  /** `x^{…}` takes a group; bare `x^2` takes ONE token, as in TeX. */
  private exponent(): Node {
    const t = this.peek();
    if (t.type === "{") return this.group();
    if (t.type === "op" && t.text === "-") {
      this.next();
      return { kind: "neg", arg: this.exponent() };
    }
    if (t.type === "num" && t.text.length > 1) {
      // `x^23` in TeX is x² · 3: split the digit run.
      this.toks.splice(this.i + 1, 0, { type: "num", text: t.text.slice(1), pos: t.pos + 1 });
      this.toks[this.i] = { type: "num", text: t.text[0]!, pos: t.pos };
    }
    const base = this.postfix();
    // `2^3^2` (a TeX error, but typed by hand) reads right to left.
    if (this.isOp("^")) {
      this.next();
      return { kind: "pow", left: base, right: this.exponent() };
    }
    return base;
  }

  private postfixOn(node: Node): Node {
    let n = node;
    while (this.isOp("!")) {
      this.next();
      n = { kind: "factorial", arg: n };
    }
    if (this.isOp("%")) {
      this.next();
      n = { kind: "div", left: n, right: { kind: "num", value: 100 } };
    }
    if (this.peek().type === "deg") {
      this.next();
      n = { kind: "call", name: "__deg", args: [n], ambiguous: false };
    }
    return n;
  }

  postfix(): Node {
    return this.postfixOn(this.atom());
  }

  /** A TeX argument: `{…}` or a single token. */
  private group(): Node {
    if (this.peek().type === "{") {
      this.next();
      if (this.peek().type === "}") throw new ParseError("Empty group", this.peek().pos);
      const saved = this.absDepth;
      this.absDepth = 0;
      const inner = this.comparison();
      this.absDepth = saved;
      this.expect("}", "}");
      return inner;
    }
    const t = this.peek();
    if (t.type === "num" && t.text.length > 1) {
      // `\frac12` = ½: one digit per argument.
      this.toks.splice(this.i + 1, 0, { type: "num", text: t.text.slice(1), pos: t.pos + 1 });
      this.toks[this.i] = { type: "num", text: t.text[0]!, pos: t.pos };
    }
    return this.atom();
  }

  atom(): Node {
    const t = this.peek();
    switch (t.type) {
      case "num": {
        this.next();
        return { kind: "num", value: Number(t.text) };
      }
      case "infty":
        this.next();
        return { kind: "num", value: Infinity };
      case "placeholder":
        throw new ParseError("Fill in the empty box", t.pos);
      case "{":
        return this.group();
      case "(": {
        this.next();
        const items = this.commaList(")");
        if (items.length === 1) return items[0]!;
        return { kind: "point", coords: items };
      }
      case "[": {
        this.next();
        return { kind: "list", items: this.peek().type === "]" ? (this.next(), []) : this.commaList("]") };
      }
      case "absL": {
        this.next();
        const saved = this.absDepth;
        this.absDepth = 0;
        const arg = this.expr();
        this.absDepth = saved;
        this.expect("absR", "closing |");
        return { kind: "abs", arg };
      }
      case "abs": {
        this.next();
        this.absDepth++;
        const arg = this.expr();
        this.absDepth--;
        this.expect("abs", "closing |");
        return { kind: "abs", arg };
      }
      case "setL":
        return this.piecewise();
      case "frac": {
        this.next();
        const num = this.group();
        const den = this.group();
        return { kind: "div", left: num, right: den };
      }
      case "sqrt": {
        this.next();
        let index: Node | null = null;
        if (this.peek().type === "[") {
          this.next();
          index = this.expr();
          this.expect("]", "]");
        }
        return { kind: "root", arg: this.group(), index };
      }
      case "fn":
        this.next();
        return this.application(t.text, t.pos);
      case "ident":
        return this.identifier();
      case "eof":
        throw new ParseError("Expression is incomplete", t.pos);
      default:
        throw new ParseError(`Unexpected ${t.text || t.type}`, t.pos);
    }
  }

  /** Brackets reset bar matching: `|(2|x|)|` opens a fresh |…| inside. */
  private commaList(close: ")" | "]"): Node[] {
    const saved = this.absDepth;
    this.absDepth = 0;
    const items = [this.comparison()];
    while (this.isOp(",")) {
      this.next();
      items.push(this.comparison());
    }
    this.absDepth = saved;
    this.expect(close, close);
    return items;
  }

  /** `\{cond: value, cond: value, otherwise\}`. */
  private piecewise(): Node {
    this.next();
    const cases: { cond: Node; value: Node | null }[] = [];
    let otherwise: Node | null = null;
    for (;;) {
      const first = this.comparison();
      if (this.isOp(":")) {
        this.next();
        cases.push({ cond: first, value: this.comparison() });
      } else if (first.kind === "compare" && first.ops.every((o) => o !== "=") ) {
        cases.push({ cond: first, value: null });
      } else {
        otherwise = first;
        if (!this.isOp(",")) break;
        throw new ParseError("The fallback must be the last part of { }", this.peek().pos);
      }
      if (!this.isOp(",")) break;
      this.next();
    }
    this.expect("setR", "}");
    return { kind: "piecewise", cases, otherwise };
  }

  /** A function applied to arguments, with `^n`, `^{-1}`, `_b` handled. */
  private application(name: string, pos: number): Node {
    let fname = name;
    let power: Node | null = null;
    let base: Node | null = null;
    if (fname === "log" && this.isOp("_")) {
      this.next();
      base = this.group();
    }
    if (this.isOp("^")) {
      this.next();
      const e = this.exponent();
      const isInverse = e.kind === "neg" && e.arg.kind === "num" && e.arg.value === 1;
      if (isInverse && ["sin", "cos", "tan", "sec", "csc", "cot", "sinh", "cosh", "tanh"].includes(fname)) {
        fname = "arc" + fname;
      } else {
        power = e;
      }
    }
    let args: Node[];
    if (this.peek().type === "(") {
      this.next();
      args = this.commaList(")");
    } else if (this.peek().type === "[") {
      this.next();
      args = [{ kind: "list", items: this.peek().type === "]" ? (this.next(), []) : this.commaList("]") }];
    } else {
      args = [this.bareArgument(pos)];
    }
    if (base) {
      if (args.length !== 1) throw new ParseError("log takes one argument", pos);
      fname = "logb";
      args = [args[0]!, base];
    }
    let node: Node = { kind: "call", name: fname, args, ambiguous: false };
    if (power) node = { kind: "pow", left: node, right: power };
    return this.postfixOn(node);
  }

  /**
   * `\sin 2x` — an argument without parentheses runs over juxtaposed factors
   * and stops at an operator or the next function (`\sin x\cos x` is
   * sin(x)·cos(x)).
   */
  private bareArgument(pos: number): Node {
    let negate = false;
    if (this.isOp("-")) {
      this.next();
      negate = true;
    }
    if (!this.startsOperand()) throw new ParseError("Function needs an argument", pos);
    let arg = this.power();
    while (this.startsOperand() && this.peek().type !== "fn" && !this.functionWordAhead()) {
      arg = { kind: "mul", left: arg, right: this.power() };
    }
    return negate ? { kind: "neg", arg } : arg;
  }

  /** Letters ahead that spell a built-in followed by `(` (typed `mean(`). */
  private functionWordAhead(): string | null {
    let word = "";
    let best: string | null = null;
    for (let k = 0; ; k++) {
      const t = this.peek(k);
      if (t.type !== "ident" || t.text.length !== 1) break;
      word += t.text;
      if (FUNCTION_NAMES.has(word) && word.length > 1 && this.peek(k + 1).type === "(") best = word;
    }
    return best;
  }

  private identifier(): Node {
    const word = this.functionWordAhead();
    if (word) {
      const pos = this.peek().pos;
      this.i += word.length;
      return this.application(word, pos);
    }
    const t = this.next();
    let name = t.text;
    if (this.isOp("_")) {
      this.next();
      name += "_" + this.subscript();
    }
    if (this.peek().type === "(" && !NEVER_CALLED.has(name)) {
      this.next();
      const args = this.commaList(")");
      return { kind: "call", name, args, ambiguous: true };
    }
    return { kind: "var", name };
  }

  /** A subscript's text: one character, or a braced run of letters/digits. */
  private subscript(): string {
    const t = this.peek();
    if (t.type === "{") {
      this.next();
      let s = "";
      while (this.peek().type === "num" || this.peek().type === "ident") s += this.next().text;
      this.expect("}", "}");
      if (!s) throw new ParseError("Empty subscript", t.pos);
      return s;
    }
    if (t.type === "num") {
      this.next();
      if (t.text.length > 1) {
        // `a_12` in TeX subscripts only the 1.
        this.toks.splice(this.i, 0, { type: "num", text: t.text.slice(1), pos: t.pos + 1 });
        return t.text[0]!;
      }
      return t.text;
    }
    if (t.type === "ident") return this.next().text;
    throw new ParseError("Expected a subscript", t.pos);
  }
}

/** Parses one expression-list row. Throws ParseError. */
export function parse(latex: string): Statement {
  return new Parser(tokenize(latex)).statement();
}
