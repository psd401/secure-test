import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  attempts,
  items,
  responses,
  roster_sections,
  roster_students,
  scores,
  students,
  test_sessions,
  type ItemRow,
} from "@/db/schema";
import { rubricMaxPoints } from "@/lib/ai/essayScorer/scoreCore";
import { studentsInTeachersSections } from "@/lib/roster/queries";
import { sectionLabel } from "@/lib/roster/teacherRoster";
import { tableMaxPoints } from "@/lib/scoring/auto";

// Slice 40: the teacher results matrix — submitted attempts × items, with
// FINAL scores only. Proposed AI scores are deliberately excluded from
// every total: a number isn't a result until a human (or the hybrid
// confidence gate) settled it; pending proposals surface as status so the
// teacher knows the cell isn't done. Totals are honest sums over scored
// cells — no assumed per-item max for unscored work.
//
// R0.3 (docs/reporting-design.md): identity now joins the per-teacher
// overlay to the roster mirror for a student number and email, and resolves
// a section label per attempt. `max` (D-R1) is a separate, ASSESSMENT-LEVEL
// constant — the sum of every item's constant maximum (rubric max for a
// rubric essay, keyed-cell count for a table, else 1) — independent of what
// has been scored so far; it is the same denominator the manual-score route
// pins per item (`app/api/responses/[responseId]/score/route.ts`). `percent`
// (D-R2) stays blank until every cell is scored.

export type CellStatus = "final" | "proposed_pending" | "unscored" | "no_response";

export interface ResultsCell {
  status: CellStatus;
  points: number | null;
  max_points: number | null;
}

export interface ResultsRow {
  attempt_id: string;
  // Time limit / unfinished attempts
  // (docs/time-limit-and-unfinished-attempts-design.md, D-1/B): every row
  // says which it is. Only `include_in_progress` callers ever see
  // "in_progress" — the CSV, the print report and the review queue stay
  // submitted-only, because an unfinished attempt is not a result.
  status: "submitted" | "in_progress";
  // Slice 78: ssid is nullable until the warehouse carries it. R0.3 adds the
  // roster-joined student number / email, and a resolved section label —
  // all null when the overlay row has no roster binding, no roster match, or
  // (for section) neither the sitting nor a current enrollment names one.
  student: {
    ssid: string | null;
    name: string;
    student_number: string | null;
    email: string | null;
    section: string | null;
  };
  submitted_at: string | null;
  // Null when the student handed in themselves (every row before the column
  // existed, and the overwhelming majority since); a staff sub when a teacher
  // forced the submission through the hand-in route.
  submitted_by_sub: string | null;
  // How many of this assessment's questions carry a saved answer. Meaningful
  // on every row, but it is the in-progress rows that need it: "Not handed in
  // — k of N answered" is the only honest thing to show where a score goes.
  answered_count: number;
  // Slice 3 (teacher UI): true only for an in-progress row whose sitting is
  // OPEN — the same "the student may be locked in and mid-answer" signal
  // `sittingIsOpen` (lib/api/staffAttempt.ts) guards Hand-in and Delete with
  // server-side. False for every submitted row and for an in-progress row
  // with no sitting or a closed one. The UI mirrors the guard rather than the
  // route's deadline relaxation (D-4) — simplest, and a teacher who hits the
  // 409 anyway sees the same "close the session" text inline.
  sitting_open: boolean;
  cells: ResultsCell[]; // aligned with items order
  // Null on an in-progress row: nothing has been scored, and printing a 0
  // where a total belongs reads as a mark of zero.
  total_points: number | null;
  scored_max_points: number | null;
  unscored_count: number;
  // D-R1: the assessment-level constant denominator (same value on every
  // row — carried per row so the CSV and JSON need no second lookup).
  max_points: number;
  // D-R2: null (blank in CSV) until unscored_count is 0, or when max_points
  // is 0 (nothing to divide by).
  percent: number | null;
}

