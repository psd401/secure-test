// Beta report 2026-10-28 (James): a teacher could not tell they should
// accept an import card that was not quite right and fix it in the editor
// afterwards. The review card now has an Edit toggle for the stem, the
// choices and (multiple choice and short text only — decided 2026-10-28) the
// answer key. Edits stay on the card until Accept, which posts the edited
// question through the normal item route, so CreateItemBody still decides
// what is valid. Match pairs, blank answers and table keys stay in the
// editor. Pure — the panel holds the state and renders.

import { nextChoiceId } from "@/lib/items/choiceIds";
import type { TriageField } from "./triage";

export interface EditableCandidate {
  type: string;
  stem: string;
  choices?: { id: string; text: string }[];
  correct_choice_ids?: string[];
  correct_answer?: string | null;
}

/** Which key control the card offers for this type, if any. */
export function editableKey(type: string): "single" | "multi" | "answer" | null {
  if (type === "multiple_choice_single") return "single";
  if (type === "multiple_choice_multi") return "multi";
  if (type === "short_text") return "answer";
  return null;
}

/** Choices are edited only on the two multiple-choice types. */
export function editsChoices(type: string): boolean {
  const k = editableKey(type);
  return k === "single" || k === "multi";
}

export function setChoiceText<C extends EditableCandidate>(c: C, id: string, text: string): C {
  return { ...c, choices: (c.choices ?? []).map((ch) => (ch.id === id ? { ...ch, text } : ch)) };
}

export function addChoice<C extends EditableCandidate>(c: C): C {
  const choices = c.choices ?? [];
  return { ...c, choices: [...choices, { id: nextChoiceId(choices), text: "" }] };
}

/** A removed choice also leaves the key. */
export function removeChoice<C extends EditableCandidate>(c: C, id: string): C {
  return {
    ...c,
    choices: (c.choices ?? []).filter((ch) => ch.id !== id),
    ...(c.correct_choice_ids ? { correct_choice_ids: c.correct_choice_ids.filter((k) => k !== id) } : {}),
  };
}

/** Single choice: this one is the key. Multi: toggle it, in choice order. */
export function toggleKey<C extends EditableCandidate>(c: C, id: string): C {
  if (editableKey(c.type) === "single") return { ...c, correct_choice_ids: [id] };
  const keyed = new Set(c.correct_choice_ids ?? []);
  if (keyed.has(id)) keyed.delete(id);
  else keyed.add(id);
  return { ...c, correct_choice_ids: (c.choices ?? []).map((ch) => ch.id).filter((k) => keyed.has(k)) };
}

/**
 * The card fields the teacher has changed from what the import proposed. A
 * `check` reason on one of these fields is answered by the edit, so triage
 * drops it (decided 2026-10-28: only that field's reasons, not the card's).
 * A key edit reviews no text, so it clears nothing here — it moves the card
 * out of "needs a key" through `candidateNeedsKey` instead.
 */
export function editedFields(original: EditableCandidate, edited: EditableCandidate): Set<TriageField> {
  const out = new Set<TriageField>();
  if (edited.stem !== original.stem) out.add("stem");
  const a = original.choices ?? [];
  const b = edited.choices ?? [];
  if (a.length !== b.length || a.some((ch, i) => ch.id !== b[i]!.id || ch.text !== b[i]!.text)) out.add("choices");
  return out;
}
