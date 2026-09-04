import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, students } from "@/db/schema";

/**
 * Result of an ownership-scoped row load.
 *
 * The status is deliberately the HTTP status the caller should return, so the
 * 404-vs-403 decision lives in exactly one place. Note the ordering: a row that
 * does not exist is 404, and a row owned by someone else is 403 — this DOES
 * leak existence to a caller guessing uuids. That is the pre-existing behavior
 * of every route this replaced, preserved deliberately rather than changed as
 * a drive-by; teacher-scoped uuids are not enumerable in practice.
 */
export type OwnedResult<TRow> =
  | { status: 404 }
  | { status: 403 }
  | { status: 200; row: TRow };

/**
 * Load an assessment and confirm the session owns it.
 *
 * This body was copy-pasted verbatim into three routes — assessments/[id],
 * assessments/[id]/overrides, assessments/[id]/items — under two different
 * names (`loadOwned` and `loadOwnedAssessment`). They agreed, but an
 * authorization check is a bad place to keep three chances to disagree.
 */
export async function loadOwnedAssessment(id: string, ownerSub: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, id))
    .limit(1);
  if (!row) return { status: 404 as const };
  if (row.owner_sub !== ownerSub) return { status: 403 as const };
  return { status: 200 as const, row };
}

/** The same shape for a student row. */
export async function loadOwnedStudent(id: string, ownerSub: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(students)
    .where(eq(students.id, id))
    .limit(1);
  if (!row) return { status: 404 as const };
  if (row.owner_sub !== ownerSub) return { status: 403 as const };
  return { status: 200 as const, row };
}

// NOT lifted here on purpose: the joined loaders in
// assessments/[id]/items/[itemId] (`loadOwnedItem`) and
// students/[id]/accommodations/[accId] (`loadOwnedAcc`). Those are genuinely
// different queries — different joins, different select shapes, extra
// predicates like `isNull(removed_at)` — and folding them into a
// table-parameterized generic would hide the join each route depends on to
// stay correct. Duplication is not the problem; UNNOTICED divergence is, and
// there is nothing to diverge between two queries that were never the same.
