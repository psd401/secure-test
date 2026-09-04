import { NextResponse } from "next/server";
import { and, eq, gt } from "drizzle-orm";
import {
  assessments,
  attempts,
  items,
  test_sessions,
  type AttemptRow,
  type ItemRow, item_sets } from "@/db/schema";
import type { getDb } from "@/db/client";
import type { ItemResponse } from "@secure-test/schema";
import type { SessionPayload } from "@/lib/auth/session";
import {
  MATCH_LEFT,
  MATCH_RIGHT,
  opaqueId,
  resolveOpaqueId,
  resolveOpaqueIds,
} from "@/lib/api/opaqueIds";
import {
  resolveStudentForOwner,
  statusForResolutionFailure,
} from "@/lib/api/resolveStudent";

type Db = ReturnType<typeof getDb>;

/**
 * Slice 61: loads an attempt and proves the caller is the student it belongs to.
 *
 * Two separate questions, and conflating them is how a student ends up writing
 * into someone else's attempt:
 *   1. Which roster row is this token? — resolved against the assessment's
 *      OWNER, because `students` is a per-teacher roster and the same child has
 *      a different row under each teacher.
 *   2. Is that row the one this attempt belongs to?
 *
 * A mismatch answers 404, not 403: the attempt exists but is not this student's
 * business, and a 403 would confirm that an attempt with that id exists at all.
 */
export type AttemptAccess =
  | { ok: true; attempt: AttemptRow; studentId: string }
  | { ok: false; response: NextResponse };

export function notFound(): NextResponse {
  return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
}

export async function loadOwnAttempt(
  db: Db,
  attemptId: string,
  session: SessionPayload,
): Promise<AttemptAccess> {
  const [row] = await db
    .select({ attempt: attempts, ownerSub: assessments.owner_sub })
    .from(attempts)
    .innerJoin(assessments, eq(attempts.assessment_id, assessments.id))
    .where(eq(attempts.id, attemptId))
    .limit(1);

  if (!row) return { ok: false, response: notFound() };

  const resolved = await resolveStudentForOwner(db, row.ownerSub, session);
  if (!resolved.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: resolved.reason },
        { status: statusForResolutionFailure(resolved.reason) },
      ),
    };
  }
  if (resolved.student.id !== row.attempt.student_id) {
    return { ok: false, response: notFound() };
  }
  return { ok: true, attempt: row.attempt, studentId: resolved.student.id };
}

/**
 * The item must belong to the attempt's assessment. Without this check, an
 * attempt id plus any item id from anywhere would write a responses row
 * pointing at another teacher's item: the table's own foreign keys constrain
 * each column separately and say nothing about the two agreeing.
 */
export async function loadItemForAttempt(
  db: Db,
  attempt: AttemptRow,
  itemId: string,
): Promise<ItemRow | null> {
  const [item] = await db
    .select()
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.assessment_id, attempt.assessment_id)))
    .limit(1);
  if (item) return item;
  // E12 slice 3: the outline a student writes in place is posted under the
  // SOURCE question's id (a question of another assessment). Accept it
  // only when a set of this attempt's assessment names that question, and
  // only for the types a source can be — nothing else from another
  // assessment is writable through this attempt.
  const [viaSet] = await db
    .select({ item: items })
    .from(item_sets)
    .innerJoin(items, eq(items.id, item_sets.source_item_id))
    .where(and(eq(item_sets.assessment_id, attempt.assessment_id), eq(item_sets.source_item_id, itemId)))
    .limit(1);
  if (viaSet && (viaSet.item.type === "essay" || viaSet.item.type === "short_text")) return viaSet.item;
  return null;
}

/**
 * An open, unexpired sitting, or null. Deliberately the same rule the redeem
 * route applies, so a sitting cannot be entered through one door after closing
 * on the other.
 */
