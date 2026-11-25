import type { Rubric } from "@secure-test/schema";
import {
  overallRationale,
  rubricScaleLine,
  rubricScoreRows,
  type RubricScoreRow,
} from "@/lib/reporting/rubricScoreView";

// Slice 5 of docs/rubric-upload-design.md (D-6): what the family-facing
// print page shows for one essay item's score. Proposed scores are not
// decisions yet and never reach this helper's caller — `finalRationale` is
// the FINAL score's `rationale` jsonb, or undefined/null when there is no
// final score. The teacher's opt-in (`student_visibility.with_feedback`)
// gates the whole block; without it the page prints the score only, as
// before slice 5.
//
// Pure: rubric + rationale in, the block to print out (or null to print
// nothing beyond the mark). Never touches the response text — the print
// page's rule against a free-text answer is unaffected by this helper.

export interface PrintFeedback {
  rows: RubricScoreRow[];
  overall: string | null;
  /** B1: "Rubric 6 of 8, scaled to 3 of 4 points" on a weighted question, else null. */
  scale: string | null;
}

export function selectPrintFeedback(
  rubric: Rubric | null | undefined,
  finalRationale: unknown,
  /** The final's numbers, for the B1 scale line; omitted = no line. */
  finalScore?: { points: number; max_points: number } | null,
): PrintFeedback | null {
  if (!rubric || rubric.student_visibility?.with_feedback !== true) return null;
  if (finalRationale === null || finalRationale === undefined) return null;
  const rows = rubricScoreRows(rubric, finalRationale);
  const overall = overallRationale(finalRationale);
  if (rows.length === 0 && overall === null) return null;
  return { rows, overall, scale: rubricScaleLine(rubric, finalScore, finalRationale) };
}
