// Slice 83: the sittings a signed-in student may join right now.
//
// The student side of pre-assignment (docs/phase-7-slices.md). A teacher opens
// a sitting scoped to a section or a list; the student sees it here and joins
// with `POST /api/attempts { test_session_id }` — no code typed. Admission is
// the same `isAdmittedToSitting` the redeem route applies, evaluated against
// every open, unexpired sitting, so this list can never show a sitting the
// student could not have joined by code, and never hides one they could.
//
// Listing does NOT bind an accommodations overlay row (slice 78's "no sitting
// in hand" rule): the join does that, and a list must not create rows for
// every teacher whose sitting merely admits the student.
//
// Finding 10.2 (2026-08-29): the attempt a row carries is found by the SAME
// key `POST /api/attempts` uses — (sitting owner's overlay row, assessment) —
// so the list can never disagree with what pressing the button does. A
// submitted attempt shows on every listed sitting of that assessment (Done:
// the join would return it unmoved and every save is refused); an in-progress
// one shows only on the sitting it is bound to (finding 8.2: the join rebinds
// it there, so "Resume" belongs where it lives and "Join" elsewhere).
//
// U-12 (2026-10-05, open-beta report "too many options to join"): ONE row per
// assessment. Teachers open several sittings of one test (a sitting per
// period, two by a double press, a co-teacher's beside the owner's), and the
// student saw the test once per sitting. Every sitting of one assessment
// joins the same attempt (the join key above is per assessment), so the row
// names one sitting: the one the in-progress attempt is bound to, else the
// newest. The row carries the attempt whichever sitting it names — the join
// rebinds it there (8.2). Server-side, so every client version gets it.
//
// U-15: `time_ran_out` — an in-progress attempt past its deadline + grace, the
// rule v1.5.0 refuses on before `begin()`. Older clients ignore the field.
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import {
  assessments,
  attempts,
  roster_sections,
  students,
  test_sessions,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import type { SessionPayload } from "@/lib/auth/session";
import { isStaff } from "@/lib/auth/roles";
import { isAdmittedToSitting } from "@/lib/api/resolveStudent";
import { findActiveRosterStudentsByEmail, normalizeEmail } from "@/lib/roster/queries";
import { sectionLabel } from "@/lib/roster/teacherRoster";
import { deadlineFor, isPastDeadline } from "@/lib/api/attemptDeadline";

type Db = ReturnType<typeof getDb>;

export interface MySitting {
  test_session_id: string;
  /** The redeem code the teacher reads out (finding 10.5): students match rows by it. */
  code: string;
  assessment_id: string;
  assessment_name: string;
  teacher_email: string | null;
  /** `practice` (docs/practice-sitting-design.md, D-3): a staff member's own
   * practice sitting. An older client reads an unknown scope as `sections`. */
  scope: "sections" | "section" | "students" | "practice";
  section_label: string | null;
  expires_at: Date;
  created_at: Date;
  attempt: { id: string; status: string; submitted_at: Date | null } | null;
  /** U-15: the in-progress attempt's time is up (deadline + 30 s grace).
   * Joining is refused; the student needs the teacher's Adjust time. */
  time_ran_out: boolean;
}

type SittingWithAssessment = {
  sitting: typeof test_sessions.$inferSelect;
  assessment: typeof assessments.$inferSelect;
};
type AttemptRow = typeof attempts.$inferSelect;

/**
 * U-12: one entry per assessment, in the input's (newest-first) order. Picks
 * the sitting the in-progress attempt is bound to when it is listed, else the
 * newest. Exported for tests.
 */
export function onePerAssessment<T extends SittingWithAssessment>(
  rows: T[],
  attemptOf: (assessment: T["assessment"]) => AttemptRow | undefined,
): Array<{ row: T; attempt: AttemptRow | undefined }> {
  const byAssessment = new Map<string, T[]>();
  for (const row of rows) {
    const group = byAssessment.get(row.assessment.id);
    if (group) group.push(row);
    else byAssessment.set(row.assessment.id, [row]);
  }
  return [...byAssessment.values()].map((group) => {
    const attempt = attemptOf(group[0]!.assessment);
    const bound =
      attempt?.status === "in_progress"
        ? group.find((r) => r.sitting.id === attempt.test_session_id)
        : undefined;
    return { row: bound ?? group[0]!, attempt };
  });
}

function timeRanOut(attempt: AttemptRow | undefined, assessment: SittingWithAssessment["assessment"], now: Date): boolean {
  if (!attempt || attempt.status !== "in_progress") return false;
  return isPastDeadline(now, deadlineFor(attempt, assessment));
}

function toMySitting(
  { sitting, assessment }: SittingWithAssessment,
  attempt: AttemptRow | undefined,
  scope: MySitting["scope"],
  sectionLabel: string | null,
  now: Date,
): MySitting {
  return {
    test_session_id: sitting.id,
    code: sitting.code,
    assessment_id: assessment.id,
    assessment_name: assessment.name,
    teacher_email: sitting.owner_email,
    scope,
    section_label: sectionLabel,
    expires_at: sitting.expires_at,
    created_at: sitting.created_at,
    attempt: attempt ? { id: attempt.id, status: attempt.status, submitted_at: attempt.submitted_at } : null,
    time_ran_out: timeRanOut(attempt, assessment, now),
  };
}

export type MySittingsResult =
  | { ok: true; sittings: MySitting[] }
  /** Account-level facts the student can act on; the list is empty. */
  | { ok: false; reason: "no_email" | "not_on_roster" | "identity_conflict" | "no_practice_sitting" };

export async function listMySittings(db: Db, session: SessionPayload): Promise<MySittingsResult> {
  if (isStaff(session.role)) return listMyPracticeSittings(db, session);

  const email = normalizeEmail(session.email);
  if (!email) return { ok: false, reason: "no_email" };

  const matches = await findActiveRosterStudentsByEmail(db, email);
  if (matches.length === 0) return { ok: false, reason: "not_on_roster" };
  if (matches.length > 1) return { ok: false, reason: "identity_conflict" };
  const roster = matches[0]!;

  const candidates = await db
    .select({ sitting: test_sessions, assessment: assessments })
    .from(test_sessions)
    .innerJoin(assessments, eq(assessments.id, test_sessions.assessment_id))
    .where(and(eq(test_sessions.status, "open"), gt(test_sessions.expires_at, new Date())))
    .orderBy(desc(test_sessions.created_at));

  const admitted: typeof candidates = [];
  for (const row of candidates) {
    if (await isAdmittedToSitting(db, roster, row.sitting)) admitted.push(row);
  }
  if (admitted.length === 0) return { ok: true, sittings: [] };

  const assessmentIds = [...new Set(admitted.map((r) => r.sitting.assessment_id))];
  // Every attempt of this roster student at a listed assessment, tagged with
  // the teacher whose overlay row it hangs off — the join's key.
  const existing = await db
    .select({ attempt: attempts, owner_sub: students.owner_sub })
    .from(attempts)
    .innerJoin(students, eq(students.id, attempts.student_id))
    .where(and(eq(students.roster_ps_id, roster.ps_id), inArray(attempts.assessment_id, assessmentIds)));
  const attemptByOwnerAndAssessment = new Map<string, (typeof existing)[number]["attempt"]>();
  for (const { attempt, owner_sub } of existing) {
    attemptByOwnerAndAssessment.set(`${owner_sub}\u0000${attempt.assessment_id}`, attempt);
  }
  // Keyed by the ASSESSMENT's owner, the tenant a join files the overlay
  // under — not the sitting's, which is the co-teacher's on a co-teach
  // sitting (co-teacher tenant fix, 2026-09-22).
  const picked = onePerAssessment(admitted, (assessment) =>
    attemptByOwnerAndAssessment.get(`${assessment.owner_sub}\u0000${assessment.id}`),
  );

  const sectionIds = [
    ...new Set(picked.map(({ row }) => row.sitting.section_ps_id).filter((x): x is string => !!x)),
  ];
  const labelByPsId = new Map<string, string>();
  if (sectionIds.length > 0) {
    const rows = await db.select().from(roster_sections).where(inArray(roster_sections.ps_id, sectionIds));
    for (const s of rows) labelByPsId.set(s.ps_id, sectionLabel(s));
  }

  const now = new Date();
  return {
    ok: true,
    sittings: picked.map(({ row, attempt }) =>
      toMySitting(
        row,
        attempt,
        row.sitting.student_ps_ids ? "students" : row.sitting.section_ps_id ? "section" : "sections",
        row.sitting.section_ps_id ? (labelByPsId.get(row.sitting.section_ps_id) ?? null) : null,
        now,
      ),
    ),
  };
}

/**
 * Practice sittings (docs/practice-sitting-design.md, D-3): "Your tests" for a
 * staff sign-in — the open, unexpired practice sittings that name this
 * caller's sub, and nothing else (a staff member is never admitted to a class
 * sitting). None is an empty list with `no_practice_sitting`, which the client
 * can put into words.
 *
 * The attempt a row carries follows the same rule as the student list: the
 * practice overlay row (under the ASSESSMENT owner — see
 * `resolvePracticePrincipal`) and the assessment are the join's key; a
 * submitted attempt shows on every listed sitting of that assessment, an
 * in-progress one only on the sitting it is bound to. U-12 applies here too:
 * one row per assessment.
 */
async function listMyPracticeSittings(db: Db, session: SessionPayload): Promise<MySittingsResult> {
  const rows = await db
    .select({ sitting: test_sessions, assessment: assessments })
    .from(test_sessions)
    .innerJoin(assessments, eq(assessments.id, test_sessions.assessment_id))
    .where(
      and(
        eq(test_sessions.kind, "practice"),
        eq(test_sessions.practice_for_sub, session.sub),
        eq(test_sessions.status, "open"),
        gt(test_sessions.expires_at, new Date()),
      ),
    )
    .orderBy(desc(test_sessions.created_at));
  if (rows.length === 0) return { ok: false, reason: "no_practice_sitting" };

  const assessmentIds = [...new Set(rows.map((r) => r.assessment.id))];
  const existing = await db
    .select({ attempt: attempts, owner_sub: students.owner_sub })
    .from(attempts)
    .innerJoin(students, eq(students.id, attempts.student_id))
    .where(
      and(
        eq(students.practice_for_sub, session.sub),
        eq(attempts.practice, true),
        inArray(attempts.assessment_id, assessmentIds),
      ),
    );
  const attemptByOwnerAndAssessment = new Map<string, (typeof existing)[number]["attempt"]>();
  for (const { attempt, owner_sub } of existing) {
    attemptByOwnerAndAssessment.set(`${owner_sub}\u0000${attempt.assessment_id}`, attempt);
  }

  const now = new Date();
  return {
    ok: true,
    sittings: onePerAssessment(rows, (assessment) =>
      attemptByOwnerAndAssessment.get(`${assessment.owner_sub}\u0000${assessment.id}`),
    ).map(({ row, attempt }) => toMySitting(row, attempt, "practice", null, now)),
  };
}
