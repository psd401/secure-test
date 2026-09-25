import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { attempts, items, responses } from "@/db/schema";
import { log, truncate } from "@/lib/log";
import { getScreeningProvider } from "./provider";
import { screenResponse, type ScreeningDeps } from "./screen";

// Safeguarding alerts, the retry (docs/safeguarding-alerts-design.md; 9.1 = A,
// James 2026-09-25): a timer inside the app, not the roster-sync Lambda — the
// Lambda sits in isolated subnets with no route to Bedrock. Picks up every
// handed-in essay / short-text answer the hand-in pass missed (a Bedrock
// failure, a restart before `after()` ran) or that was never screened because
// it was handed in before screening shipped.

type Db = ReturnType<typeof getDb>;

/** Hand-ins within this window are retried — the whole pilot (from 2026-09-17). */
export const RETRY_WINDOW_DAYS = 14;
/** Leave the hand-in's own `after()` pass time to finish first. */
export const RETRY_GRACE_MS = 10 * 60_000;
/** Bounded per run so a backlog spreads over a few hours. */
export const RETRY_BATCH = 200;
export const RETRY_INTERVAL_MS = 60 * 60_000;

export interface RetrySummary {
  candidates: number;
  screened: number;
  failed: number;
  alerts: number;
}

export async function screenPending(
  db: Db,
  now: Date = new Date(),
  deps: ScreeningDeps = {},
): Promise<RetrySummary> {
  const summary: RetrySummary = { candidates: 0, screened: 0, failed: 0, alerts: 0 };
  const screener = deps.screener !== undefined ? deps.screener : getScreeningProvider();
  if (!screener) return summary;
  const rows = await db
    .select({ id: responses.id })
    .from(responses)
    .innerJoin(attempts, eq(attempts.id, responses.attempt_id))
    .innerJoin(items, eq(items.id, responses.item_id))
    .where(
      and(
        eq(attempts.status, "submitted"),
        eq(attempts.practice, false),
        gt(attempts.submitted_at, new Date(now.getTime() - RETRY_WINDOW_DAYS * 86_400_000)),
        lt(attempts.submitted_at, new Date(now.getTime() - RETRY_GRACE_MS)),
        inArray(items.type, ["essay", "short_text"]),
        or(
          isNull(responses.safeguarding_screened_at),
          lt(responses.safeguarding_screened_at, responses.updated_at),
        ),
      ),
    )
    .orderBy(sql`${attempts.submitted_at} asc`)
    .limit(RETRY_BATCH);
  summary.candidates = rows.length;
  for (const { id } of rows) {
    const r = await screenResponse(db, id, { ...deps, screener });
    summary.screened += r.screened;
    summary.failed += r.failed;
    summary.alerts += r.alerts;
  }
  return summary;
}

let started = false;
let running = false;

/**
 * Starts the hourly retry once per process (instrumentation.ts `register`).
 * A no-op when screening is off. Runs never overlap; the timer is unref'd so
 * it never holds the process open.
 */
export function startScreeningRetry(): void {
  if (started) return;
  started = true;
  let enabled = false;
  try {
    enabled = getScreeningProvider() !== null;
  } catch (err) {
    log.error("safeguarding_retry_failed", {
      message: truncate(err instanceof Error ? err.message : String(err)),
    });
  }
  if (!enabled) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const s = await screenPending(getDb());
      if (s.candidates > 0) log.info("safeguarding_retry", { ...s });
    } catch (err) {
      log.error("safeguarding_retry_failed", {
        message: truncate(err instanceof Error ? err.message : String(err)),
      });
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), 5 * 60_000).unref();
  setInterval(() => void tick(), RETRY_INTERVAL_MS).unref();
}