export interface AssessmentResults {
  assessment_id: string;
  items: Array<{ id: string; position: number; type: string; stem: string }>;
  rows: ResultsRow[];
}

/** D-R1: an item's constant maximum — the same rule the manual-score route
 * pins (`app/api/responses/[responseId]/score/route.ts`): the rubric max
 * when the item has a rubric, the keyed-cell count for a table, else 1.
 * Exported for R1: the item-analytics footer and the per-student page divide
 * by the same constant this file sums into `max_points`. */
export function itemMaxPoints(item: Pick<ItemRow, "type" | "config">): number {
  if (item.config.rubric) return rubricMaxPoints(item.config.rubric);
  if (item.type === "table") return tableMaxPoints(item.config);
  return 1;
}

/**
 * @param ownerSub The session sub that has ALREADY been verified to own
 *   `assessmentId`. Required, not optional: it scopes the student lookup so a
 *   roster row can never be read across tenants. See the note on the students
 *   query below for why the caller's check alone is not sufficient.
 * @param options `include_in_progress` adds the attempts that have not been
 *   handed in, as rows with no totals (D-1/B). Default false, so every caller
 *   that predates it — the CSV, the print report, the review queue — keeps
 *   the submitted-only results it has always had.
 * @param ownerEmail The owner's verified session email, used ONLY to resolve
 *   the sections they CURRENTLY teach (`studentsInTeachersSections`) for the
 *   enrollment-fallback section label. Null when the session carries no
 *   email (older sessions) — the fallback simply resolves nothing then.
 */
