// UNCONFIRMED — the PowerTeacher Pro score write, as IT documented it on
// 2026-09-22 (docs/gradebook-push-design.md, "What IT established"). The
// plugin has no GET for scores, so slice 2a could not read a real score row;
// slice 2c's first live write is what confirms or corrects this file. It is
// kept apart from everything confirmed so that correction touches nothing
// else:
//
//   PUT /ws/xte/score?users_dcid=…&status=A&term_id=…
//   { "assignment_scores": [ {
//       "_assignmentsection": { "assignmentsectionid": … },
//       "studentsdcid": …,
//       "actualscoreentered": "<points>",
//       "actualscorekind": "REAL_SCORE",
//       "scoretype": "POINTS",
//       "scorepoints": <points>,
//       "assignmentscoreid": …            // only on an update
//   } ] }
import { psId } from "./powerschoolPayloads";

export interface ScoreWriteRow {
  studentDcid: string;
  points: number;
  /** The `assignmentscoreid` a previous write returned; present = update. */
  externalScoreId: string | null;
}

export function buildScoreWriteBodyUnconfirmed(
  assignmentSectionId: string,
  rows: readonly ScoreWriteRow[],
): Record<string, unknown> {
  return {
    assignment_scores: rows.map((row) => {
      const score: Record<string, unknown> = {
        _assignmentsection: { assignmentsectionid: psId(assignmentSectionId) },
        studentsdcid: psId(row.studentDcid),
        actualscoreentered: String(row.points),
        actualscorekind: "REAL_SCORE",
        scoretype: "POINTS",
        scorepoints: row.points,
      };
      if (row.externalScoreId) score.assignmentscoreid = psId(row.externalScoreId);
      return score;
    }),
  };
}

export interface ScoreWriteOutcome {
  /** Keyed by the student DCID as we sent it. */
  byStudentDcid: Map<string, { assignmentscoreid: string | null; error: string | null }>;
}

function idString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

/**
 * Reads a 2xx score-write response for per-student ids and errors. The shape
 * is a guess until 2c: `assignment_scores[]` (or a bare array) whose rows
 * carry `studentsdcid`, `assignmentscoreid`, and possibly an `error` /
 * `_errors` field. A response that names no student is read as "every row
 * written, no ids returned" — the caller then keeps any id it already had.
 */
export function parseScoreWriteResponseUnconfirmed(body: unknown): ScoreWriteOutcome {
  const byStudentDcid: ScoreWriteOutcome["byStudentDcid"] = new Map();
  const list = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).assignment_scores)
      ? ((body as Record<string, unknown>).assignment_scores as unknown[])
      : [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const dcid = idString(row.studentsdcid);
    if (!dcid) continue;
    const errorField = row.error ?? row._errors ?? null;
    const error =
      errorField === null || errorField === undefined || errorField === ""
        ? null
        : typeof errorField === "string"
          ? errorField
          : JSON.stringify(errorField);
    byStudentDcid.set(dcid, { assignmentscoreid: idString(row.assignmentscoreid), error });
  }
  return { byStudentDcid };
}
