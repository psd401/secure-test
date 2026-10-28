// Editor redesign Phase 7 slice A (R-8, docs/editor-redesign-design.md):
// every question the PDF import proposes is put in one of four piles, so the
// teacher can take the clean ones in one click and look hard at the rest.
//
//   ready         nothing to do but accept it
//   needs_key     the document's answer key did not come through
//   check         something the importer did or guessed needs a look; the
//                 field it touched is named so the card can highlight it
//   cant_convert  the AI's proposal failed the item schema; the teacher
//                 chooses a type for its text or leaves it out
//
// "Nothing silently downgraded": every change the importer made on its own
// (rewritten text, a type it switched, a stimulus paired by position, a
// figure it could not extract, a source that came back shorter than the
// page) lands in `check`, and a rejected proposal is listed rather than
// dropped. The model returns no confidence scores; these signals are the
// pipeline's own. Pure — the panel renders what this decides.

import type { ItemType } from "@/db/schema";
import { itemTypeName } from "@/lib/items/typeLabel";
import type { CandidateChange } from "./extractCore";

export type TriageStatus = "ready" | "needs_key" | "check" | "cant_convert";

/** The part of a card a `check` reason is about. */
export type TriageField = "type" | "stem" | "choices" | "columns" | "stimulus";

export interface TriageReason {
  code:
    | "changed"
    | "converted"
    | "paired_by_position"
    | "figure_missing"
    | "source_shortened"
    | "type_chosen";
  field: TriageField;
  /** Teacher-facing, one line. */
  text: string;
  /** For `choices`: which choice ids to highlight. */
  choiceIds?: string[];
}

export interface Triage {
  status: TriageStatus;
  /** Also true on a `check` card that has no key, so it shows both. */
  needsKey: boolean;
  reasons: TriageReason[];
}

export interface TriageCandidate {
  type: string;
  stem: string;
  choices?: { id: string; text: string }[];
  columns?: { id: string; label: string }[];
}

export interface TriageInput {
  candidate: TriageCandidate;
  /** candidateNeedsKey(c) — the card's own "Needs answer key" rule. */
  needsKey: boolean;
  /** What the model said it changed from the printed text. */
  changes?: readonly CandidateChange[];
  /** The type the AI proposed when the importer's own rules turned it into
   * another (an essay holding a pipe table became a table; a short answer
   * with a blank inside the sentence became fill in the blank). */
  convertedFrom?: string | null;
  /** The proposed stimulus set this question is in, if any. */
  set?: {
    source: "model" | "adjacency";
    needs_figure?: boolean;
    sources?: readonly { shortened?: boolean }[];
  } | null;
  /** The proposal could not be converted and the teacher chose this type. */
  typeChosen?: boolean;
  /** 2026-10-28: fields the teacher edited on the card (`editedFields` in
   * cardEdit.ts). A reason on one of them is answered and dropped; reasons on
   * other fields stay. `candidate` stays the import's own proposal, so a
   * change is still placed against the text the model returned. */
  reviewed?: ReadonlySet<TriageField>;
}


/** Which field a model change is about: the one now holding the changed
 * text. Removed text (changed_to "") cannot be found, so it is the stem's. */
export function changeField(
  c: TriageCandidate,
  change: CandidateChange,
): { field: TriageField; choiceIds?: string[] } {
  const to = change.changed_to.trim();
  if (to.length === 0 || c.stem.includes(to)) return { field: "stem" };
  const ids = (c.choices ?? []).filter((ch) => ch.text.includes(to)).map((ch) => ch.id);
  if (ids.length > 0) return { field: "choices", choiceIds: ids };
  const labels = new Set((c.columns ?? []).map((col) => col.label));
  // fillBlankTableHeadings reports "Column 1, Column 3".
  if (to.split(/,\s*/).some((part) => labels.has(part))) return { field: "columns" };
  return { field: "stem" };
}