export async function buildResults(
  assessmentId: string,
  ownerSub: string,
  ownerEmail?: string | null,
  options: { include_in_progress?: boolean } = {},
): Promise<AssessmentResults> {
  const db = getDb();
  const itemRows = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, assessmentId))
    .orderBy(asc(items.position));
  const assessmentMaxPoints = itemRows.reduce((sum, i) => sum + itemMaxPoints(i), 0);

  const attemptRows = await db
    .select()
    .from(attempts)
    .where(eq(attempts.assessment_id, assessmentId))
    .orderBy(asc(attempts.started_at));
  // Named `submitted` throughout because that is what it was and still is by
  // default; with the flag it is "the attempts this caller wants rows for".
  const submitted = attemptRows.filter(
    (a) =>
      a.status === "submitted" ||
      (options.include_in_progress === true && a.status === "in_progress"),
  );

  // Scope the roster lookup to the caller, not just to the attempt's
  // student_id. The caller has already verified it owns the ASSESSMENT, but
  // that says nothing about who owns the STUDENT an attempt points at —
  // `attempts.student_id` is a plain FK with no tenant constraint. Without
  // this predicate, an attempt row referencing another teacher's student would
  // surface that student's name and SSID in results and the CSV export.
  //
  // The student ingest (slice 61) is what writes attempts, resolving the
  // student against the assessment owner's roster first (slice 78), so a
  // cross-owner attempt should not arise; this is the query that would meet
  // one if it did.
  // A student that fails the predicate is simply absent from the map and
  // renders as "(unknown)" below — fails closed, no crash.
  const studentRows =
    submitted.length > 0
      ? await db
          .select()
          .from(students)
          .where(
            and(
              eq(students.owner_sub, ownerSub),
              inArray(
                students.id,
                submitted.map((a) => a.student_id),
              ),
            ),
          )
      : [];
  const studentsById = new Map(studentRows.map((s) => [s.id, s]));

  // R0.3: join the overlay to the roster mirror for a student number/email.
  // Scoped to the SAME owner-verified overlay rows above — a roster_ps_id is
  // only ever trusted when it hangs off a row this owner's `students` query
  // already cleared, so this join cannot widen the tenant boundary above.
  const rosterPsIds = [
    ...new Set(studentRows.map((s) => s.roster_ps_id).filter((v): v is string => !!v)),
  ];
  const rosterStudentRows =
    rosterPsIds.length > 0
      ? await db.select().from(roster_students).where(inArray(roster_students.ps_id, rosterPsIds))
      : [];
  const rosterStudentByPsId = new Map(rosterStudentRows.map((r) => [r.ps_id, r]));

  // Section resolution, fallback (a): the attempt's own sitting, when it
  // named a section. `attempts.test_session_id` is nullable (an attempt made
  // outside a sitting) and a sitting need not name a section at all.
  const testSessionIds = [
    ...new Set(
      submitted.map((a) => a.test_session_id).filter((v): v is string => !!v),
    ),
  ];
  const testSessionRows =
    testSessionIds.length > 0
      ? await db
          .select()
          .from(test_sessions)
          .where(inArray(test_sessions.id, testSessionIds))
      : [];
  const sectionPsIdBySessionId = new Map(
    testSessionRows.map((t) => [t.id, t.section_ps_id]),
  );
  // Slice 3: the same rows carry `status`, which is all `sitting_open` needs.
  const sessionStatusBySessionId = new Map(
    testSessionRows.map((t) => [t.id, t.status]),
  );
  const sittingSectionPsIds = [
    ...new Set(
      testSessionRows.map((t) => t.section_ps_id).filter((v): v is string => !!v),
    ),
  ];
  const rosterSectionRows =
    sittingSectionPsIds.length > 0
      ? await db
          .select()
          .from(roster_sections)
          .where(inArray(roster_sections.ps_id, sittingSectionPsIds))
      : [];
  const rosterSectionByPsId = new Map(rosterSectionRows.map((s) => [s.ps_id, s]));

  // Section resolution, fallback (b): the student's enrollment in one of the
  // OWNER's CURRENTLY taught sections (never another owner's — the query is
  // scoped by `ownerEmail`, the same join `attendanceForSitting` uses).
  // Skipped entirely when the session carries no email.
  const sectionsByStudentPsId = new Map<string, string>();
  if (ownerEmail) {
    for (const { student, section } of await studentsInTeachersSections(db, ownerEmail)) {
      if (!sectionsByStudentPsId.has(student.ps_id)) {
        sectionsByStudentPsId.set(student.ps_id, sectionLabel(section));
      }
    }
  }

  function resolveSection(attempt: (typeof submitted)[number], rosterPsId: string | null): string | null {
    const sittingSectionPsId = attempt.test_session_id
      ? sectionPsIdBySessionId.get(attempt.test_session_id)
      : null;
    if (sittingSectionPsId) {
      const section = rosterSectionByPsId.get(sittingSectionPsId);
      if (section) return sectionLabel(section);
    }
    if (rosterPsId) {
      const label = sectionsByStudentPsId.get(rosterPsId);
      if (label) return label;
    }
    return null;
  }

  const responseRows =
    submitted.length > 0
      ? await db
          .select()
          .from(responses)
          .where(
            inArray(
              responses.attempt_id,
              submitted.map((a) => a.id),
            ),
          )
      : [];
  // (attempt_id, item_id) -> response
  const responseByCell = new Map(
    responseRows.map((r) => [`${r.attempt_id}:${r.item_id}`, r]),
  );

  const scoreRows =
    responseRows.length > 0
      ? await db
          .select()
          .from(scores)
          .where(
            inArray(
              scores.response_id,
              responseRows.map((r) => r.id),
            ),
          )
      : [];
  const finalByResponse = new Map(
    scoreRows.filter((s) => s.status === "final").map((s) => [s.response_id, s]),
  );
  const hasProposed = new Set(
    scoreRows.filter((s) => s.status === "proposed").map((s) => s.response_id),
  );

  const rows: ResultsRow[] = submitted.map((attempt) => {
    const student = studentsById.get(attempt.student_id);
    const inProgress = attempt.status !== "submitted";
    let total = 0;
    let scoredMax = 0;
    let unscored = 0;
    let answered = 0;
    const cells: ResultsCell[] = itemRows.map((item) => {
      const response = responseByCell.get(`${attempt.id}:${item.id}`);
      if (!response) {
        return { status: "no_response", points: null, max_points: null };
      }
      answered++;
      // An unfinished attempt has no scores to show even if a stray one
      // exists: nothing has been through the auto-scoring pass, which runs on
      // hand-in. Every answered cell reads "unscored" until it does.
      if (inProgress) {
        unscored++;
        return { status: "unscored", points: null, max_points: null };
      }
      const final = finalByResponse.get(response.id);
      if (final) {
        total += final.points;
        scoredMax += final.max_points;
        return {
          status: "final",
          points: final.points,
          max_points: final.max_points,
        };
      }
      unscored++;
      return {
        status: hasProposed.has(response.id) ? "proposed_pending" : "unscored",
        points: null,
        max_points: null,
      };
    });
    const rosterPsId = student?.roster_ps_id ?? null;
    const rosterStudent = rosterPsId ? rosterStudentByPsId.get(rosterPsId) : undefined;
    const sittingOpen =
      inProgress &&
      attempt.test_session_id !== null &&
      sessionStatusBySessionId.get(attempt.test_session_id) === "open";
    const percent =
      !inProgress && unscored === 0 && assessmentMaxPoints > 0
        ? Math.round((100 * total) / assessmentMaxPoints)
        : null;
    return {
      attempt_id: attempt.id,
      status: inProgress ? ("in_progress" as const) : ("submitted" as const),
      student: student
        ? {
            ssid: student.ssid,
            name: student.name,
            student_number: rosterStudent?.ps_id ?? null,
            email: rosterStudent?.email ?? null,
            section: resolveSection(attempt, rosterPsId),
          }
        : {
            ssid: "",
            name: "(unknown)",
            student_number: null,
            email: null,
            section: null,
          },
      submitted_at: attempt.submitted_at?.toISOString() ?? null,
      submitted_by_sub: attempt.submitted_by_sub,
      answered_count: answered,
      sitting_open: sittingOpen,
      cells,
      total_points: inProgress ? null : total,
      scored_max_points: inProgress ? null : scoredMax,
      unscored_count: unscored,
      max_points: assessmentMaxPoints,
      percent,
    };
  });

  return {
    assessment_id: assessmentId,
    items: itemRows.map((i) => ({
      id: i.id,
      position: i.position,
      type: i.type,
      stem: i.stem,
    })),
    rows,
  };
}

