import type { ItemType } from "@/db/schema";

/** The slice of an item the readiness checks need — a subset of the editor's ItemView. */
export interface ReadinessItem {
  type: ItemType;
  stem: string;
  /** E5 slice 1: the stimulus set this question belongs to, if any. */
  item_set_id?: string | null;
  choices: { id: string; text: string }[];
  correct_choice_ids: string[];
  correct_answer: string | null;
  pairs: { left: string; right: string }[] | null;
  sequence: { label: string }[] | null;
  image_asset_id: string | null;
  correct_region_ids: string[] | null;
  /** E3 slice 2: the table grid; keys are optional (a keyless table is hand-scored). */
  columns?: { label: string }[] | null;
  rows?: { label: string }[] | null;
}

export interface ReadinessCheck {
  label: string;
  ok: boolean;
}

function blank(s: string | null | undefined): boolean {
  return !s || s.trim().length === 0;
}

/**
 * Text the editor seeds into a brand-new question so the create call passes
 * the API's min(1) rules (open question 3.4 keeps that seeding). A question
 * still carrying it has not been written yet, and must not reach a student
 * as if it had (A-08).
 */
export const SEED_TEXT = new Set([
  "New question",
  "New essay prompt",
  "New short-text item",
  "New matching item",
  "New ordering item",
  "New hotspot item",
  "New drawing prompt",
  "New table",
  "Column A",
  "Column B",
  "Row 1",
  "Row 2",
  "Choice A",
  "Choice B",
  "answer",
  "Left A",
  "Left B",
  "Right A",
  "Right B",
  "First step",
  "Second step",
]);

function placeholder(s: string | null | undefined): boolean {
  return !!s && SEED_TEXT.has(s.trim());
}

/**
 * An objectively-scored item with no answer key yet. Keyless items can be
 * saved, imported, and even published (2026-09-01): scoring skips them
 * until the key is filled, which is allowed after publish too.
 */
export function needsAnswerKey(item: {
  type: string;
  correct_choice_ids?: string[] | null;
  correct_answer?: string | null;
}): boolean {
  switch (item.type) {
    case "multiple_choice_single":
    case "multiple_choice_multi":
      return (item.correct_choice_ids ?? []).length === 0;
    case "short_text":
      return blank(item.correct_answer);
    default:
      return false;
  }
}

/**
 * Why one question is not ready, in the teacher's words; empty when it is.
 * Mirrors what the delivery bundler refuses (a match item needs two pairs,
 * etc.) without duplicating its schema — these are the gaps a teacher can
 * see and fix in the editor.
 */
export function questionGaps(item: ReadinessItem): string[] {
  const gaps: string[] = [];
  if (blank(item.stem)) gaps.push("needs question text");
  else if (placeholder(item.stem)) gaps.push("still has the placeholder text");
  switch (item.type) {
    case "multiple_choice_single":
    case "multiple_choice_multi":
      if (item.choices.length < 2) gaps.push("needs at least 2 choices");
      if (item.choices.some((c) => blank(c.text))) gaps.push("has an empty choice");
      else if (item.choices.some((c) => placeholder(c.text))) gaps.push("still has placeholder choices");
      if (item.correct_choice_ids.length === 0) gaps.push("needs a correct answer");
      break;
    case "short_text":
      if (blank(item.correct_answer)) gaps.push("needs a correct answer");
      else if (placeholder(item.correct_answer)) gaps.push("still has the placeholder answer");
      break;
    case "match":
      if (!item.pairs || item.pairs.length < 2) gaps.push("needs at least 2 pairs");
      else if (item.pairs.some((p) => blank(p.left) || blank(p.right))) gaps.push("has an empty pair");
      else if (item.pairs.some((p) => placeholder(p.left) || placeholder(p.right))) gaps.push("still has placeholder pairs");
      break;
    case "order":
      if (!item.sequence || item.sequence.length < 2) gaps.push("needs at least 2 steps");
      else if (item.sequence.some((s) => blank(s.label))) gaps.push("has an empty step");
      else if (item.sequence.some((s) => placeholder(s.label))) gaps.push("still has placeholder steps");
      break;
    case "hotspot":
      if (!item.image_asset_id) gaps.push("needs an image");
      if (!item.correct_region_ids || item.correct_region_ids.length === 0) gaps.push("needs a correct region");
      break;
    case "table": {
      // E3: the grid must exist and read as something; keys are optional
      // (no keys = hand-scored, a legitimate choice for a calculation table).
      const columns = item.columns ?? [];
      const rows = item.rows ?? [];
      if (columns.length === 0 || rows.length === 0) gaps.push("needs at least one column and one row");
      else if (columns.some((c) => blank(c.label))) gaps.push("has an empty column heading");
      else if (columns.some((c) => placeholder(c.label)) || rows.some((r) => placeholder(r.label)))
        gaps.push("still has placeholder headings");
      break;
    }
    case "essay":
    case "drawing_upload":
      break;
  }
  return gaps;
}

/** E5 slice 1: what the readiness checks need of a stimulus set. */
export interface ReadinessSet {
  id: string;
  stimulus_text: string;
  /** E12: a source-backed stimulus is each student's own answer; the
   * lead-in may be empty, and a draft source is worth a warning. */
  source?: { assessment_name: string; assessment_status: string } | null;
}

/**
 * E5 slice 1: a set whose stimulus is still empty, named by the question it
 * opens ("Stimulus for question 3 is empty"). An empty set cannot exist (it is
 * deleted with its last question), so this is the only stimulus gap.
 */
export function stimulusGaps(items: ReadinessItem[], sets: ReadinessSet[]): string[] {
  const gaps: string[] = [];
  for (const set of sets) {
    const first = items.findIndex((it) => it.item_set_id === set.id);
    if (first < 0) continue;
    if (set.source) {
      // E12 (decision D-2): a draft source warns, never blocks.
      if (set.source.assessment_status !== "published") {
        gaps.push(`Stimulus for question ${first + 1} pulls from "${set.source.assessment_name}", which is not published`);
      }
      continue;
    }
    if (!blank(set.stimulus_text)) continue;
    gaps.push(`Stimulus for question ${first + 1} is empty`);
  }
  return gaps;
}

/** The publish checklist, one line per concern, in the order a teacher reads it. */
export function readinessChecks(items: ReadinessItem[], sets: ReadinessSet[] = []): ReadinessCheck[] {
  const incomplete = items
    .map((it, i) => ({ n: i + 1, gaps: questionGaps(it) }))
    .filter((x) => x.gaps.length > 0);
  const checks: ReadinessCheck[] = [
    {
      label: items.length === 0 ? "No questions yet" : `${items.length} question${items.length === 1 ? "" : "s"}`,
      ok: items.length > 0,
    },
  ];
  if (incomplete.length === 0) {
    checks.push({ label: "Every question has its text and answer", ok: items.length > 0 });
  } else {
    for (const x of incomplete.slice(0, 5)) {
      checks.push({ label: `Question ${x.n} ${x.gaps.join(", ")}`, ok: false });
    }
    if (incomplete.length > 5) {
      checks.push({ label: `…and ${incomplete.length - 5} more`, ok: false });
    }
  }
  for (const label of stimulusGaps(items, sets)) checks.push({ label, ok: false });
  return checks;
}
