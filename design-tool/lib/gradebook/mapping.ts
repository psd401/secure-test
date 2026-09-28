// Gradebook push id mapping (docs/gradebook-push-design.md, "Id mapping").
//
// Two halves:
//   - loaders over the roster tables — the sender's `users_dcid`, the
//     section's `dcid` / `year_id` / `term_id`, and the candidate attempts of
//     one section with each student's DCID;
//   - `planSend`, a pure function from those candidates and what was sent
//     before to what this send writes, skips and holds back (D-3, D-7).
//
// Every id comes from the nightly extract (slice 1) — never from a request
// body and never from the plugin's own roster reads, which are for lookups
// and pre-send checks only (IT's condition, 2026-09-25).
import { and, eq, inArray } from "drizzle-orm";
import {
  attempts,
  roster_section_teachers,
  roster_sections,
  roster_students,
  test_sessions,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import { normalizeEmail, studentsEnrolledInSection, teacherAssignmentIsCurrent } from "@/lib/roster/queries";
import { buildResults } from "@/lib/scoring/results";
import type { HeldBackReason } from "./types";

type Db = ReturnType<typeof getDb>;

export interface SectionIds {
  ps_id: string;
  dcid: string | null;
  year_id: string | null;
  term_id: string | null;
}

/**
 * The sender's roster assignment on this section: present only when the
 * address CURRENTLY teaches it (active row, `start_date ≤ today ≤ end_date`,
 * any role, the section itself active). `users_dcid` may still be null —
 * the caller decides what that means. Several current rows (one per school
 * teacher id) are fine; the first carrying a DCID wins.
 */
export async function loadSenderAssignment(
  db: Db,
  email: string | null | undefined,
  sectionPsId: string,
): Promise<{ users_dcid: string | null } | null> {
  const address = normalizeEmail(email);
  if (!address) return null;
  const rows = await db
    .select({ users_dcid: roster_section_teachers.users_dcid })
    .from(roster_section_teachers)
    .innerJoin(roster_sections, eq(roster_sections.ps_id, roster_section_teachers.section_ps_id))
    .where(
      and(
        eq(roster_section_teachers.section_ps_id, sectionPsId),
        eq(roster_section_teachers.teacher_email, address),
        teacherAssignmentIsCurrent,
        eq(roster_sections.is_active, true),
      ),
    );
  if (rows.length === 0) return null;
  const withDcid = rows.find((r) => r.users_dcid);
  return { users_dcid: withDcid?.users_dcid ?? null };
}

export async function loadSectionIds(db: Db, sectionPsId: string): Promise<SectionIds | null> {
  const [row] = await db
    .select({
      ps_id: roster_sections.ps_id,
      dcid: roster_sections.dcid,
      year_id: roster_sections.year_id,
      term_id: roster_sections.term_id,
    })
    .from(roster_sections)
    .where(eq(roster_sections.ps_id, sectionPsId))
    .limit(1);
  return row ?? null;
}

/** Which of the ids a PowerSchool send needs are missing, in a fixed order. */
export function missingPowerSchoolIds(
  usersDcid: string | null,
  section: SectionIds,
): Array<"users_dcid" | "section_dcid" | "year_id" | "term_id"> {
  const missing: Array<"users_dcid" | "section_dcid" | "year_id" | "term_id"> = [];
  if (!usersDcid) missing.push("users_dcid");
  if (!section.dcid) missing.push("section_dcid");
  if (!section.year_id) missing.push("year_id");
  if (!section.term_id) missing.push("term_id");
  return missing;
}

/** One handed-in attempt of the section, with what a send needs to know. */
export interface Candidate {
  attempt_id: string;
  /** The roster `ps_id` (= student number); null when the student is unlinked. */
  student_number: string | null;
  student_dcid: string | null;
  total_points: number;
  unscored_count: number;
}

export interface SectionCandidates {
  candidates: Candidate[];
  /** The assessment's constant denominator (D-R1 / D-4). */
  max_points: number;
}

/**
 * The SUBMITTED, non-practice attempts of this assessment that belong to the
 * section — by the same rule the results page uses for a row's section
 * label: the attempt's sitting's section when it named one, else the
 * student's current enrollment in this section. Students resolve through
 * `buildResults`, i.e. the OWNER's overlay (a co-teacher sees what the owner
 * sees). The caller has already authorized the assessment.
 */
export async function loadSectionCandidates(
  db: Db,
  assessmentId: string,
  sectionPsId: string,
): Promise<SectionCandidates> {
  const results = await buildResults(assessmentId);
  const max_points = results.rows[0]?.max_points ?? 0;
  if (results.rows.length === 0) return { candidates: [], max_points };

  const attemptRows = await db
    .select({ id: attempts.id, test_session_id: attempts.test_session_id })
    .from(attempts)
    .where(inArray(attempts.id, results.rows.map((r) => r.attempt_id)));
  const sittingByAttempt = new Map(attemptRows.map((a) => [a.id, a.test_session_id]));
  const sittingIds = [
    ...new Set(attemptRows.map((a) => a.test_session_id).filter((v): v is string => !!v)),
  ];
  const sittings =
    sittingIds.length > 0
      ? await db
          .select({ id: test_sessions.id, section_ps_id: test_sessions.section_ps_id })
          .from(test_sessions)
          .where(inArray(test_sessions.id, sittingIds))
      : [];
  const sectionBySitting = new Map(sittings.map((s) => [s.id, s.section_ps_id]));
  const enrolled = new Set((await studentsEnrolledInSection(db, sectionPsId)).map((s) => s.ps_id));

  const inSection = results.rows.filter((row) => {
    const sittingId = sittingByAttempt.get(row.attempt_id) ?? null;
    const sittingSection = sittingId ? sectionBySitting.get(sittingId) ?? null : null;
    if (sittingSection) return sittingSection === sectionPsId;
    return row.student.student_number !== null && enrolled.has(row.student.student_number);
  });

  const numbers = [
    ...new Set(inSection.map((r) => r.student.student_number).filter((v): v is string => !!v)),
  ];
  const rosterRows =
    numbers.length > 0
      ? await db
          .select({ ps_id: roster_students.ps_id, dcid: roster_students.dcid })
          .from(roster_students)
          .where(inArray(roster_students.ps_id, numbers))
      : [];
  const dcidByNumber = new Map(rosterRows.map((r) => [r.ps_id, r.dcid]));

  return {
    max_points,
    candidates: inSection.map((row) => ({
      attempt_id: row.attempt_id,
      student_number: row.student.student_number,
      student_dcid: row.student.student_number
        ? dcidByNumber.get(row.student.student_number) ?? null
        : null,
      total_points: row.total_points ?? 0,
      unscored_count: row.unscored_count,
    })),
  };
}

/** What a previous send recorded for one attempt. */
export interface PriorScore {
  points_sent: number;
  external_score_id: string | null;
}

export interface PlannedWrite {
  attempt_id: string;
  student_number: string;
  student_dcid: string;
  points: number;
  /** The `assignmentscoreid` of the previous write, when there was one. */
  external_score_id: string | null;
  kind: "new" | "update";
}

export interface SendPlan {
  writes: PlannedWrite[];
  skipped_unchanged: string[];
  held_back: Array<{ attempt_id: string; student_number: string | null; reason: HeldBackReason }>;
}

/**
 * D-3: a row with any unscored response is held back, never sent as partial
 * points. Then a row needs a student number and a DCID. D-7: a row whose
 * points match what was last sent is skipped; a changed one is an update.
 * Held-back reasons are checked in that order, so a row is counted once.
 */
export function planSend(
  candidates: readonly Candidate[],
  prior: ReadonlyMap<string, PriorScore>,
): SendPlan {
  const plan: SendPlan = { writes: [], skipped_unchanged: [], held_back: [] };
  for (const c of candidates) {
    if (c.unscored_count > 0) {
      plan.held_back.push({ attempt_id: c.attempt_id, student_number: c.student_number, reason: "unscored" });
      continue;
    }
    if (!c.student_number) {
      plan.held_back.push({ attempt_id: c.attempt_id, student_number: null, reason: "not_on_roster" });
      continue;
    }
    if (!c.student_dcid) {
      plan.held_back.push({ attempt_id: c.attempt_id, student_number: c.student_number, reason: "no_dcid" });
      continue;
    }
    const before = prior.get(c.attempt_id);
    if (before && before.points_sent === c.total_points) {
      plan.skipped_unchanged.push(c.attempt_id);
      continue;
    }
    plan.writes.push({
      attempt_id: c.attempt_id,
      student_number: c.student_number,
      student_dcid: c.student_dcid,
      points: c.total_points,
      external_score_id: before?.external_score_id ?? null,
      kind: before ? "update" : "new",
    });
  }
  return plan;
}
