// Gradebook push (docs/gradebook-push-design.md): the shapes both targets
// share. Slice 2 builds PowerSchool; slice 3 adds Schoology beside it and
// reuses the summary, the held-back reasons and the plan.

export type { GradebookTarget } from "@/db/schema";

/**
 * Why an attempt was not sent (D-3). Never partial points:
 *   - `unscored`       — a response has no final score yet.
 *   - `not_on_roster`  — the attempt's student has no roster link, so there
 *                        is no student number and no DCID to look up.
 *   - `no_dcid`        — the roster row carries no `dcid` yet (the extract
 *                        backfills overnight).
 */
export const HELD_BACK_REASONS = ["unscored", "not_on_roster", "no_dcid"] as const;
export type HeldBackReason = (typeof HELD_BACK_REASONS)[number];

export interface SendFailure {
  /** The student's number. Fine in the API response; never in a log line. */
  student_number: string;
  reason: string;
}

/** What `POST /api/assessments/[id]/gradebook-send` answers. */
export interface SendSummary {
  target: "powerschool" | "schoology";
  external_assignment_id: string | null;
  /** True when this send created the external assignment. */
  assignment_created: boolean;
  /** First-time writes. */
  sent: number;
  /** Re-writes of a score whose points changed since the last send (D-7). */
  updated: number;
  /** Already in the gradebook with the same points; not written again. */
  skipped_unchanged: number;
  held_back: { count: number; reasons: Record<HeldBackReason, number> };
  failed: SendFailure[];
  /** Plain sentences for the dialog's summary (8.3's passed-back note). */
  notes: string[];
}
