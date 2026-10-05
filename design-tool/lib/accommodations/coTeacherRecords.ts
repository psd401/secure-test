import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  access_grants,
  roster_enrollments,
  roster_section_teachers,
  roster_sections,
  roster_students,
  students,
  type AssessmentRow,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import { coTeachersOf } from "@/lib/roster/coTeachers";
import { enrollmentIsCurrent, normalizeEmail, teacherAssignmentIsCurrent } from "@/lib/roster/queries";
import { assessmentOwner } from "@/lib/scoring/results";

type Db = ReturnType<typeof getDb>;

/**
 * U-17 (docs/coteach-and-section-accommodations-design.md): whose
 * accommodation records count for a student on an assessment, besides the
 * owner's.
 *
 * D-2: a co-teacher is a holder of a LIVE `assessment`-scoped grant on this
 * assessment, or one of the owner's roster co-teachers (`coTeachersOf`).
 * 13.1: their record counts for a child only while they currently teach that
 * child on the roster — a co-teacher of the owner's 3rd period must not reach
 * into the 5th.
 *
 * Replaces the 2026-09-22 sitting-based fallback, which read a co-teacher's
 * record only when the owner's row had none at all.
 */
export async function coTeacherEmailsFor(
  db: Db,
  assessment: Pick<AssessmentRow, "id">,
): Promise<string[]> {
  const { ownerEmail } = await assessmentOwner(db, assessment.id);
  const now = new Date();
  const grants = await db
    .select({ email: access_grants.grantee_email })
    .from(access_grants)
    .where(
      and(
        eq(access_grants.scope_kind, "assessment"),
        eq(access_grants.scope_id, assessment.id),
        isNull(access_grants.revoked_at),
        lte(access_grants.starts_at, now),
        or(isNull(access_grants.ends_at), gt(access_grants.ends_at, now)),
      ),
    );
  const roster = ownerEmail ? await coTeachersOf(db, ownerEmail) : [];
  const owner = normalizeEmail(ownerEmail);
  const emails = new Set<string>();
  for (const e of [...grants.map((g) => g.email), ...roster.map((c) => c.email)]) {
    const n = normalizeEmail(e);
    if (n && n !== owner) emails.add(n);
  }
  return [...emails].sort();
}

/** Roster student ps_id → the emails (of those given) currently teaching them. */
export async function teachersCurrentlyTeaching(
  db: Db,
  emails: readonly string[],
  psIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (emails.length === 0 || psIds.length === 0) return out;
  const rows = await db
    .selectDistinct({
      ps_id: roster_enrollments.student_ps_id,
      email: sql<string>`lower(trim(${roster_section_teachers.teacher_email}))`,
    })
    .from(roster_section_teachers)
    .innerJoin(roster_enrollments, eq(roster_enrollments.section_ps_id, roster_section_teachers.section_ps_id))
    .innerJoin(roster_sections, eq(roster_sections.ps_id, roster_section_teachers.section_ps_id))
    .where(
      and(
        teacherAssignmentIsCurrent,
        enrollmentIsCurrent,
        eq(roster_sections.is_active, true),
        inArray(sql`lower(trim(${roster_section_teachers.teacher_email}))`, [...emails]),
        inArray(roster_enrollments.student_ps_id, [...psIds]),
      ),
    );
  for (const row of rows) {
    const set = out.get(row.ps_id) ?? new Set<string>();
    set.add(row.email);
    out.set(row.ps_id, set);
  }
  return out;
}

/**
 * The co-teachers' overlay rows for ONE roster student, ordered by the
 * co-teacher's email (13.2: the owner's record is read first by the caller,
 * so the owner's value wins a same-tool conflict, then the first co-teacher's).
 *
 * A co-teacher's TIDE-imported row carries the SSID and no roster binding
 * until the child joins one of THAT teacher's tests, so the match is the
 * roster id, or the roster SSID on an unbound row.
 */
