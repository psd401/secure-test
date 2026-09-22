import { and, eq, isNull } from "drizzle-orm";
import {
  assessments,
  students,
  type RosterStudentRow,
  type StudentRow,
  type TestSessionRow,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import type { SessionPayload } from "@/lib/auth/session";
import { isStaff } from "@/lib/auth/roles";
import {
  findActiveRosterStudentsByEmail,
  normalizeEmail,
  studentIsInTeachersSection,
} from "@/lib/roster/queries";

type Db = ReturnType<typeof getDb>;

/**
 * Slice 78 (ADR 0017): resolves an authenticated student to the roster row
 * that is them, decides whether they belong in a sitting, and binds them to
 * the teacher's accommodations overlay.
 *
 * Three questions, in order, each answered by a different table:
 *
 *   1. WHO — `roster_students`, matched on the session's verified email
 *      (lowercased; the importer lowercases too). The warehouse is the
 *      source of truth for who exists. Exactly one active row must match:
 *      none is not_on_roster, two is identity_conflict — a warehouse that
 *      carries one address on two students is not something to guess about.
 *
 *   2. WHETHER — the sitting's scope. An explicit student list admits exactly
 *      those; otherwise the student must be currently enrolled in a section
 *      the sitting's owner currently teaches (optionally one named section).
 *      Called without a sitting, this step is skipped — the delivery and
 *      attempt routes gate on an existing attempt instead.
 *
 *   3. AS WHOM — `students`, the per-teacher accommodations overlay that
 *      attempts and accommodations key on. Found by roster_ps_id once bound;
 *      before that, by SSID (so a row TIDE imported gets its accommodations
 *      matched up) and bound; and, ONLY on an admitted join, created. A
 *      student who merely probes a route never leaves a row behind.
 *
 * This is an IDENTITY BINDING and refuses rather than guesses (slice 59's
 * rule, unchanged): binding the wrong row would score one child's answers
 * under another's name. Every ambiguous case returns a reason, not a row.
 */
export type StudentResolution =
  /** `roster` is null only for a practice principal (a staff member sitting
   * their own practice test, docs/practice-sitting-design.md D-3) — the one
   * resolution that never consults the roster. */
  | { ok: true; student: StudentRow; roster: RosterStudentRow | null; newlyBound: boolean }
  | { ok: false; reason: StudentResolutionFailure };

export type StudentResolutionFailure =
  /** The session carries no email — nothing to resolve against. */
  | "no_email"
  /** No active roster student has this address, or (without a sitting) the
   * student has never been admitted by this teacher. */
  | "not_on_roster"
  /** On the roster, but not in this sitting's scope. Collapsed by the redeem
   * route into session_unavailable (see the oracle note there). */
  | "not_in_sitting"
  /** Two roster rows share the address, or the SSID-matched overlay row is
   * already bound to a different roster student. A human decides. */
  | "identity_conflict";

export type SittingScope = Pick<
  TestSessionRow,
  "owner_email" | "section_ps_id" | "student_ps_ids"
> &
  // Practice sittings (D-1): optional so a scope built by hand stays a CLASS
  // scope. Absent `kind` is `class`; the practice branch below requires it to
  // say `practice` explicitly, so a missing field fails closed.
  Partial<Pick<TestSessionRow, "kind" | "practice_for_sub" | "assessment_id">>;

export async function resolveStudentForOwner(
  db: Db,
  ownerSub: string,
  session: SessionPayload,
  sitting?: SittingScope,
): Promise<StudentResolution> {
  // Practice (D-3): a staff principal never touches the roster. It resolves
  // only to its own practice overlay, and only through a practice sitting
  // that names it.
  if (isStaff(session.role)) return resolvePracticePrincipal(db, ownerSub, session, sitting);

  const email = normalizeEmail(session.email);
  if (!email) return { ok: false, reason: "no_email" };

  const matches = await findActiveRosterStudentsByEmail(db, email);
  if (matches.length === 0) return { ok: false, reason: "not_on_roster" };
  if (matches.length > 1) {
    // ps_ids are opaque PowerSchool numbers; the address itself stays out of
    // the log.
    console.warn(
      `resolve: ${matches.length} active roster rows share one email ` +
        `(ps_ids ${matches.map((m) => m.ps_id).join(", ")}) — refusing`,
    );
    return { ok: false, reason: "identity_conflict" };
  }
  const roster = matches[0]!;

  if (sitting && !(await isAdmittedToSitting(db, roster, sitting))) {
    return { ok: false, reason: "not_in_sitting" };
  }

  const overlay = await findOrBindOverlay(db, ownerSub, roster, sitting !== undefined);
  if (!overlay.ok) return overlay;
  return { ok: true, student: overlay.student, roster, newlyBound: overlay.newlyBound };
}

/** Step 2: the sitting's scope, as documented on `test_sessions`. */
export async function isAdmittedToSitting(
  db: Db,
  roster: RosterStudentRow,
  sitting: SittingScope,
): Promise<boolean> {
  // D-1: a practice sitting admits exactly one principal — the staff member
  // it names — and never a student.
  if (sitting.kind === "practice") return false;
  if (sitting.student_ps_ids !== null && sitting.student_ps_ids !== undefined) {
    return sitting.student_ps_ids.includes(roster.ps_id);
  }
  const ownerEmail = normalizeEmail(sitting.owner_email);
  if (!ownerEmail) {
    // A sitting with no owner email (created before slice 78) cannot be
    // matched to sections. It admits nobody unless it carries a list.
    return false;
  }
  return studentIsInTeachersSection(db, roster.ps_id, ownerEmail, sitting.section_ps_id);
}

type OverlayResult =
  | { ok: true; student: StudentRow; newlyBound: boolean }
  | { ok: false; reason: "not_on_roster" | "identity_conflict" };

export async function findOrBindOverlay(
  db: Db,
  ownerSub: string,
  roster: RosterStudentRow,
  createIfMissing: boolean,
): Promise<OverlayResult> {
  const [bound] = await db
    .select()
    .from(students)
    .where(and(eq(students.owner_sub, ownerSub), eq(students.roster_ps_id, roster.ps_id)))
    .limit(1);
  if (bound) return { ok: true, student: bound, newlyBound: false };

  const displayName = `${roster.first_name} ${roster.last_name}`.trim();

  // A TIDE import keys the overlay by SSID and leaves roster_ps_id null. Bind
  // it now so the accommodations TIDE carried apply to this child.
  if (roster.ssid) {
    const [bySsid] = await db
      .select()
      .from(students)
      .where(and(eq(students.owner_sub, ownerSub), eq(students.ssid, roster.ssid)))
      .limit(1);
    if (bySsid) {
      // Cannot equal roster.ps_id — the first query would have found it.
      if (bySsid.roster_ps_id !== null) return { ok: false, reason: "identity_conflict" };

      // Guarded on IS NULL so two concurrent first-joins cannot both claim the
      // row: the loser updates nothing and re-reads what the winner wrote.
      const [updated] = await db
        .update(students)
        .set({
          roster_ps_id: roster.ps_id,
          name: bySsid.name === "" ? displayName : bySsid.name,
          grade: bySsid.grade ?? roster.grade,
          updated_at: new Date(),
        })
        .where(and(eq(students.id, bySsid.id), isNull(students.roster_ps_id)))
        .returning();
      if (updated) return { ok: true, student: updated, newlyBound: true };

      const [afterRace] = await db.select().from(students).where(eq(students.id, bySsid.id));
      if (afterRace?.roster_ps_id === roster.ps_id) {
        return { ok: true, student: afterRace, newlyBound: false };
      }
      return { ok: false, reason: "identity_conflict" };
    }
  }

  if (!createIfMissing) return { ok: false, reason: "not_on_roster" };

  const [created] = await db
    .insert(students)
    .values({
      owner_sub: ownerSub,
      ssid: roster.ssid,
      roster_ps_id: roster.ps_id,
      name: displayName,
      grade: roster.grade,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return { ok: true, student: created, newlyBound: true };

  // Lost a race with another first-join for the same child: read the winner.
  const [winner] = await db
    .select()
    .from(students)
    .where(and(eq(students.owner_sub, ownerSub), eq(students.roster_ps_id, roster.ps_id)))
    .limit(1);
  if (winner) return { ok: true, student: winner, newlyBound: false };
  return { ok: false, reason: "identity_conflict" };
}

/**
 * Practice sittings (docs/practice-sitting-design.md, D-3): the staff branch
 * of `resolveStudentForOwner`.
 *
 * With a sitting in hand (join, redeem) the sitting must be `practice` AND
 * name this caller's sub, else `not_in_sitting` — a class sitting, or a
 * colleague's practice sitting, is never theirs. Without one (`loadOwnAttempt`,
 * delivery) the practice overlay is only FOUND, never created — the same
 * "a probe leaves no row behind" rule the student path keeps — and the
 * caller's attempt comparison decides the rest.
 *
 * The overlay lives under the ASSESSMENT's owner, whoever started the sitting:
 * with a sitting, the owner is read off its assessment; without one every
 * caller already passes `assessments.owner_sub`. So a co-teacher practising
 * (D-2, `run` level) gets one row under the owner — "one practice row per
 * (assessment owner, practising teacher)" — and the per-attempt routes, which
 * resolve against the assessment owner, find the same row the join created.
 */
async function resolvePracticePrincipal(
  db: Db,
  ownerSub: string,
  session: SessionPayload,
  sitting?: SittingScope,
): Promise<StudentResolution> {
  let overlayOwner = ownerSub;
  if (sitting) {
    if (sitting.kind !== "practice" || sitting.practice_for_sub !== session.sub) {
      return { ok: false, reason: "not_in_sitting" };
    }
    if (sitting.assessment_id) {
      const [assessment] = await db
        .select({ owner_sub: assessments.owner_sub })
        .from(assessments)
        .where(eq(assessments.id, sitting.assessment_id))
        .limit(1);
      if (!assessment) return { ok: false, reason: "not_in_sitting" };
      overlayOwner = assessment.owner_sub;
    }
    const created = await findOrCreatePracticeOverlay(db, overlayOwner, session);
    return { ok: true, student: created.student, roster: null, newlyBound: created.created };
  }
  const [existing] = await db
    .select()
    .from(students)
    .where(and(eq(students.owner_sub, overlayOwner), eq(students.practice_for_sub, session.sub)))
    .limit(1);
  if (!existing) return { ok: false, reason: "not_on_roster" };
  return { ok: true, student: existing, roster: null, newlyBound: false };
}

/**
 * D-3: the `students` row a practising staff member's attempt hangs off —
 * `practice_for_sub = session.sub`, named "Practice — <address>", no roster
 * binding and no SSID. Unique on (owner_sub, practice_for_sub), so two first
 * joins racing converge on one row.
 *
 * The session carries no display name (only the verified address), so the
 * label uses the address's local part — the name the Monitor and the
 * per-student page show beside "Practice".
 */
export async function findOrCreatePracticeOverlay(
  db: Db,
  ownerSub: string,
  session: SessionPayload,
): Promise<{ student: StudentRow; created: boolean }> {
  const where = and(eq(students.owner_sub, ownerSub), eq(students.practice_for_sub, session.sub));
  const [existing] = await db.select().from(students).where(where).limit(1);
  if (existing) return { student: existing, created: false };

  const [created] = await db
    .insert(students)
    .values({
      owner_sub: ownerSub,
      practice_for_sub: session.sub,
      name: practiceOverlayName(session),
    })
    .onConflictDoNothing()
    .returning();
  if (created) return { student: created, created: true };

  // Lost a race with a concurrent first join: read the winner.
  const [winner] = await db.select().from(students).where(where).limit(1);
  if (!winner) throw new Error("findOrCreatePracticeOverlay: row vanished after a conflict");
  return { student: winner, created: false };
}

export function practiceOverlayName(session: Pick<SessionPayload, "email">): string {
  const local = normalizeEmail(session.email)?.split("@")[0];
  return local ? `Practice — ${local}` : "Practice";
}

/** HTTP status for a failed resolution. Kept beside the reasons so callers
 * cannot drift apart on what a given failure means. */
export function statusForResolutionFailure(reason: StudentResolutionFailure): number {
  switch (reason) {
    case "no_email":
      // The token authenticated but is unusable here. Not the caller's fault
      // to retry, so not a 401.
      return 403;
    case "not_on_roster":
    case "not_in_sitting":
      return 404;
    case "identity_conflict":
      // Needs a human to resolve; a retry will not help.
      return 409;
  }
}
