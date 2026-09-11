import type { Rubric } from "@secure-test/schema";
import {
  overallRationale,
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
}

export function selectPrintFeedback(
  rubric: Rubric | null | undefined,
  finalRationale: unknown,
): PrintFeedback | null {
  if (!rubric || rubric.student_visibility?.with_feedback !== true) return null;
  if (finalRationale === null || finalRationale === undefined) return null;
  const rows = rubricScoreRows(rubric, finalRationale);
  const overall = overallRationale(finalRationale);
  if (rows.length === 0 && overall === null) return null;
  return { rows, overall };
}
