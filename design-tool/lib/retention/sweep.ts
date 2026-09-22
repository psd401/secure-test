// D-11 (James, 2026-09-15; docs/observability-design.md end): retention
// sweep for the three observability tables that were never expired
// (db/schema.ts's own RETENTION comments on guardrail_events and the
// batch-3 tables flagged this as a follow-up).
//
// `feedback` is explicitly OUT of scope — it is kept, never swept.
//
// Runs as a step inside the nightly in-VPC roster-sync Lambda, after the
// roster import, best-effort: a sweep failure is logged and never fails the
// sync (see callSweepBestEffort in lib/roster/syncHandler.ts).
//
// Pure function over a Drizzle db handle so it is unit-testable against the
// test database without a Lambda or a schedule.

import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { getDb } from "@/db/client";
import {
  attempts,
  client_error_events,
  guardrail_events,
  server_error_events,
  test_sessions,
} from "@/db/schema";
import { deleteAttemptRecord, type StoredUploadRef } from "@/lib/api/deleteAttempt";

type Db = ReturnType<typeof getDb>;

/** The one place the retention period is set. */
export const RETENTION_DAYS_DEFAULT = 90;

export interface SweepCounts {
  server_error_events: number;
  client_error_events: number;
  guardrail_events: number;
}

/**
 * Deletes rows older than `retentionDays` from the three swept tables.
 * `client_error_events` has no `created_at` column — it uses `received_at`,
 * the server-stamped clock the table's own comment says ordering/alerting
 * should use (the client-stamped `occurred_at` is not trustworthy for this).
 *
 * `feedback` is never touched by this function.
 */
export async function sweepEventTables(
  db: Db,
  now: Date = new Date(),
  retentionDays: number = RETENTION_DAYS_DEFAULT,
): Promise<SweepCounts> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const deletedServerErrors = await db
    .delete(server_error_events)
    .where(lt(server_error_events.created_at, cutoff))
    .returning({ id: server_error_events.id });

  const deletedClientErrors = await db
    .delete(client_error_events)
    .where(lt(client_error_events.received_at, cutoff))
    .returning({ id: client_error_events.id });

  const deletedGuardrailEvents = await db
    .delete(guardrail_events)
    .where(lt(guardrail_events.created_at, cutoff))
    .returning({ id: guardrail_events.id });

  return {
    server_error_events: deletedServerErrors.length,
    client_error_events: deletedClientErrors.length,
    guardrail_events: deletedGuardrailEvents.length,
  };
}

// --- Practice sittings (docs/practice-sitting-design.md, D-7) ---

/** D-7: how long a finished practice sitting's attempt is kept. */
export const PRACTICE_RETENTION_DAYS = 7;

/** The `attempt_deletions.deleted_by_sub` of a sweep delete. */
export const PRACTICE_SWEEP_ACTOR = "system:practice-sweep";

export interface PracticeSweepCounts {
  practice_attempts_deleted: number;
  practice_sittings_archived: number;
  /** Stored drawing / upload objects of the deleted attempts. Their rows are
   * gone with the attempt; the bytes are deleted only when the caller passes
   * `deleteStored` (see `deleteAttemptRecord` for why the sweep cannot import
   * the storage provider itself). */
  practice_uploads: number;
  practice_uploads_deleted: number;
}

/**
 * D-7: practice never accumulates. For every un-archived practice sitting that
 * closed or expired more than `retentionDays` ago, delete the practice
 * attempts bound to it — through `deleteAttemptRecord`, the same path
 * "Practice again" and the Delete button take, so upload rows, cascades and
 * the audit row all match — and archive the sitting. The stored bytes go
 * through `deleteStored` when given, best-effort, after each commit.
 *
 * "Closed" has no timestamp of its own: a closed sitting's `updated_at` is
 * when it was closed (the close route and `sweepExpired` both set it), and an
 * expired one's `expires_at` is when it ended — whichever came first counts.
 * An in-progress practice attempt resumed through a LATER practice sitting has
 * been rebound there (finding 8.2) and waits for that sitting's turn.
 *
 * Only `kind = 'practice'` rows and `practice = true` attempts are ever read
 * here; a class sitting or a student's attempt cannot reach the delete.
 */
export async function sweepPracticeSittings(
  db: Db,
  now: Date = new Date(),
  retentionDays: number = PRACTICE_RETENTION_DAYS,
  deleteStored?: (upload: StoredUploadRef) => Promise<void>,
): Promise<PracticeSweepCounts> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const due = await db
    .select({ id: test_sessions.id })
    .from(test_sessions)
    .where(
      and(
        eq(test_sessions.kind, "practice"),
        isNull(test_sessions.archived_at),
        or(
          lt(test_sessions.expires_at, cutoff),
          and(eq(test_sessions.status, "closed"), lt(test_sessions.updated_at, cutoff)),
        ),
      ),
    );

  let deleted = 0;
  let uploadCount = 0;
  let uploadsDeleted = 0;
  for (const sitting of due) {
    const bound = await db
      .select()
      .from(attempts)
      .where(and(eq(attempts.test_session_id, sitting.id), eq(attempts.practice, true)));
    for (const attempt of bound) {
      const uploads = await deleteAttemptRecord(db, attempt, PRACTICE_SWEEP_ACTOR);
      deleted++;
      uploadCount += uploads.length;
      if (!deleteStored) continue;
      for (const upload of uploads) {
        try {
          await deleteStored(upload);
          uploadsDeleted++;
        } catch {
          // Best-effort, as in the route: an orphaned object is harmless.
        }
      }
    }
    await db
      .update(test_sessions)
      .set({ status: "closed", archived_at: now, updated_at: now })
      .where(eq(test_sessions.id, sitting.id));
  }

  return {
    practice_attempts_deleted: deleted,
    practice_sittings_archived: due.length,
    practice_uploads: uploadCount,
    practice_uploads_deleted: uploadsDeleted,
  };
}
