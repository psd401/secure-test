import type { ItemType } from "@/db/schema";
import type { FillBlankBlank, ScoringMethod } from "@secure-test/schema";
import { isKeyedBlank } from "@secure-test/schema";
import { nextChoiceId } from "@/lib/items/choiceIds";

/**
 * R-6 (docs/editor-redesign-design.md, Phase 4 slice B): change a question's
 * type in place. The stem always stays; options stay where the new type has
 * options (multiple choice ↔ multiple select, multiple choice → ordering and
 * back); and anything that would be lost — above all an answer key — is
 * listed BEFORE the change so the editor can warn (the "type changes that
 * drop data without warning" anti-pattern). Pure; tested in
 * test/authoring-type-change.test.ts.
 *
 * Not offered as targets: matching, table and fill-in-the-blank. Each needs
 * content the teacher writes (pairs, headings, a blank in the sentence)
 * that the item write boundary will not accept empty, so the editor would
 * have to invent text — add a new question of that type instead.
 */

/** The fields this module reads and writes (a subset of the editor's ItemView). */
export interface TypeChangeItem {
  type: ItemType;
  stem: string;
  choices: { id: string; text: string }[];
  correct_choice_ids: string[];
  correct_answer: string | null;
  rubric: unknown | null;
  pairs: unknown[] | null;
  sequence: { id: string; label: string }[] | null;
  image_asset_id: string | null;
  regions: unknown[] | null;
  correct_region_ids: string[] | null;
  prompt_asset_id: string | null;
  columns: unknown[] | null;
  cell_keys: Record<string, Record<string, string>> | null;
  blanks: FillBlankBlank[] | null;
  scoring_method: ScoringMethod | null;
  graph_key?: unknown | null;
}

export const TYPE_CHANGE_NOT_TARGETS: ReadonlySet<ItemType> = new Set<ItemType>(["match", "table", "fill_blank"]);

const MC: ReadonlySet<ItemType> = new Set<ItemType>(["multiple_choice_single", "multiple_choice_multi"]);

export interface TypeTarget {
  type: ItemType;
  /** False with a reason when this item cannot become that type. */
  available: boolean;
  reason?: string;
}

/** The types this question could become, in `order` (the editor's type list). */
export function typeChangeTargets(item: TypeChangeItem, order: readonly ItemType[]): TypeTarget[] {
  return order
    .filter((t) => t !== item.type && !TYPE_CHANGE_NOT_TARGETS.has(t))
    .map((t): TypeTarget => {
      if (t === "order") {
        if (!MC.has(item.type)) return { type: t, available: false, reason: "only a multiple-choice question can become ordering" };
        if (item.choices.length < 2 || item.choices.some((c) => c.text.trim() === "")) {
          return { type: t, available: false, reason: "every choice needs text first" };
        }
      }
      return { type: t, available: true };
    });
}

/** Does this question carry an answer key (or, for an essay, a rubric)? */
export function hasAnswerKey(item: TypeChangeItem): boolean {
  switch (item.type) {
    case "multiple_choice_single":
    case "multiple_choice_multi":
      return item.correct_choice_ids.length > 0;
    case "short_text":
      return (item.correct_answer ?? "").trim() !== "";
    case "order":
      // The sequence is authored in the correct order: it IS the key.
      return (item.sequence ?? []).length > 0;
    case "match":
      return (item.pairs ?? []).length > 0;
    case "hotspot":
      return (item.correct_region_ids ?? []).length > 0;
    case "table":
      return !!item.cell_keys && Object.values(item.cell_keys).some((r) => Object.keys(r).length > 0);
    case "fill_blank":
      return (item.blanks ?? []).some((b) => isKeyedBlank(b));
    case "graph":
      return item.graph_key != null;
    case "essay":
    case "drawing_upload":
      return false;
  }
}

