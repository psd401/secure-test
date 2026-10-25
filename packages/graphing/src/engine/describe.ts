// Words for a graph (D-8 / D-11): a stimulus graph needs alt text, and the
// editor drafts it from the expressions and the view so the teacher edits
// rather than writes. Also the readable form of a LaTeX expression, used
// wherever a graph is listed without MathLive or KaTeX.

export interface GraphForWords {
  rows: { latex: string; hidden?: boolean }[];
  view: { xmin: number; xmax: number; ymin: number; ymax: number };
}

const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻" };

/** Matching brace group starting at s[i] === "{" → [content, index after]. */
function group(s: string, i: number): [string, number] {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}" && --depth === 0) return [s.slice(i + 1, j), j + 1];
  }
  return [s.slice(i + 1), s.length];
}

/** A plain, readable form: \frac{1}{2}x^{2} → (1)/(2)x², \sqrt{x} → √(x). */
export function latexToText(latex: string): string {
  let s = latex
    .replace(/\\left|\\right|\\mleft|\\mright/g, "")
    .replace(/\\operatorname\{\\mathrm\{([^}]*)\}\}/g, "$1")
    .replace(/\\(operatorname|mathrm|text)\{([^}]*)\}/g, "$2")
    .replace(/\\lbrace|\\\{/g, "{")
    .replace(/\\rbrace|\\\}/g, "}")
    .replace(/\\cdot|\\times/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\le(q)?/g, "≤")
    .replace(/\\ge(q)?/g, "≥")
    .replace(/\\pi/g, "π")
    .replace(/\\theta/g, "θ")
    .replace(/\\infty/g, "∞")
    .replace(/\\circ/g, "°")
    .replace(/\\,|\\;|\\ /g, " ")
    .replace(/\\(sin|cos|tan|sec|csc|cot|arcsin|arccos|arctan|sinh|cosh|tanh|ln|log|exp|min|max)/g, "$1 ");
  // \frac and \sqrt with their groups.
  for (let guard = 0; guard < 50; guard++) {
    const f = s.indexOf("\\frac{");
    if (f < 0) break;
    const [num, a] = group(s, f + 5);
    const [den, b] = s[a] === "{" ? group(s, a) : [s[a] ?? "", a + 1];
    s = `${s.slice(0, f)}(${num})/(${den})${s.slice(b)}`;
  }
  for (let guard = 0; guard < 50; guard++) {
    const r = s.indexOf("\\sqrt");
    if (r < 0) break;
    let i = r + 5;
    let index = "";
    if (s[i] === "[") {
      const close = s.indexOf("]", i);
      index = s.slice(i + 1, close);
      i = close + 1;
    }
    const [arg, end] = s[i] === "{" ? group(s, i) : [s[i] ?? "", i + 1];
    s = `${s.slice(0, r)}${index ? `${index}√` : "√"}(${arg})${s.slice(end)}`;
  }
  // Exponents: superscript digits when they are simple, ^(…) otherwise.
  s = s.replace(/\^\{([^{}]*)\}|\^(\d+|[a-zA-Z])/g, (_m, g1: string | undefined, g2: string | undefined) => {
    const e = g1 ?? g2 ?? "";
    return /^-?\d+$/.test(e) ? [...e].map((c) => SUP[c] ?? c).join("") : `^(${e})`;
  });
  s = s.replace(/_\{([^{}]*)\}/g, "_$1").replace(/[{}]/g, "").replace(/\\/g, "");
  s = s.replace(/\s+/g, " ");
  // A minus after a value is subtraction (spaced); any other is a sign.
  s = s.replace(/([0-9A-Za-z)²³¹⁰⁴⁵⁶⁷⁸⁹πθ])\s*-\s*/g, "$1 − ").replace(/-/g, "−");
  return s.replace(/\s*([=<>≤≥+×÷])\s*/g, " $1 ").replace(/\s+/g, " ").trim();
}

function num(x: number): string {
  const r = Math.round(x * 100) / 100;
  return (r < 0 ? "−" : "") + String(Math.abs(r));
}

/** A first draft of the alt text, for the teacher to edit. */
export function describeGraph(g: GraphForWords): string {
  const shown = g.rows.filter((r) => !r.hidden && r.latex.trim() !== "").map((r) => latexToText(r.latex));
  const what =
    shown.length === 0
      ? "An empty coordinate grid"
      : shown.length === 1
        ? `A graph of ${shown[0]}`
        : `A graph of ${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
  const { xmin, xmax, ymin, ymax } = g.view;
  return `${what}, with x from ${num(xmin)} to ${num(xmax)} and y from ${num(ymin)} to ${num(ymax)}.`;
}
