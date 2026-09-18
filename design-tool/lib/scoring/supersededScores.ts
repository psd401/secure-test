/**
 * The scores an attempt was given BEFORE it was passed back
 * (docs/pass-back-design.md, D-2) — the rows behind slice 2's "Earlier scores
 * (before pass back)" section on the per-student page.
 *
 * This is the ONLY reader of `status = 'superseded'`. Everything else — the
 * results matrix, the CSV, the print report, the work packet, the review queue,
 * `runAutoScoringPass` — keys on `final` and therefore cannot see these rows,
 * which is the whole point of the status: the number is kept as a record without
 * being the score.
 *
 * No supersession INSTANT is returned, because the table has none: `scores` is
 * append-only by design and carries `created_at` alone (no `updated_at`), and
 * the pass back flips the status in place. `created_at` below is therefore when
 * the score was ORIGINALLY given, not when it was set aside; the instant it was
 * set aside is on the attempt's `passed_back` event, which the per-student page
 * already reads for its timeline.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { responses, scores } from "@/db/schema";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

export interface SupersededScore {
  response_id: string;
  item_id: string;
  points: number;
  max: number;
  method: string;
  scorer: string;
  /** When the score was given (see the note above — NOT when it was superseded). */
  created_at: Date;
}

export async function listSupersededScores(
  db: Db,
  attemptId: string,
): Promise<SupersededScore[]> {
  const responseRows = await db
    .select({ id: responses.id, item_id: responses.item_id })
    .from(responses)
    .where(eq(responses.attempt_id, attemptId));
  if (responseRows.length === 0) return [];

  const itemByResponse = new Map(responseRows.map((r) => [r.id, r.item_id]));

  const rows = await db
    .select({
      response_id: scores.response_id,
      points: scores.points,
      max: scores.max_points,
      method: scores.method,
      scorer: scores.scorer,
      created_at: scores.created_at,
    })
    .from(scores)
    .where(
      and(
        inArray(
          scores.response_id,
          responseRows.map((r) => r.id),
        ),
        eq(scores.status, "superseded"),
      ),
    )
    // A response can carry several superseded rows once an attempt has been
    // passed back twice, so the list is a history, oldest first.
    .orderBy(asc(scores.created_at));

  return rows
    .filter((row) => itemByResponse.has(row.response_id))
    .map((row) => ({ ...row, item_id: itemByResponse.get(row.response_id)! }));
}