export interface TypeChangeResult<T> {
  item: T;
  /** Teacher-facing phrases for what the change removes; empty = nothing lost. */
  lost: string[];
  /** One of `lost` is the answer key. */
  keyLost: boolean;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The question as `target`. `defaults` is the editor's empty question of the
 * target type (its per-type fields); `scoringAllowed` the methods each type
 * may declare. Everything not type-specific — id, position, stimulus set,
 * standards, the calculator switch, a stimulus graph — is kept as is.
 */
export function changeItemType<T extends TypeChangeItem>(
  item: T,
  target: ItemType,
  defaults: Partial<T>,
  scoringAllowed: (t: ItemType) => readonly ScoringMethod[],
): TypeChangeResult<T> {
  const lost: string[] = [];
  let keyLost = false;
  const next = { ...item, ...defaults, type: target, stem: item.stem } as T;
  // The defaults name every field (standards: [] among them); put back the
  // ones that are not the type's own.
  for (const k of KEPT_ACROSS_TYPES) {
    if (k in item) (next as Record<string, unknown>)[k] = (item as Record<string, unknown>)[k];
  }
  const fromMC = MC.has(item.type);
  const toMC = MC.has(target);
  const keyed = hasAnswerKey(item);

  if (fromMC && toMC) {
    next.choices = item.choices;
    if (target === "multiple_choice_single" && item.correct_choice_ids.length > 1) {
      next.correct_choice_ids = [];
      lost.push(`the ${item.correct_choice_ids.length} correct answers (multiple choice has one)`);
      keyLost = true;
    } else {
      next.correct_choice_ids = item.correct_choice_ids;
    }
  } else if (fromMC && target === "order") {
    // The choices become the steps, in the order they are listed now — that
    // order is the new key.
    next.sequence = item.choices.map((c, i) => ({ id: `s${i + 1}`, label: c.text }));
    if (keyed) {
      lost.push("the correct answer (the steps' current order becomes the correct order)");
      keyLost = true;
    }
  } else if (item.type === "order" && toMC) {
    const steps = item.sequence ?? [];
    if (steps.length >= 2) {
      const choices: { id: string; text: string }[] = [];
      for (const s of steps) choices.push({ id: nextChoiceId(choices), text: s.label });
      next.choices = choices;
    }
    next.correct_choice_ids = [];
    lost.push("the correct order (the steps become choices with no correct answer yet)");
    keyLost = true;
  } else {
    // Nothing maps across: say what goes.
    if (fromMC && item.choices.length > 0) lost.push(plural(item.choices.length, "choice", "choices"));
    if (keyed) {
      keyLost = true;
      lost.push(KEY_PHRASE[item.type]);
    }
    if (item.type === "essay" && item.rubric) lost.push("the scoring rubric");
    if (item.type === "hotspot" && (item.image_asset_id || (item.regions ?? []).length > 0)) {
      lost.push("the picture and its regions");
    }
    if (item.type === "drawing_upload" && item.prompt_asset_id) lost.push("the drawing's picture");
    if (item.type === "table" && (item.columns ?? []).length > 0) lost.push("the table");
    if (item.type === "fill_blank" && (item.blanks ?? []).length > 0) lost.push("the blanks");
    if (item.type === "graph") lost.push("the graph's grid");
  }

  if (item.scoring_method && !scoringAllowed(target).includes(item.scoring_method)) {
    next.scoring_method = null;
    lost.push("the scoring method you picked (it goes back to the default)");
  } else {
    next.scoring_method = item.scoring_method;
  }
  return { item: next, lost, keyLost };
}

/** Not type-specific: a type change never touches these. */
const KEPT_ACROSS_TYPES = ["id", "position", "item_set_id", "standards", "no_calculator", "graph"] as const;

const KEY_PHRASE: Record<ItemType, string> = {
  multiple_choice_single: "the correct answer",
  multiple_choice_multi: "the correct answers",
  short_text: "the correct answer",
  essay: "the answer key",
  match: "the pairs (the matching key)",
  order: "the steps (the correct order)",
  hotspot: "the correct regions",
  drawing_upload: "the answer key",
  table: "the cell answers",
  fill_blank: "the blanks' answers",
  graph: "the graph's answer",
};
