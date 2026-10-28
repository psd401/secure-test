import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import {
  items,
  responses,
  safeguarding_alerts,
  scores,
  type ItemRow,
  type ItemType,
} from "@/db/schema";
import { effectiveScoringMethod } from "@/lib/api/items";

type Db = ReturnType<typeof getDb>;

// Score a section's essays with AI in one press (roadmap U-24,
// docs/batch-ai-scoring-design.md slice 1). The Results page counts, per
// handed-in attempt, the essays the attempt-wide score-ai route would send to
// the scorer, so the button's (n) is what a press will do. The route stays the
// authority: it skips the same rows and also withholds answers that its own
// lazy screening flags at press time.

/** AI short answer (2026-10-27): the item types the AI scorer reads. Shared
 * with aiScoreResponse and the score-ai route's isAiEligible, so the (n)
 * and the route agree. */
export const AI_SCORED_TYPES: ReadonlySet<string> = new Set(["essay", "short_text"]);

/** An essay or short answer the AI scorer takes: ai / hybrid, with a rubric
 * to score against. */
export function isAiBatchItem(item: Pick<ItemRow, "type" | "config">): boolean {
  if (!AI_SCORED_TYPES.has(item.type)) return false;
  const method = effectiveScoringMethod(item.type as ItemType, item.config);
  return (
    (method === "ai" || method === "hybrid") && Boolean(item.config?.rubric)
  );
}

export type AiBatchCounts = {
  /** Whether the assessment has any essay the AI scorer takes at all. */
  has_ai_items: boolean;
  /** Per attempt id; attempts with nothing to score are absent. */
  counts: Map<string, number>;
};

/**
 * Per attempt id: essays still waiting for an AI score. An essay counts when
 * its item is an AI batch item, its text is not blank, it has no score row
 * (research rows excepted, as in the route) and no unforced prompt-injection
 * alert.
 */
export async function aiBatchCounts(
  db: Db,
  assessmentId: string,
  attemptIds: string[],
): Promise<AiBatchCounts> {
  const counts = new Map<string, number>();

  const itemRows = await db
    .select({ id: items.id, type: items.type, config: items.config })
    .from(items)
    .where(eq(items.assessment_id, assessmentId));
  const itemIds = itemRows.filter(isAiBatchItem).map((i) => i.id);
  if (itemIds.length === 0) return { has_ai_items: false, counts };
  if (attemptIds.length === 0) return { has_ai_items: true, counts };

  // Only ids leave the database: an essay counts when its text has a
  // non-space character (the scorer's own `text.trim()` empty check), so the
  // full answers are never loaded to render a count.
  const written = await db
    .select({ id: responses.id, attempt_id: responses.attempt_id })
    .from(responses)
    .where(
      and(
        inArray(responses.attempt_id, attemptIds),
        inArray(responses.item_id, itemIds),
        sql`${responses.response}->>'type' in ('essay', 'short_text')`,
        sql`${responses.response}->>'text' ~ '[^[:space:]]'`,
      ),
    );
  if (written.length === 0) return { has_ai_items: true, counts };
  const ids = written.map((r) => r.id);

  const skip = new Set<string>();
  const scored = await db
    .select({ response_id: scores.response_id })
    .from(scores)
    .where(
      and(inArray(scores.response_id, ids), ne(scores.status, "research")),
    );
  for (const row of scored) skip.add(row.response_id);
  const flagged = await db
    .select({ response_id: safeguarding_alerts.response_id })
    .from(safeguarding_alerts)
    .where(
      and(
        inArray(safeguarding_alerts.response_id, ids),
        eq(safeguarding_alerts.kind, "prompt_injection"),
        isNull(safeguarding_alerts.ai_forced_at),
      ),
    );
  for (const row of flagged) if (row.response_id) skip.add(row.response_id);

  for (const r of written) {
    if (skip.has(r.id)) continue;
    counts.set(r.attempt_id, (counts.get(r.attempt_id) ?? 0) + 1);
  }
  return { has_ai_items: true, counts };
}