export async function loadJoinableSitting(db: Db, sessionId: string) {
  const [row] = await db
    .select()
    .from(test_sessions)
    .where(
      and(
        eq(test_sessions.id, sessionId),
        eq(test_sessions.status, "open"),
        gt(test_sessions.expires_at, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Responses may only be written while the attempt is in progress.
 *
 * Note what is NOT checked: whether the sitting is still open. A sitting that
 * expires while a child is mid-sentence should not discard the sentence. The
 * sitting governs who may START, and `attempts.status` governs who may still
 * WRITE; conflating them would mean a teacher closing a period destroys work
 * that was already legitimately underway.
 */
export function attemptAcceptsWrites(attempt: AttemptRow): boolean {
  return attempt.status === "in_progress";
}

export function alreadySubmitted(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "attempt_submitted" },
    { status: 409 },
  );
}

/**
 * Slice 64: translates the per-attempt opaque ids in a match or order response
 * back to the authoring ids before the row is stored.
 *
 * Only these two types carry sealed ids — the delivery bundle hides them
 * because for match the identifier IS the pairing and for order it IS the
 * sequence. Choice ids and hotspot region ids reveal nothing on their own, so
 * they travel as themselves and pass through here untouched.
 *
 * Returns null if any submitted id resolves to nothing. That is a refusal
 * rather than a partial write: a response half-translated would look like a
 * legitimate answer and score as one.
 */
export function unsealResponseIds(
  attemptId: string,
  item: ItemRow,
  response: ItemResponse,
): ItemResponse | null {
  if (response.type === "match") {
    const candidates = (item.config?.pairs ?? []).map((p) => p.id);
    const matches: Record<string, string> = {};
    for (const [leftSealed, rightSealed] of Object.entries(response.matches)) {
      const left = resolveOpaqueId(
        attemptId, item.id, candidates, leftSealed, MATCH_LEFT,
      );
      const right = resolveOpaqueId(
        attemptId, item.id, candidates, rightSealed, MATCH_RIGHT,
      );
      if (left === null || right === null) return null;
      matches[left] = right;
    }
    return { type: "match", matches };
  }

  if (response.type === "order") {
    const candidates = (item.config?.sequence ?? []).map((e) => e.id);
    const ordered = resolveOpaqueIds(
      attemptId,
      item.id,
      candidates,
      response.ordered_ids,
    );
    if (ordered === null) return null;
    return { type: "order", ordered_ids: ordered };
  }

  return response;
}

/**
 * P-1 (docs/resume-prefill-design.md): the inverse of `unsealResponseIds`, for
 * handing a stored answer BACK to the client on resume.
 *
 * It lives beside its inverse deliberately. The stored column holds authoring
 * ids and the bundle shows sealed ones, so a saved match or order answer means
 * nothing to the page unless it is re-sealed with the very same call the item's
 * own `lefts` / `rights` / `entries` were built with — two functions that must
 * agree exactly, kept where a change to one is in front of the other.
 *
 * Differs from the unseal direction on failure, and on purpose: an id arriving
 * from a client that resolves to nothing is a refusal (a half-translated answer
 * would score as a real one), but a STORED id that no longer names one of the
 * item's options is history — the teacher edited the pair or the entry after
 * the student answered. Dropping that entry loses one restored field; refusing
 * would cost the student every other answer on the page. Returns null when
 * nothing survives, and the caller omits the item.
 */
export function sealResponseIds(
  attemptId: string,
  item: ItemRow,
  response: ItemResponse,
): ItemResponse | null {
  if (response.type === "match") {
    const candidates = new Set((item.config?.pairs ?? []).map((p) => p.id));
    const matches: Record<string, string> = {};
    for (const [left, right] of Object.entries(response.matches)) {
      if (!candidates.has(left) || !candidates.has(right)) continue;
      matches[opaqueId(attemptId, item.id, left, MATCH_LEFT)] = opaqueId(
        attemptId,
        item.id,
        right,
        MATCH_RIGHT,
      );
    }
    return Object.keys(matches).length > 0 ? { type: "match", matches } : null;
  }

  if (response.type === "order") {
    const candidates = new Set((item.config?.sequence ?? []).map((e) => e.id));
    const ordered = response.ordered_ids
      .filter((id) => candidates.has(id))
      .map((id) => opaqueId(attemptId, item.id, id));
    return ordered.length > 0 ? { type: "order", ordered_ids: ordered } : null;
  }

  return response;
}