export function triageCandidate(input: TriageInput): Triage {
  const { candidate, needsKey } = input;
  const reasons: TriageReason[] = [];
  if (input.typeChosen) {
    reasons.push({
      code: "type_chosen",
      field: "stem",
      text: `The import could not read this one; you chose ${itemTypeName(candidate.type)}. Check the text against the PDF.`,
    });
  }
  if (input.convertedFrom && input.convertedFrom !== candidate.type) {
    reasons.push({
      code: "converted",
      field: "type",
      text: `The AI proposed ${itemTypeName(input.convertedFrom)}; the import made it ${itemTypeName(candidate.type)}.`,
    });
  }
  for (const change of input.changes ?? []) {
    const at = changeField(candidate, change);
    reasons.push({
      code: "changed",
      field: at.field,
      text:
        (change.changed_to
          ? `Changed from the PDF: “${change.original}” → “${change.changed_to}”`
          : `Removed from the PDF: “${change.original}”`) + (change.reason ? ` (${change.reason})` : ""),
      ...(at.choiceIds ? { choiceIds: at.choiceIds } : {}),
    });
  }
  const set = input.set;
  if (set) {
    if (set.source === "adjacency") {
      reasons.push({
        code: "paired_by_position",
        field: "stimulus",
        text: "Its stimulus was paired by position on the page, not read from the text.",
      });
    }
    if (set.needs_figure) {
      reasons.push({
        code: "figure_missing",
        field: "stimulus",
        text: "It depends on a figure the import could not extract.",
      });
    }
    if ((set.sources ?? []).some((s) => s.shortened)) {
      reasons.push({
        code: "source_shortened",
        field: "stimulus",
        text: "A source in its stimulus looks shorter than the document.",
      });
    }
  }
  const open = input.reviewed ? reasons.filter((r) => !input.reviewed!.has(r.field)) : reasons;
  const status: TriageStatus = open.length > 0 ? "check" : needsKey ? "needs_key" : "ready";
  return { status, needsKey, reasons: open };
}

export const TRIAGE_LABEL: Record<TriageStatus, string> = {
  ready: "Ready",
  needs_key: "Needs a key",
  check: "Check this",
  cant_convert: "Can't convert",
};

export const TRIAGE_ORDER: readonly TriageStatus[] = ["ready", "needs_key", "check", "cant_convert"];

export function triageCounts(statuses: readonly TriageStatus[]): Record<TriageStatus, number> {
  const out: Record<TriageStatus, number> = { ready: 0, needs_key: 0, check: 0, cant_convert: 0 };
  for (const s of statuses) out[s] += 1;
  return out;
}

/**
 * The questions "Accept all ready" must skip under an E9 form choice.
 * "first" hides forms 2..n, so they are skipped; "split" also hides them
 * from the review but sends them to drafts of their own, so only the
 * questions already added are skipped. Review fix (2026-10-26): passing the
 * hidden forms under "split" left every sibling draft out.
 */
export function acceptSkip(
  formChoice: "all" | "first" | "split",
  hidden: ReadonlySet<number>,
  added: ReadonlySet<number>,
): Set<number> {
  return new Set(formChoice === "split" ? added : [...hidden, ...added]);
}

/**
 * What "Accept all ready" takes, in document order: every ready question
 * not yet accepted and not skipped (hidden by the form choice). A question in
 * a proposed stimulus set goes only with its whole set, so a set is taken
 * only when every one of its questions is ready — otherwise none of it is.
 */
export function readyToAccept(
  statuses: readonly TriageStatus[],
  sets: readonly { item_indexes: readonly number[] }[],
  skip: ReadonlySet<number> = new Set(),
): number[] {
  const out: number[] = [];
  statuses.forEach((s, i) => {
    if (s !== "ready" || skip.has(i)) return;
    const set = sets.find((x) => x.item_indexes.includes(i));
    if (set && !set.item_indexes.every((j) => statuses[j] === "ready" && !skip.has(j))) return;
    out.push(i);
  });
  return out;
}

// ---- can't convert -----------------------------------------------------

/** A proposal the item schema refused, as the route returns it. */
export interface UnconvertedProposal {
  /** Index in the route's `rejected` list's own numbering (raw order). */
  index: number;
  /** The type the AI proposed, when it named one. */
  type: string | null;
  stem: string;
  /** Choice texts, in order, when it had any. */
  choices: string[];
  errors: string[];
}

/** The types the teacher may turn a refused proposal into: the shapes its
 * text can fill without inventing content. Nothing, when it has no text. */
export function unconvertedTargets(p: UnconvertedProposal): ItemType[] {
  if (p.stem.trim().length === 0) return [];
  const usable = p.choices.filter((c) => c.trim().length > 0);
  return [
    ...(usable.length >= 2 ? (["multiple_choice_single", "multiple_choice_multi"] as const) : []),
    "short_text",
    "essay",
    "drawing_upload",
  ];
}

/** The refused proposal as a candidate of the chosen type, with no answer
 * key (nothing in a refused proposal is trusted as a key). The item POST
 * still validates it when the teacher accepts it. */
export function convertUnconverted(p: UnconvertedProposal, type: ItemType): TriageCandidate & Record<string, unknown> {
  const stem = p.stem.trim();
  if (type === "multiple_choice_single" || type === "multiple_choice_multi") {
    const choices = p.choices
      .filter((c) => c.trim().length > 0)
      .map((text, i) => ({ id: String.fromCharCode(97 + i), text: text.trim() }));
    return { type, stem, choices, correct_choice_ids: [] };
  }
  if (type === "short_text") return { type, stem, correct_answer: "" };
  return { type, stem };
}
