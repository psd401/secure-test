// "Assessments I can see" = owned ∪ granted (docs/access-model-design.md,
// access slice 2).
//
// Slice 1 left every list query on `owner_sub` and said so: the helper answers
// per-row questions, and a list is a set question. This module is that set
// question, asked ONCE and reused by the home page, `GET /api/assessments`, the
// sittings lists and the counts beside them — because a list widened in three
// places is a list that will disagree with itself, and the failure mode is the
// worst kind: a co-teacher who sees an assessment in one view and 404s in
// another.
//
// Shape: one grant load per request, then a single SQL disjunction, then a pure
// annotation per row. Not a per-row `authorizeAssessment` in a loop — fifty
// rows would be a hundred queries — and not a join against `access_grants`,
// which would multiply rows when a teacher holds both an assessment-scoped and
// a teacher-scoped grant covering the same assessment.
//
// Archived semantics are UNCHANGED (docs/archive-and-delete-design.md, D-4):
// archived rows are hidden by default and `?archived=1` shows only them, so
// the two lists still partition what the caller can see.
import { and, eq, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { assessments, type AssessmentRow } from "@/db/schema";
import { isAdmin } from "@/lib/auth/admin";
import type { SessionPayload } from "@/lib/auth/session";
import type { AccessLevel, AccessVia } from "@/lib/api/accessLevels";
import { grantedLevel, loadActiveGrants, type ActiveGrants } from "@/lib/api/grants";

type Db = ReturnType<typeof getDb>;

/**
 * What a list row carries about the caller's access to it, so slice 3 can label
 * "Shared with you as co-teacher" / "Covering for <teacher>" without a second
 * round trip. `owner_email` is present only when the row is NOT the caller's
 * own — a teacher does not need to be told whose assessment their own is, and
 * the field is the label's whole content when it is somebody else's.
 */
export interface RowAccess {
  level: AccessLevel;
  via: AccessVia;
  owner_email?: string | null;
}

export type VisibleAssessment = AssessmentRow & { access: RowAccess };

/**
 * The reusable half: the WHERE fragment that selects visible assessments, plus
 * the pure annotator for rows selected by it.
 *
 * Handed out separately from `visibleAssessments` because the home page also
 * needs the same scope on three aggregate queries (question counts, attempt
 * counts, open sittings) where selecting whole assessment rows would be waste.
 */
export interface VisibleAssessmentScope {
  /** For a query on the `assessments` table. Never undefined — an admin's arm
   * is `undefined` in Drizzle terms (no predicate), so this is a nullable SQL
   * and `undefined` means "everything". */
  readonly condition: SQL | undefined;
  /** True when the caller can only ever see their own rows — lets a caller keep
   * its existing single-owner query shape when nothing has been granted. */
  readonly ownedOnly: boolean;
  readonly annotate: (row: {
    id: string;
    owner_sub: string;
    owner_email: string | null;
  }) => RowAccess;
}

export async function visibleAssessmentScope(
  db: Db,
  session: SessionPayload,
): Promise<VisibleAssessmentScope> {
  // D-6: an admin sees everything. No predicate at all rather than a giant
  // disjunction — and `via: "admin"` on every row that is not their own.
  if (isAdmin(session)) {
    return {
      condition: undefined,
      ownedOnly: false,
      annotate: (row) => annotateAdmin(session, row),
    };
  }

  const grants = await loadActiveGrants(db, session.email);
  const owned = eq(assessments.owner_sub, session.sub);
  if (grants.empty) {
    return {
      condition: owned,
      ownedOnly: true,
      annotate: () => ({ level: "own", via: "owner" }),
    };
  }

  const arms: SQL[] = [owned];
  const assessmentIds = [...grants.byAssessment.keys()];
  if (assessmentIds.length > 0) {
    arms.push(inArray(assessments.id, assessmentIds));
  }
  const teacherEmails = [...grants.byTeacherEmail.keys()];
  if (teacherEmails.length > 0) {
    // The teacher-scope arm is `owner_email IN (…)`, which is why migration
    // 0038 denormalised the owner's address onto the assessment. A row whose
    // owner_email is NULL simply does not match — the deviation recorded in
    // the design note.
    arms.push(inArray(assessments.owner_email, teacherEmails));
  }

  return {
    condition: arms.length === 1 ? arms[0] : or(...arms)!,
    ownedOnly: false,
    annotate: (row) => annotateWithGrants(session, grants, row),
  };
}

function annotateAdmin(
  session: SessionPayload,
  row: { owner_sub: string; owner_email: string | null },
): RowAccess {
  if (row.owner_sub === session.sub) return { level: "own", via: "owner" };
  return { level: "own", via: "admin", owner_email: row.owner_email };
}

function annotateWithGrants(
  session: SessionPayload,
  grants: ActiveGrants,
  row: { id: string; owner_sub: string; owner_email: string | null },
): RowAccess {
  if (row.owner_sub === session.sub) return { level: "own", via: "owner" };
  const granted = grantedLevel(grants, row);
  // Unreachable through the scope's own condition, but a caller may annotate a
  // row it fetched another way; reporting the lowest level is the safe answer.
  if (!granted) return { level: "view", via: "grant", owner_email: row.owner_email };
  return { level: granted.level, via: "grant", owner_email: row.owner_email };
}

/**
 * The visible assessments themselves, annotated — the one query the home page
 * and `GET /api/assessments` share.
 */
export async function visibleAssessments(
  db: Db,
  session: SessionPayload,
  opts: { archived?: boolean; orderBy?: SQL[] } = {},
): Promise<VisibleAssessment[]> {
  const scope = await visibleAssessmentScope(db, session);
  const archivedFilter = opts.archived
    ? isNotNull(assessments.archived_at)
    : isNull(assessments.archived_at);
  const rows = await db
    .select()
    .from(assessments)
    .where(and(scope.condition, archivedFilter))
    .orderBy(...(opts.orderBy ?? []));
  return rows.map((row) => ({ ...row, access: scope.annotate(row) }));
}
