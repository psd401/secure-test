// R1 (docs/reporting-design.md): the one query behind the item-analytics
// footer. Kept out of lib/reporting/ on purpose — everything under there is
// pure so the page and the print view can share it; this is the DB half.
//
// Owner scoping is the CALLER's: the page has already confirmed the session
// owns the assessment, and every row read here hangs off that assessment's
// own attempts. No student identity is read at all — analytics are about the
// items, not the children.

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { attempts, items, responses, scores, type ItemRow } from "@/db/schema";
import { itemMaxPoints } from "@/lib/scoring/results";
import {
  buildItemAnalytics,
  type AnalyticsItem,
  type AnalyticsResponseRow,
  type ItemAnalytics,
} from "@/lib/reporting/analytics";

function toAnalyticsItem(item: ItemRow): AnalyticsItem {
  return {
    id: item.id,
    position: item.position,
    type: item.type,
    max_points: itemMaxPoints(item),
    choices: item.choices as Array<{ id: string; text: string }>,
    correct_choice_ids: item.correct_choice_ids as string[],
  };
}

export async function loadItemAnalytics(assessmentId: string): Promise<{
  analytics: ItemAnalytics[];
  submitted_count: number;
}> {
  const db = getDb();
  const itemRows = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, assessmentId));
  const analyticsItems = itemRows
    .map(toAnalyticsItem)
    .sort((a, b) => a.position - b.position);

  const attemptRows = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(eq(attempts.assessment_id, assessmentId), eq(attempts.status, "submitted")),
    );
  const attemptIds = attemptRows.map((a) => a.id);

  // One pass: every response of every submitted attempt, left-joined to its
  // FINAL score row (there is at most one, enforced by a partial unique
  // index). A proposed AI row never joins, so it arrives as points: null and
  // is never counted — the same rule buildResults applies.
  const rows =
    itemRows.length > 0 && attemptIds.length > 0
      ? await db
          .select({
            item_id: responses.item_id,
            response: responses.response,
            points: scores.points,
          })
          .from(responses)
          .leftJoin(
            scores,
            and(eq(scores.response_id, responses.id), eq(scores.status, "final")),
          )
          .where(inArray(responses.attempt_id, attemptIds))
      : [];

  const analyticsRows: AnalyticsResponseRow[] = rows.map((r) => ({
    item_id: r.item_id,
    response: r.response as unknown as Record<string, unknown>,
    points: r.points ?? null,
  }));

  return {
    analytics: buildItemAnalytics(analyticsItems, analyticsRows, attemptIds.length),
    submitted_count: attemptIds.length,
  };
}