export async function coTeacherRecordStudentIds(
  db: Db,
  assessment: Pick<AssessmentRow, "id" | "owner_sub">,
  rosterPsId: string | null,
): Promise<string[]> {
  if (!rosterPsId) return [];
  const emails = await coTeacherEmailsFor(db, assessment);
  if (emails.length === 0) return [];
  const teaching = [...((await teachersCurrentlyTeaching(db, emails, [rosterPsId])).get(rosterPsId) ?? [])];
  if (teaching.length === 0) return [];
  const [roster] = await db
    .select({ ssid: roster_students.ssid })
    .from(roster_students)
    .where(eq(roster_students.ps_id, rosterPsId))
    .limit(1);
  const rows = await db
    .select({ id: students.id })
    .from(students)
    .where(
      and(
        inArray(students.owner_email, teaching),
        ne(students.owner_sub, assessment.owner_sub),
        isNull(students.practice_for_sub),
        roster?.ssid
          ? or(
              eq(students.roster_ps_id, rosterPsId),
              and(isNull(students.roster_ps_id), eq(students.ssid, roster.ssid)),
            )
          : eq(students.roster_ps_id, rosterPsId),
      ),
    )
    .orderBy(asc(students.owner_email), asc(students.created_at));
  return rows.map((r) => r.id);
}

/**
 * 13.3: stamp the caller's email on their overlay rows that lack one. Called
 * at staff sign-in, best-effort — a failure here must never block a login.
 */
export async function stampOverlayOwnerEmail(db: Db, sub: string, email: string | null | undefined) {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  await db
    .update(students)
    .set({ owner_email: normalized })
    .where(and(eq(students.owner_sub, sub), isNull(students.owner_email)));
}

export type ExceptionTarget =
  | { ok: true; studentId: string }
  | { ok: false; error: "student_not_found" | "student_not_linked" };

/**
 * F-1 (13.5): the overlay row an exception attaches to — always the
 * ASSESSMENT OWNER's row for the child, because that is the only row
 * delivery and the preview read exceptions from. A co-teacher used to attach
 * exceptions to their own row, where they were saved and never applied.
 *
 * `studentId` may be the owner's row (any caller with `edit` on the test), or
 * the caller's OWN row for the child, which is mapped to the owner's: by the
 * roster id (or the roster id behind its SSID), finding the owner's row by
 * roster id, then by an unbound SSID row, else creating it — the same row the
 * child's first join would create. An unlinked row (no roster id, SSID not on
 * the roster) cannot be mapped: `student_not_linked`.
 */
export async function exceptionTargetFor(
  db: Db,
  assessment: Pick<AssessmentRow, "owner_sub" | "owner_email">,
  callerSub: string,
  studentId: string,
): Promise<ExceptionTarget> {
  const [row] = await db.select().from(students).where(eq(students.id, studentId)).limit(1);
  if (!row || row.practice_for_sub) return { ok: false, error: "student_not_found" };
  if (row.owner_sub === assessment.owner_sub) return { ok: true, studentId: row.id };
  if (row.owner_sub !== callerSub) return { ok: false, error: "student_not_found" };

  let psId = row.roster_ps_id;
  let rosterSsid: string | null = null;
  if (psId) {
    const [r] = await db
      .select({ ssid: roster_students.ssid })
      .from(roster_students)
      .where(eq(roster_students.ps_id, psId))
      .limit(1);
    rosterSsid = r?.ssid ?? row.ssid;
  } else if (row.ssid) {
    const [r] = await db
      .select({ ps_id: roster_students.ps_id })
      .from(roster_students)
      .where(eq(roster_students.ssid, row.ssid))
      .limit(1);
    psId = r?.ps_id ?? null;
    rosterSsid = row.ssid;
  }
  if (!psId) return { ok: false, error: "student_not_linked" };

  const ownerRows = (where: ReturnType<typeof and>) =>
    db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.owner_sub, assessment.owner_sub), isNull(students.practice_for_sub), where))
      .limit(1);
  const [byPs] = await ownerRows(eq(students.roster_ps_id, psId));
  if (byPs) return { ok: true, studentId: byPs.id };
  if (rosterSsid) {
    const [bySsid] = await ownerRows(and(isNull(students.roster_ps_id), eq(students.ssid, rosterSsid)));
    if (bySsid) return { ok: true, studentId: bySsid.id };
  }
  const [created] = await db
    .insert(students)
    .values({
      owner_sub: assessment.owner_sub,
      owner_email: normalizeEmail(assessment.owner_email),
      roster_ps_id: psId,
      ssid: rosterSsid,
      name: row.name,
      grade: row.grade,
    })
    .onConflictDoNothing()
    .returning({ id: students.id });
  if (created) return { ok: true, studentId: created.id };
  const [winner] = await ownerRows(eq(students.roster_ps_id, psId));
  return winner ? { ok: true, studentId: winner.id } : { ok: false, error: "student_not_found" };
}
