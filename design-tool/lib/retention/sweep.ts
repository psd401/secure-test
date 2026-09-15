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

import { lt } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { client_error_events, guardrail_events, server_error_events } from "@/db/schema";

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
