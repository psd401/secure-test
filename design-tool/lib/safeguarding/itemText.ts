import type { CreateItemBody } from "@/lib/api/items";

/**
 * Flatten an AI-proposed item into a single string for the output
 * guardrail check — the stem, every choice's text, and the short-text
 * answer. Keeps the guardrail looking at everything a student could see,
 * not just the stem.
 *
 * E20: the static type is a lie here. `parseItemText` in lib/ai/itemGenCore.ts
 * blind-casts `JSON.parse` output to GenerateItemResult, so a model reply of
 * literal `null` — valid JSON — arrives as `item`. Dereferencing `item.stem`
 * then threw a TypeError from inside `runGuarded`, which does NOT wrap
 * `outputText()`, so it escaped to the route's catch-all as a 502
 * `provider_failed` instead of the intended `provider_returned_invalid_item`.
 * That only bites with guardrails enabled, i.e. in production.
 *
 * This function must therefore be total for ANY runtime value: return a benign
 * empty string on an off-contract shape and let CreateItemBody.safeParse —
 * which runs after the guardrail — produce the accurate error.
 */
export function itemProposalText(item: CreateItemBody): string {
  const shape = item as Partial<CreateItemBody> | null | undefined;
  if (!shape || typeof shape !== "object") return "";

  const parts: string[] = [];
  if (typeof shape.stem === "string" && shape.stem) parts.push(shape.stem);
  if (shape.type !== "short_text") {
    const choices = (shape as { choices?: unknown }).choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        const text = (choice as { text?: unknown } | null)?.text;
        if (typeof text === "string" && text) parts.push(text);
      }
    }
  } else {
    const answer = (shape as { correct_answer?: unknown }).correct_answer;
    if (typeof answer === "string" && answer) parts.push(answer);
  }
  // E3: a table's column and row labels are student-visible text too. (No
  // provider proposes tables today; total over the shape regardless.)
  if (shape.type === "table") {
    for (const list of ["columns", "rows"] as const) {
      const entries = (shape as Record<string, unknown>)[list];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const label = (entry as { label?: unknown } | null)?.label;
        if (typeof label === "string" && label) parts.push(label);
      }
    }
  }
  return parts.join("\n");
}
