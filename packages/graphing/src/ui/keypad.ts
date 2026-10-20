// The on-screen keypad (D-6): our own layout, typing into the math field
// that last had focus. Three pages — numbers and operators, letters in
// alphabetical order (the state-test layout), and functions — and the
// functions page leaves out any group the configuration disables.

import type { MathfieldElement } from "mathlive";
import type { FunctionGroup } from "../engine/builtins";

export interface Key {
  label: string;
  aria: string;
  /** LaTeX to insert; `#0` is the selection, `#?` a placeholder. */
  insert?: string;
  /** Characters to type as if from the keyboard (honours smart fences). */
  type?: string;
  command?: "left" | "right" | "backspace" | "enter";
  group?: FunctionGroup;
  wide?: boolean;
  /** Visual role: digits look quieter than operators. */
  tone?: "digit" | "op" | "action";
}

const k = (label: string, aria: string, spec: Partial<Key>): Key => ({ label, aria, ...spec });

const NAV: Key[] = [
  k("⌫", "Delete", { command: "backspace", tone: "action" }),
  k("←", "Move left", { command: "left", tone: "action" }),
  k("→", "Move right", { command: "right", tone: "action" }),
  k("↵", "New expression", { command: "enter", tone: "action" }),
];

export const MAIN_PAGE: Key[][] = [
  [
    k("x", "x", { type: "x" }),
    k("y", "y", { type: "y" }),
    k("a²", "squared", { insert: "#@^{2}" }),
    k("aᵇ", "power", { insert: "#@^{#?}" }),
    k("7", "7", { type: "7", tone: "digit" }),
    k("8", "8", { type: "8", tone: "digit" }),
    k("9", "9", { type: "9", tone: "digit" }),
    k("÷", "divide", { insert: "\\frac{#@}{#?}", tone: "op" }),
    NAV[0]!,
  ],
  [
    k("(", "open parenthesis", { type: "(" }),
    k(")", "close parenthesis", { type: ")" }),
    k("<", "less than", { insert: "<" }),
    k(">", "greater than", { insert: ">" }),
    k("4", "4", { type: "4", tone: "digit" }),
    k("5", "5", { type: "5", tone: "digit" }),
    k("6", "6", { type: "6", tone: "digit" }),
    k("×", "times", { insert: "\\cdot", tone: "op" }),
    NAV[1]!,
  ],
  [
    k("|a|", "absolute value", { insert: "\\left|#0\\right|" }),
    k(",", "comma", { type: "," }),
    k("≤", "less than or equal to", { insert: "\\le" }),
    k("≥", "greater than or equal to", { insert: "\\ge" }),
    k("1", "1", { type: "1", tone: "digit" }),
    k("2", "2", { type: "2", tone: "digit" }),
    k("3", "3", { type: "3", tone: "digit" }),
    k("−", "minus", { type: "-", tone: "op" }),
    NAV[2]!,
  ],
  [
    k("√", "square root", { insert: "\\sqrt{#0}" }),
    k("π", "pi", { insert: "\\pi" }),
    k("a/b", "fraction", { insert: "\\frac{#0}{#?}" }),
    k("°", "degrees", { insert: "^{\\circ}" }),
    k("0", "0", { type: "0", tone: "digit" }),
    k(".", "decimal point", { type: ".", tone: "digit" }),
    k("=", "equals", { type: "=", tone: "op" }),
    k("+", "plus", { type: "+", tone: "op" }),
    NAV[3]!,
  ],
];

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

export const ALPHA_PAGE: Key[][] = [
  [...LETTERS.slice(0, 9).map((c) => k(c, c, { type: c })), NAV[0]!],
  [...LETTERS.slice(9, 18).map((c) => k(c, c, { type: c })), NAV[1]!],
  [...LETTERS.slice(18).map((c) => k(c, c, { type: c })), k("θ", "theta", { insert: "\\theta" }), NAV[2]!],
  [
    k("aₙ", "subscript", { insert: "#@_{#?}" }),
    k("!", "factorial", { type: "!" }),
    k("[", "open bracket", { insert: "\\left[#0\\right]" }),
    k("{", "open brace", { insert: "\\left\\{#0\\right\\}" }),
    k(":", "colon", { type: ":" }),
    k("%", "percent", { insert: "\\%" }),
    k("space", "space", { insert: "\\,", wide: true }),
    NAV[3]!,
  ],
];

const fn = (name: string, group: FunctionGroup, label = name, latex = `\\operatorname{${name}}\\left(#0\\right)`) =>
  k(label, name, { insert: latex, group });

