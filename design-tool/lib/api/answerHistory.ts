// Answer history (docs/answer-history-design.md, roadmap U-19).
//
// The student write routes overwrite a `responses` row on every autosave, so
// an earlier value is gone the moment a new one lands. Before each write of a
// TEXT answer, this copies the value being replaced into `response_revisions`
// when the D-2 rule says to keep it:
//
//   - always when the answer is withdrawn (DELETE) — `withdrawn`;
//   - always when the new value is under half the old one's length (empty
//     included) — `shrink`, the accidental select-all-and-delete case;
//   - otherwise at most once a minute per answer — `interval`.
//
// A blank old value is never kept (nothing to recover), nor an unchanged one.
// The read and the insert run inside the caller's transaction, beside the
// write they precede.

import { and, desc, eq } from "drizzle-orm";
import type { ItemResponse } from "@secure-test/schema";
import type { getDb } from "@/db/client";
import {
  response_revisions,
  responses,
  type ResponseRevisionReason,
} from "@/db/schema";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The item types whose answers have history (the note's Scope). */
export const HISTORY_ITEM_TYPES: ReadonlySet<string> = new Set([
  "essay",
  "short_text",
  "table",
]);

/** D-2: the once-a-minute floor between `interval` copies of one answer. */
export const HISTORY_INTERVAL_MS = 60_000;

/**
 * Characters in a text answer: the text for essay / short text, the sum of the
 * cell texts for a table. Anything else (or a malformed value) is 0.
 */
export function answerLength(response: unknown): number {
  if (!response || typeof response !== "object") return 0;
  const r = response as { text?: unknown; cells?: unknown };
  if (typeof r.text === "string") return r.text.length;
  if (r.cells && typeof r.cells === "object") {
    let total = 0;
    for (const row of Object.values(r.cells as Record<string, unknown>)) {
      if (!row || typeof row !== "object") continue;
      for (const cell of Object.values(row as Record<string, unknown>)) {
        if (typeof cell === "string") total += cell.length;
      }
    }
    return total;
  }
  return 0;
}

/**
 * Whether the value being replaced is kept, and why. Pure, so the rule is
 * tested without a database. `next` is null for a withdrawal.
 */
export function captureReason(
  previous: unknown,
  next: unknown | null,
  lastCapturedAt: Date | null,
  now: Date,
): ResponseRevisionReason | null {
  const oldLength = answerLength(previous);
  if (oldLength === 0) return null;
  if (next === null) return "withdrawn";
  if (JSON.stringify(previous) === JSON.stringify(next)) return null;
  if (answerLength(next) * 2 < oldLength) return "shrink";
  if (
    lastCapturedAt === null ||
    now.getTime() - lastCapturedAt.getTime() >= HISTORY_INTERVAL_MS
  ) {
    return "interval";
  }
  return null;
}

/**
 * Keep the current value of (attempt, item) in history if D-2 says so, before
 * the caller overwrites (`next` = the new value) or withdraws (`next` = null)
 * it. A no-op for item types without history and for an answer not yet saved.
 */
export async function captureBeforeWrite(
  tx: Db | Tx,
  attemptId: string,
  item: { id: string; type: string },
  next: ItemResponse | null,
  now: Date = new Date(),
): Promise<ResponseRevisionReason | null> {
  if (!HISTORY_ITEM_TYPES.has(item.type)) return null;

  const [current] = await tx
    .select({ response: responses.response, updated_at: responses.updated_at })
    .from(responses)
    .where(and(eq(responses.attempt_id, attemptId), eq(responses.item_id, item.id)))
    .limit(1);
  if (!current) return null;

  const [last] = await tx
    .select({ captured_at: response_revisions.captured_at })
    .from(response_revisions)
    .where(
      and(
        eq(response_revisions.attempt_id, attemptId),
        eq(response_revisions.item_id, item.id),
      ),
    )
    .orderBy(desc(response_revisions.captured_at))
    .limit(1);

  const reason = captureReason(current.response, next, last?.captured_at ?? null, now);
  if (!reason) return null;

  await tx.insert(response_revisions).values({
    attempt_id: attemptId,
    item_id: item.id,
    response: current.response,
    saved_at: current.updated_at,
    captured_at: now,
    reason,
  });
  return reason;
}

/** One earlier version, as the per-student page lists it. */
export interface AnswerRevisionView {
  id: string;
  item_id: string;
  response: ItemResponse;
  saved_at: Date;
  reason: ResponseRevisionReason;
}

/**
 * Every kept version for one attempt, grouped by item, newest saved first.
 * The caller has already checked edit level (D-4).
 */
export async function listAnswerHistory(
  db: Db,
  attemptId: string,
): Promise<Map<string, AnswerRevisionView[]>> {
  const rows = await db
    .select({
      id: response_revisions.id,
      item_id: response_revisions.item_id,
      response: response_revisions.response,
      saved_at: response_revisions.saved_at,
      reason: response_revisions.reason,
    })
    .from(response_revisions)
    .where(eq(response_revisions.attempt_id, attemptId))
    .orderBy(desc(response_revisions.saved_at), desc(response_revisions.captured_at));
  const byItem = new Map<string, AnswerRevisionView[]>();
  for (const row of rows) {
    const list = byItem.get(row.item_id);
    if (list) list.push(row);
    else byItem.set(row.item_id, [row]);
  }
  return byItem;
}
