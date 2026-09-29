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
 *
 * Change a final score (docs/change-score-design.md, D-1) is the second way a
 * row becomes superseded, so each row now says WHY: `cause: "changed"` when a
 * later score on the same response names it in `rationale.changed_from.score_id`
 * (that later row is `replaced_by` — itself final, or superseded in turn by a
 * further change or a pass back), else `"pass_back"`, the only other writer of
 * the status. The link is read off the scores themselves, so the cause needs no
 * column and no event join.
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
  /** Why the row stopped being the score. */
  cause: "pass_back" | "changed";
  /** The score that replaced this one, present only when `cause` is "changed". */
  replaced_by?: { points: number; note?: string; created_at: Date };
}

/** `rationale.changed_from.score_id`, or null for any other rationale shape. */
function changedFromId(rationale: unknown): string | null {
  if (!rationale || typeof rationale !== "object") return null;
  const from = (rationale as { changed_from?: unknown }).changed_from;
  if (!from || typeof from !== "object") return null;
  const id = (from as { score_id?: unknown }).score_id;
  return typeof id === "string" ? id : null;
}

function noteOf(rationale: unknown): string | undefined {
  if (!rationale || typeof rationale !== "object") return undefined;
  const note = (rationale as { note?: unknown }).note;
  return typeof note === "string" && note ? note : undefined;
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
      id: scores.id,
      response_id: scores.response_id,
      points: scores.points,
      max: scores.max_points,
      method: scores.method,
      scorer: scores.scorer,
      status: scores.status,
      rationale: scores.rationale,
      created_at: scores.created_at,
    })
    .from(scores)
    .where(
      and(
        inArray(
          scores.response_id,
          responseRows.map((r) => r.id),
        ),
        // The replacements are read alongside: a changed score's successor is a
        // `final`, or `superseded` when it was changed again or passed back.
        inArray(scores.status, ["superseded", "final"]),
      ),
    )
    // A response can carry several superseded rows once an attempt has been
    // passed back twice, so the list is a history, oldest first.
    .orderBy(asc(scores.created_at));

  // Successor by the id it replaced. Scoped to the same response so a stray
  // rationale can never attach one response's correction to another's row.
  const successorOf = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const fromId = changedFromId(row.rationale);
    if (fromId) successorOf.set(`${row.response_id}:${fromId}`, row);
  }

  return rows
    .filter((row) => row.status === "superseded" && itemByResponse.has(row.response_id))
    .map((row) => {
      const next = successorOf.get(`${row.response_id}:${row.id}`);
      const base: SupersededScore = {
        response_id: row.response_id,
        item_id: itemByResponse.get(row.response_id)!,
        points: row.points,
        max: row.max,
        method: row.method,
        scorer: row.scorer,
        created_at: row.created_at,
        cause: next ? "changed" : "pass_back",
      };
      if (next) {
        const note = noteOf(next.rationale);
        base.replaced_by = {
          points: next.points,
          ...(note ? { note } : {}),
          created_at: next.created_at,
        };
      }
      return base;
    });
}