export const FUNCTION_PAGE: Key[][] = [
  [
    fn("sin", "trig", "sin", "\\sin\\left(#0\\right)"),
    fn("cos", "trig", "cos", "\\cos\\left(#0\\right)"),
    fn("tan", "trig", "tan", "\\tan\\left(#0\\right)"),
    fn("sin⁻¹", "inverseTrig", "sin⁻¹", "\\sin^{-1}\\left(#0\\right)"),
    fn("cos⁻¹", "inverseTrig", "cos⁻¹", "\\cos^{-1}\\left(#0\\right)"),
    fn("tan⁻¹", "inverseTrig", "tan⁻¹", "\\tan^{-1}\\left(#0\\right)"),
    fn("csc", "reciprocalTrig", "csc", "\\csc\\left(#0\\right)"),
    fn("sec", "reciprocalTrig", "sec", "\\sec\\left(#0\\right)"),
    fn("cot", "reciprocalTrig", "cot", "\\cot\\left(#0\\right)"),
  ],
  [
    fn("ln", "log", "ln", "\\ln\\left(#0\\right)"),
    fn("log", "log", "log", "\\log\\left(#0\\right)"),
    fn("logₐ", "log", "logₐ", "\\log_{#?}\\left(#0\\right)"),
    fn("eˣ", "log", "eˣ", "e^{#0}"),
    fn("ⁿ√", "misc", "ⁿ√", "\\sqrt[#?]{#0}"),
    fn("abs", "misc"),
    fn("round", "rounding"),
    fn("floor", "rounding"),
    fn("ceil", "rounding"),
  ],
  [
    fn("mean", "stats"),
    fn("median", "stats"),
    fn("stdev", "stats"),
    fn("min", "stats"),
    fn("max", "stats"),
    fn("total", "stats"),
    fn("nCr", "combinatorics"),
    fn("nPr", "combinatorics"),
    fn("mod", "numberTheory"),
  ],
  [
    fn("sinh", "hyperbolic", "sinh", "\\sinh\\left(#0\\right)"),
    fn("cosh", "hyperbolic", "cosh", "\\cosh\\left(#0\\right)"),
    fn("tanh", "hyperbolic", "tanh", "\\tanh\\left(#0\\right)"),
    fn("gcd", "numberTheory"),
    fn("lcm", "numberTheory"),
    fn("mad", "advancedStats"),
    fn("var", "stats"),
    k("x!", "factorial", { insert: "#@!", group: "misc" }),
    NAV[3]!,
  ],
];

/** Sends a key to a math field. */
export function press(field: MathfieldElement, key: Key, onEnter: () => void): void {
  if (key.command === "enter") return onEnter();
  if (key.command === "backspace") {
    field.executeCommand("deleteBackward");
  } else if (key.command === "left") {
    field.executeCommand("moveToPreviousChar");
  } else if (key.command === "right") {
    field.executeCommand("moveToNextChar");
  } else if (key.type !== undefined) {
    field.executeCommand(["typedText", key.type]);
  } else if (key.insert !== undefined) {
    field.insert(key.insert, { focus: true, selectionMode: "placeholder", feedback: false });
  }
  field.focus();
}

export type Page = "main" | "alpha" | "functions";

export class Keypad {
  readonly element: HTMLElement;
  private page: Page = "main";

  constructor(
    host: HTMLElement,
    private readonly target: () => MathfieldElement | null,
    private readonly onEnter: () => void,
    private readonly disabled: ReadonlySet<FunctionGroup>,
    private readonly pages: Page[] = ["main", "alpha", "functions"],
  ) {
    this.element = document.createElement("div");
    this.element.className = "gc-keypad";
    this.element.setAttribute("role", "group");
    this.element.setAttribute("aria-label", "Keypad");
    // Keys must not take focus from the math field.
    this.element.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button")) e.preventDefault();
    });
    host.append(this.element);
    this.render();
  }

  show(page: Page): void {
    this.page = page;
    this.render();
  }

  private render(): void {
    this.element.replaceChildren();
    if (this.pages.length > 1) {
      const tabs = document.createElement("div");
      tabs.className = "gc-keypad-tabs";
      tabs.setAttribute("role", "tablist");
      const names: Record<Page, string> = { main: "123", alpha: "abc", functions: "functions" };
      for (const p of this.pages) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "gc-tab";
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(p === this.page));
        b.textContent = names[p];
        b.addEventListener("click", () => this.show(p));
        tabs.append(b);
      }
      this.element.append(tabs);
    }
    const rows = this.page === "main" ? MAIN_PAGE : this.page === "alpha" ? ALPHA_PAGE : FUNCTION_PAGE;
    const grid = document.createElement("div");
    grid.className = `gc-keys gc-keys-${this.page}`;
    for (const row of rows) {
      for (const key of row) {
        if (key.group && this.disabled.has(key.group)) {
          const gap = document.createElement("span");
          gap.className = "gc-key-gap";
          grid.append(gap);
          continue;
        }
        const b = document.createElement("button");
        b.type = "button";
        b.className = `gc-key gc-key-${key.tone ?? "plain"}${key.wide ? " gc-key-wide" : ""}`;
        b.textContent = key.label;
        b.setAttribute("aria-label", key.aria);
        b.addEventListener("click", () => {
          const f = this.target();
          if (f) press(f, key, this.onEnter);
        });
        grid.append(b);
      }
    }
    this.element.append(grid);
  }
}
