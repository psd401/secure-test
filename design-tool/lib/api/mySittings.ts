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
import { isAdmittedToSitting } from "@/lib/api/resolveStudent";
import { findActiveRosterStudentsByEmail, normalizeEmail } from "@/lib/roster/queries";
import { sectionLabel } from "@/lib/roster/teacherRoster";

type Db = ReturnType<typeof getDb>;

export interface MySitting {
  test_session_id: string;
  /** The redeem code the teacher reads out (finding 10.5): students match rows by it. */
  code: string;
  assessment_id: string;
  assessment_name: string;
  teacher_email: string | null;
  scope: "sections" | "section" | "students";
  section_label: string | null;
  expires_at: Date;
  created_at: Date;
  attempt: { id: string; status: string; submitted_at: Date | null } | null;
}

export type MySittingsResult =
  | { ok: true; sittings: MySitting[] }
  /** Account-level facts the student can act on; the list is empty. */
  | { ok: false; reason: "no_email" | "not_on_roster" | "identity_conflict" };

export async function listMySittings(db: Db, session: SessionPayload): Promise<MySittingsResult> {
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
  const attemptFor = (sitting: (typeof admitted)[number]["sitting"]) => {
    const attempt = attemptByOwnerAndAssessment.get(`${sitting.owner_sub}\u0000${sitting.assessment_id}`);
    if (!attempt) return undefined;
    if (attempt.status === "submitted") return attempt;
    return attempt.test_session_id === sitting.id ? attempt : undefined;
  };

  const sectionIds = [...new Set(admitted.map((r) => r.sitting.section_ps_id).filter((x): x is string => !!x))];
  const labelByPsId = new Map<string, string>();
  if (sectionIds.length > 0) {
    const rows = await db.select().from(roster_sections).where(inArray(roster_sections.ps_id, sectionIds));
    for (const s of rows) labelByPsId.set(s.ps_id, sectionLabel(s));
  }

  return {
    ok: true,
    sittings: admitted.map(({ sitting, assessment }) => {
      const attempt = attemptFor(sitting);
      return {
        test_session_id: sitting.id,
        code: sitting.code,
        assessment_id: assessment.id,
        assessment_name: assessment.name,
        teacher_email: sitting.owner_email,
        scope: sitting.student_ps_ids ? "students" : sitting.section_ps_id ? "section" : "sections",
        section_label: sitting.section_ps_id ? (labelByPsId.get(sitting.section_ps_id) ?? null) : null,
        expires_at: sitting.expires_at,
        created_at: sitting.created_at,
        attempt: attempt
          ? { id: attempt.id, status: attempt.status, submitted_at: attempt.submitted_at }
          : null,
      };
    }),
  };
}
