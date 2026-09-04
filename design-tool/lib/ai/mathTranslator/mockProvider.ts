import type {
  MathTranslatorProvider,
  TranslateMathRequest,
  TranslateMathResult,
} from "./types";

// Pattern-based mock translator. Handles the K-12 phrasings we expect
// most often — fractions, exponents, square roots, common operators —
// so the UX is testable without an API key. A real provider (Haiku +
// structured-output, per ADR 0011) replaces this in production.
//
// Anything the pattern matcher doesn't recognize falls through to an
// echo with [TRANSLATE-MOCK] prefix so the teacher sees clearly that
// the mock didn't actually understand the prompt. Better signal than a
// silent wrong answer.

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
};

function wordToNumber(word: string): string | null {
  const key = word.toLowerCase();
  return NUMBER_WORDS[key] ?? null;
}

function tryFraction(prompt: string): string | null {
  // "one half" / "1/2" / "one over two" / "one divided by two"
  const halfThird: Record<string, string> = {
    half: "\\frac{1}{2}",
    third: "\\frac{1}{3}",
    quarter: "\\frac{1}{4}",
    fourth: "\\frac{1}{4}",
    fifth: "\\frac{1}{5}",
    sixth: "\\frac{1}{6}",
  };
  for (const [name, latex] of Object.entries(halfThird)) {
    if (prompt.toLowerCase().includes(`one ${name}`)) return latex;
  }
  const slash = prompt.match(/(\d+)\s*\/\s*(\d+)/);
  if (slash) return `\\frac{${slash[1]}}{${slash[2]}}`;
  const over = prompt.match(/(\d+|\w+)\s+(?:over|divided by)\s+(\d+|\w+)/i);
  if (over) {
    const num = wordToNumber(over[1]!) ?? over[1]!;
    const den = wordToNumber(over[2]!) ?? over[2]!;
    return `\\frac{${num}}{${den}}`;
  }
  return null;
}

function tryPower(prompt: string): string | null {
  // "x squared", "x cubed", "x to the fourth", "x^2"
  const explicit = prompt.match(/([a-zA-Z]|\d+)\s*\^\s*(\d+|\{[^}]+\})/);
  if (explicit) return `${explicit[1]}^{${explicit[2]!.replace(/[{}]/g, "")}}`;
  const squared = prompt.match(/([a-zA-Z])\s+squared/i);
  if (squared) return `${squared[1]}^2`;
  const cubed = prompt.match(/([a-zA-Z])\s+cubed/i);
  if (cubed) return `${cubed[1]}^3`;
  const toThe = prompt.match(/([a-zA-Z])\s+to\s+the\s+(\d+|\w+)/i);
  if (toThe) {
    const exp = wordToNumber(toThe[2]!) ?? toThe[2]!;
    return `${toThe[1]}^${exp}`;
  }
  return null;
}

function trySqrt(prompt: string): string | null {
  // "square root of N" / "sqrt N"
  const sqrt = prompt.match(/(?:square\s+root\s+of|sqrt)\s+(\d+|[a-zA-Z]+)/i);
  if (sqrt) return `\\sqrt{${sqrt[1]}}`;
  return null;
}

function tryOperator(prompt: string): string | null {
  // Replace plain operator words. Conservative — only fires on
  // recognizable patterns like "2 plus 3", "x times y".
  const replaced = prompt
    .replace(/\bplus\b/gi, "+")
    .replace(/\bminus\b/gi, "-")
    .replace(/\btimes\b/gi, "\\cdot ")
    .replace(/\bdivided\s+by\b/gi, "\\div ")
    .replace(/\bequals\b/gi, "=");
  // Only return if we actually changed something AND the result looks
  // like math (has at least one operator or symbol).
  if (replaced !== prompt && /[+\-=\\]/.test(replaced)) return replaced.trim();
  return null;
}

function mockTranslate(prompt: string): string {
  const cleaned = prompt.trim().replace(/\s+/g, " ");
  if (cleaned.length === 0) return "[TRANSLATE-MOCK]";
  return (
    tryFraction(cleaned) ??
    tryPower(cleaned) ??
    trySqrt(cleaned) ??
    tryOperator(cleaned) ??
    `[TRANSLATE-MOCK: ${cleaned}]`
  );
}

export const mockMathTranslator: MathTranslatorProvider = {
  id: "mock",
  async translate(req: TranslateMathRequest): Promise<TranslateMathResult> {
    return { latex: mockTranslate(req.prompt), confidence: 1 };
  },
};
