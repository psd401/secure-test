import type { Rubric } from "@secure-test/schema";
import { describeLevel } from "@/lib/ai/essayScorer/scoreCore";

// Slice 4 of docs/rubric-upload-design.md (D-5 / D-6): one reading of a
// score row's `rationale` jsonb, shared by the per-student results page and
// — slice 5 — the family-facing print page, so the teacher approves exactly
// what the family will read.
//
// Pure: it takes the item's rubric and the stored rationale and returns
// rows. Level ids are resolved through `describeLevel`, which knows the
// derived below/meets/exceeds ladder, so a single-point selection reads
// "Meets target" rather than a raw id.

export interface RubricScoreRow {
  criterion_id: string;
  /** The rubric's criterion name; falls back to the id if the rubric moved on. */
  criterion_name: string;
  /** The chosen level's label; falls back to the raw level id if unresolvable. */
  level_label: string;
  points: number;
  rationale: string | null;
}

interface StoredCriterionScore {
  criterion_id?: unknown;
  level_id?: unknown;
  points?: unknown;
  rationale?: unknown;
}

/** The per-criterion rows of a stored score, or [] when there are none. */
export function rubricScoreRows(
  rubric: Rubric | null | undefined,
  rationale: unknown,
): RubricScoreRow[] {
  if (!rationale || typeof rationale !== "object") return [];
  const raw = (rationale as { criterion_scores?: unknown }).criterion_scores;
  if (!Array.isArray(raw)) return [];
  const names = new Map(
    (rubric?.criteria ?? []).map((c) => [c.id, c.name] as const),
  );
  const rows: RubricScoreRow[] = [];
  for (const entry of raw as StoredCriterionScore[]) {
    if (!entry || typeof entry !== "object") continue;
    const criterion_id =
      typeof entry.criterion_id === "string" ? entry.criterion_id : "";
    const level_id = typeof entry.level_id === "string" ? entry.level_id : "";
    if (!criterion_id) continue;
    const described = rubric
      ? describeLevel(rubric, criterion_id, level_id)
      : null;
    const text = typeof entry.rationale === "string" ? entry.rationale.trim() : "";
    rows.push({
      criterion_id,
      criterion_name: names.get(criterion_id) ?? criterion_id,
      level_label: described?.label ?? level_id,
      points:
        typeof entry.points === "number"
          ? entry.points
          : (described?.points ?? 0),
      rationale: text === "" ? null : text,
    });
  }
  return rows;
}

/** The score's overall rationale, trimmed, or null when there isn't one. */
export function overallRationale(rationale: unknown): string | null {
  if (!rationale || typeof rationale !== "object") return null;
  const overall = (rationale as { overall_rationale?: unknown }).overall_rationale;
  return typeof overall === "string" && overall.trim() ? overall : null;
}
