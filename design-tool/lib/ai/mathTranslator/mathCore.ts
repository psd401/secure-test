// Shared math-translation core for the Anthropic-family providers (direct
// Anthropic API + Amazon Bedrock). Both SDKs expose the same Messages API,
// so the system prompt, request shaping, and LaTeX clean-up live here once
// and each provider supplies only its own client + model id. Generic
// response helpers (extractFirstText / wrapProviderError) come from
// ../sdkResponse. See docs/adr/0011-math-translator.md.
//
// Returns raw LaTeX (no $ / $$ delimiters — the caller wraps based on
// display_mode).
//
// PROMPT CACHING IS NOT ACTIVE HERE — see the longer note in ../itemGenCore.ts.
// The margin is even wider on this surface: Haiku 4.5, our math model, needs a
// 4096-token cacheable prefix, and MATH_SYSTEM_PROMPT is ~1,100 chars (roughly
// 300 tokens) — an order of magnitude short. The `cache_control` breakpoint
// below is therefore inert on the direct Anthropic path, and the Bedrock
// Converse path sends no `cachePoint` block at all. Both are harmless; neither
// saves anything. Don't restore a cost-saving claim without measuring
// `cache_read_input_tokens` on a repeat request.

export const MATH_MAX_TOKENS = 256;

export const MATH_SYSTEM_PROMPT = `You translate plain-English math descriptions into LaTeX. You serve K-12 teachers who don't know LaTeX syntax — they say things like "one half plus one third" and need "\\frac{1}{2}+\\frac{1}{3}" back.

RULES:
- Return ONLY the LaTeX expression. No prose, no explanation, no markdown fences, no surrounding $ or $$ delimiters.
- Use standard LaTeX: \\frac, \\sqrt, ^, _, \\cdot, \\div, \\pm, \\degree, \\percent for common operations.
- K-12-friendly macros are available: \\half, \\third, \\quarter, \\plusminus.
- Prefer \\cdot over \\times for multiplication unless the input clearly means "cross product".
- If the input is already valid LaTeX, pass it through unchanged.
- If the input is ambiguous or you genuinely cannot tell what was meant, return your best guess — the teacher reviews the output before inserting.

EXAMPLES:
"one half plus one third" → \\frac{1}{2}+\\frac{1}{3}
"x squared minus 4" → x^2-4
"square root of 2" → \\sqrt{2}
"2 over (x+1)" → \\frac{2}{x+1}
"3 times 4 equals 12" → 3\\cdot 4=12
"plus or minus the square root of b squared minus 4ac, all over 2a" → \\frac{\\pm\\sqrt{b^2-4ac}}{2a}`;

// The Messages-API `system` block, shared by every Anthropic-family translator.
export function mathSystemBlocks() {
  return [
    {
      type: "text" as const,
      text: MATH_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" as const },
    },
  ];
}

function stripLatexNoise(s: string): string {
  let out = s.trim();
  // Tolerate ```latex fences in case the model slips into markdown.
  const fenced = out.match(/```(?:latex|tex)?\s*([\s\S]*?)\s*```/i);
  if (fenced) out = fenced[1]!.trim();
  // Tolerate outer $...$ or $$...$$ wrapping.
  if (out.startsWith("$$") && out.endsWith("$$")) out = out.slice(2, -2).trim();
  else if (out.startsWith("$") && out.endsWith("$")) out = out.slice(1, -1).trim();
  return out;
}

// Clean the model's raw text into a bare LaTeX expression, rejecting an
// empty result so the editor never inserts nothing.
export function finalizeLatex(rawText: string, errPrefix: string): string {
  const latex = stripLatexNoise(rawText);
  if (!latex) {
    throw new Error(`${errPrefix}_returned_empty_latex`);
  }
  return latex;
}
