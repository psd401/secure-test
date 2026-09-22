// Extracted from `DELETE /api/attempts/[attemptId]` when the practice-sitting
// sweep needed the same delete (docs/practice-sitting-design.md, D-7: "through
// the same delete path (uploads included)"). The route keeps its own access
// check and open-sitting guard; this is only the delete itself, so the route
// and the nightly sweep cannot drift apart on what a delete takes with it.
//
// Deliberately NO storage import here. The sweep runs inside the roster-sync
// Lambda, whose bundle keeps every `@aws-sdk/*` package external and whose
// runtime is not known to ship `@aws-sdk/s3-request-presigner` (a static
// import of `s3Provider`); pulling the storage provider into that bundle
// could stop the nightly roster import from loading at all. So the DB half is
// here and returns the stored objects it orphaned; each caller deletes the
// bytes with whatever storage access it has.
import { count, eq } from "drizzle-orm";
import {
  attempt_deletions,
  attempt_events,
  attempts,
  response_uploads,
  responses,
  type AttemptRow,
} from "@/db/schema";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

export interface StoredUploadRef {
  storage_provider: string;
  storage_key: string;
}

/**
 * Deletes one attempt's rows: the DB cascades take responses, scores, uploads,
 * events and peek requests with it. The stored upload bytes do not cascade, so
 * their keys are read first and RETURNED for the caller to delete best-effort
 * after the commit (the assets route's pattern — an orphaned object is
 * harmless, a half-deleted attempt is not). The audit row is written in the
 * same transaction, into `attempt_deletions` because `attempt_events` goes
 * with the attempt.
 *
 * `deletedBySub` is the teacher's sub for the route, and a `system:` label for
 * the sweep — the audit column is text, and "who" for an automatic delete is
 * the job that did it.
 */
export async function deleteAttemptRecord(
  db: Db,
  attempt: AttemptRow,
  deletedBySub: string,
): Promise<StoredUploadRef[]> {
  const uploads = await db
    .select({
      storage_provider: response_uploads.storage_provider,
      storage_key: response_uploads.storage_key,
    })
    .from(response_uploads)
    .where(eq(response_uploads.attempt_id, attempt.id));

  await db.transaction(async (tx) => {
    const [r] = await tx
      .select({ n: count() })
      .from(responses)
      .where(eq(responses.attempt_id, attempt.id));
    const [e] = await tx
      .select({ n: count() })
      .from(attempt_events)
      .where(eq(attempt_events.attempt_id, attempt.id));
    await tx.insert(attempt_deletions).values({
      attempt_id: attempt.id,
      assessment_id: attempt.assessment_id,
      student_id: attempt.student_id,
      deleted_by_sub: deletedBySub,
      attempt_status: attempt.status,
      attempt_started_at: attempt.started_at,
      attempt_submitted_at: attempt.submitted_at,
      response_count: r?.n ?? 0,
      upload_count: uploads.length,
      event_count: e?.n ?? 0,
    });
    await tx.delete(attempts).where(eq(attempts.id, attempt.id));
  });

  return uploads;
}
