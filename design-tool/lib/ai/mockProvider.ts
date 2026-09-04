import type {
  GenerateItemRequest,
  GenerateItemResult,
  ItemGeneratorProvider,
} from "./types";

// Deterministic-ish provider that produces a valid, vaguely-sensible item
// derived from the prompt. Used as the default until a real model is
// wired in (see ADR 0007). Exists so:
//   - the editor UI flow can be exercised end-to-end without an API key
//   - tests can assert the route + UI contract without network calls
//   - swapping in a real provider becomes a one-file change

function pickStem(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    return "AI-drafted question";
  }
  // Echo the prompt as the stem so reviewing teachers can immediately see
  // what they asked for. Capped so the stem stays readable.
  const cap = 240;
  return trimmed.length > cap ? trimmed.slice(0, cap - 1) + "…" : trimmed;
}

export const mockProvider: ItemGeneratorProvider = {
  id: "mock",

  async generateItem(req: GenerateItemRequest): Promise<GenerateItemResult> {
    const stem = pickStem(req.prompt);

    if (req.item_type === "short_text") {
      return {
        type: "short_text",
        stem,
        choices: [],
        correct_choice_ids: [],
        // Best-effort: pull a short word from the prompt as a placeholder.
        correct_answer:
          req.prompt
            .split(/\s+/)
            .find((w) => /^[A-Za-z][A-Za-z'-]{1,30}$/.test(w))
            ?.replace(/[^A-Za-z'-]/g, "") ?? "answer",
      };
    }

    const choices = [
      { id: "a", text: "Option A — drafted by AI; review before saving." },
      { id: "b", text: "Option B — drafted by AI; review before saving." },
      { id: "c", text: "Option C — drafted by AI; review before saving." },
      { id: "d", text: "Option D — drafted by AI; review before saving." },
    ];

    if (req.item_type === "multiple_choice_single") {
      return {
        type: "multiple_choice_single",
        stem,
        choices,
        correct_choice_ids: ["a"],
        correct_answer: null,
      };
    }

    return {
      type: "multiple_choice_multi",
      stem,
      choices,
      correct_choice_ids: ["a", "b"],
      correct_answer: null,
    };
  },
};
