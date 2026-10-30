/**
 * Teacher feedback (docs/feedback-release-design.md, R-1 / D-4 / D-12): save
 * or clear a teacher's comment on one response, or on an attempt as a whole.
 *
 * Shaped like `lib/api/changeScore.ts`: the WRITE lives here, the refusals
 * that need a request (access, body, the attempt's status) belong to the
 * routes.
 *
 * One row per response and one per attempt (D-12), edited in place: the
 * upsert means two co-teachers saving at once cannot make two rows — the last
 * write wins and `author_sub` records who made it. Each change writes one
 * `feedback_edited` event in the same transaction, so a comment edited after a
 * release shows on the timeline; an identical save writes nothing (the
 * no-op `restoreAnswer` precedent).
 *
 * D-14 (FERPA): the text is student-record content and must never reach a
 * log. The event detail carries no text and no length. A failed query is
 * rethrown as a bare error, because Drizzle's `DrizzleQueryError` message
 * lists the query's params — the text — and `lib/observability/serverError.ts`
 * records an unhandled error's message and stack.
 */

import { eq } from "drizzle-orm";
import type { getDb } from "@/db/client";
import {
  attempt_events,
  attempt_feedback,
  response_feedback,
  type AttemptFeedbackRow,
  type ResponseFeedbackRow,
} from "@/db/schema";

type Db = ReturnType<typeof getDb>;

export interface ResponseFeedbackTarget {
  response_id: string;
  attempt_id: string;
  item_id: string;
}

export interface SetFeedbackResult<Row> {
  feedback: Row;
  /** The saved text was already this text; nothing was written. */
  unchanged: boolean;
}

/** A write failure with nothing of the request in it (D-14, see above). */
async function scrubbed<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch {
    throw new Error("teacher feedback write failed");
  }
}

export async function setResponseFeedback(
  db: Db,
  target: ResponseFeedbackTarget,
  text: string,
  staffSub: string,
  options: { now?: Date } = {},
): Promise<SetFeedbackResult<ResponseFeedbackRow>> {
  const now = options.now ?? new Date();
  return scrubbed(() =>
    db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(response_feedback)
        .where(eq(response_feedback.response_id, target.response_id))
        .limit(1);
      if (existing && existing.text === text) {
        return { feedback: existing, unchanged: true };
      }
      const [saved] = await tx
        .insert(response_feedback)
        .values({
          response_id: target.response_id,
          author_sub: staffSub,
          text,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: response_feedback.response_id,
          set: { text, author_sub: staffSub, updated_at: now },
        })
        .returning();
      await tx.insert(attempt_events).values({
        attempt_id: target.attempt_id,
        kind: "feedback_edited",
        at: now,
        detail: {
          scope: "question",
          response_id: target.response_id,
          item_id: target.item_id,
          action: "saved",
        },
      });
      return { feedback: saved!, unchanged: false };
    }),
  );
}

/** Idempotent: clearing a comment that is not there writes no event. */
export async function clearResponseFeedback(
  db: Db,
  target: ResponseFeedbackTarget,
  options: { now?: Date } = {},
): Promise<{ deleted: boolean }> {
  const now = options.now ?? new Date();
  return scrubbed(() =>
    db.transaction(async (tx) => {
      const removed = await tx
        .delete(response_feedback)
        .where(eq(response_feedback.response_id, target.response_id))
        .returning({ id: response_feedback.id });
      if (removed.length === 0) return { deleted: false };
      await tx.insert(attempt_events).values({
        attempt_id: target.attempt_id,
        kind: "feedback_edited",
        at: now,
        detail: {
          scope: "question",
          response_id: target.response_id,
          item_id: target.item_id,
          action: "cleared",
        },
      });
      return { deleted: true };
    }),
  );
}

/** The per-student overall comment (D-4). */
export async function setAttemptFeedback(
  db: Db,
  attemptId: string,
  text: string,
  staffSub: string,
  options: { now?: Date } = {},
): Promise<SetFeedbackResult<AttemptFeedbackRow>> {
  const now = options.now ?? new Date();
  return scrubbed(() =>
    db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(attempt_feedback)
        .where(eq(attempt_feedback.attempt_id, attemptId))
        .limit(1);
      if (existing && existing.text === text) {
        return { feedback: existing, unchanged: true };
      }
      const [saved] = await tx
        .insert(attempt_feedback)
        .values({
          attempt_id: attemptId,
          author_sub: staffSub,
          text,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: attempt_feedback.attempt_id,
          set: { text, author_sub: staffSub, updated_at: now },
        })
        .returning();
      await tx.insert(attempt_events).values({
        attempt_id: attemptId,
        kind: "feedback_edited",
        at: now,
        detail: { scope: "overall", action: "saved" },
      });
      return { feedback: saved!, unchanged: false };
    }),
  );
}

export async function clearAttemptFeedback(
  db: Db,
  attemptId: string,
  options: { now?: Date } = {},
): Promise<{ deleted: boolean }> {
  const now = options.now ?? new Date();
  return scrubbed(() =>
    db.transaction(async (tx) => {
      const removed = await tx
        .delete(attempt_feedback)
        .where(eq(attempt_feedback.attempt_id, attemptId))
        .returning({ id: attempt_feedback.id });
      if (removed.length === 0) return { deleted: false };
      await tx.insert(attempt_events).values({
        attempt_id: attemptId,
        kind: "feedback_edited",
        at: now,
        detail: { scope: "overall", action: "cleared" },
      });
      return { deleted: true };
    }),
  );
}
