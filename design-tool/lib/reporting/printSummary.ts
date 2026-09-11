/**
 * R2 print report (docs/reporting-design.md): the numbers on page one.
 *
 * The per-question numbers moved to `lib/reporting/analytics.ts` (P5-3) — the
 * same aggregation `results/analyticsQuery.ts` feeds the results page's
 * footer with. `summarizeCohort` stays here: it is a pure fold over
 * `buildResults` rows (FINAL scores only, exactly like the matrix and the
 * CSV) and analytics does not cover the cohort-level hand-in range / means.
 */

import type { ResultsRow } from "@/lib/scoring/results";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface CohortSummary {
  handed_in: number;
  /** Rows with nothing left to score — the only rows the means are over. */
  complete_count: number;
  /** Rows still carrying unscored items; the "k of N" line. */
  incomplete_count: number;
  /** The assessment-level constant denominator (D-R1); null with no rows. */
  max_points: number | null;
  /** Mean total over complete rows, 2 dp; null when none are complete. */
  mean_total: number | null;
  /** mean_total / max_points as an integer percent; null on the same terms. */
  mean_percent: number | null;
  /** Earliest / latest hand-in ISO strings among the rows; null when none. */
  first_submitted: string | null;
  last_submitted: string | null;
}

export function summarizeCohort(rows: readonly ResultsRow[]): CohortSummary {
  // Submitted-only, explicitly: the print report never passes
  // `include_in_progress`, but an unfinished attempt with nothing answered
  // would otherwise pass an `unscored_count === 0` test and count as complete.
  const complete = rows.filter(
    (r) => r.status === "submitted" && r.unscored_count === 0,
  );
  const maxPoints = rows.length > 0 ? rows[0]!.max_points : null;
  const meanTotal =
    complete.length > 0
      ? complete.reduce((s, r) => s + (r.total_points ?? 0), 0) / complete.length
      : null;
  const submitted = rows
    .map((r) => r.submitted_at)
    .filter((v): v is string => !!v)
    .sort();
  return {
    handed_in: rows.length,
    complete_count: complete.length,
    incomplete_count: rows.length - complete.length,
    max_points: maxPoints,
    mean_total: meanTotal === null ? null : round2(meanTotal),
    mean_percent:
      meanTotal === null || !maxPoints ? null : Math.round((100 * meanTotal) / maxPoints),
    first_submitted: submitted[0] ?? null,
    last_submitted: submitted[submitted.length - 1] ?? null,
  };
}

/** Teacher-facing wording for an item type; unknown types de-underscore. */
const TYPE_LABELS: Record<string, string> = {
  multiple_choice_single: "Multiple choice",
  multiple_choice_multi: "Multiple choice (multi)",
  short_text: "Short text",
  essay: "Essay",
  match: "Match",
  order: "Order",
  hotspot: "Hotspot",
  drawing_upload: "Drawing",
  table: "Table",
};

export function itemTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}