function csvField(value: string): string {
  // Review fix (2026-08-14): neutralize spreadsheet formula triggers with a
  // leading apostrophe — a student-controlled value like =HYPERLINK(...)
  // must not execute when the teacher opens the export in Excel/Sheets.
  // Score cells are never negative, so the '-' prefix can't hit numbers.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// Generic wide CSV: one row per attempt, Q<n> columns hold FINAL points
// (blank = not final yet or no response). PowerSchool / Schoology formats
// are separate future slices gated on sample exports.
export function resultsToCsv(results: AssessmentResults): string {
  const header = [
    "student_number",
    "name",
    "email",
    "section",
    "submitted_at",
    ...results.items.map((i) => `Q${i.position + 1}`),
    "total",
    "max",
    "percent",
    "unscored",
  ];
  const lines = [header.map(csvField).join(",")];
  for (const row of results.rows) {
    lines.push(
      [
        csvField(row.student.student_number ?? ""),
        csvField(row.student.name),
        csvField(row.student.email ?? ""),
        csvField(row.student.section ?? ""),
        csvField(row.submitted_at ?? ""),
        ...row.cells.map((c) =>
          c.status === "final" && c.points != null ? String(c.points) : "",
        ),
        String(row.total_points ?? ""),
        String(row.max_points),
        row.percent === null ? "" : String(row.percent),
        String(row.unscored_count),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
