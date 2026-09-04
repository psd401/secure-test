import { eq, inArray, and } from "drizzle-orm";
import { ItemResponseSchema } from "@secure-test/schema";
import type { getDb } from "@/db/client";
import { items, responses, scores, type ItemType, type ScoreInsert } from "@/db/schema";
import { effectiveScoringMethod } from "@/lib/api/items";
import { scoreResponse } from "@/lib/scoring/auto";

type Db = ReturnType<typeof getDb>;

export type AutoScoringSummary = {
  scored: number;
  already_scored: number;
  skipped_not_auto: number;
  skipped_unscorable: number;
  total_responses: number;
};

// R0.1: the idempotent auto-scoring pass, shared by the teacher-facing
// re-run (score/route.ts, slice 37) and the student's own hand-in
// (submit/route.ts). Only items whose effective scoring method is "auto"
// are touched; a response that already has a final score is skipped, never
// re-scored. See lib/scoring/auto.ts for the per-item scoring rules.
export async function runAutoScoringPass(
  db: Db,
  attempt: { id: string; assessment_id: string },
): Promise<AutoScoringSummary> {
  const itemRows = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, attempt.assessment_id));
  const itemsById = new Map(itemRows.map((i) => [i.id, i]));

  const responseRows = await db
    .select()
    .from(responses)
    .where(eq(responses.attempt_id, attempt.id));

  const alreadyFinal = new Set<string>();
  if (responseRows.length > 0) {
    const finalRows = await db
      .select({ response_id: scores.response_id })
      .from(scores)
      .where(
        and(
          inArray(
            scores.response_id,
            responseRows.map((r) => r.id),
          ),
          eq(scores.status, "final"),
        ),
      );
    for (const row of finalRows) alreadyFinal.add(row.response_id);
  }

  let scored = 0;
  let alreadyScored = 0;
  let skippedNotAuto = 0;
  let skippedUnscorable = 0;
  const inserts: ScoreInsert[] = [];

  for (const response of responseRows) {
    const item = itemsById.get(response.item_id);
    if (!item) {
      skippedUnscorable++;
      continue;
    }
    if (effectiveScoringMethod(item.type as ItemType, item.config) !== "auto") {
      skippedNotAuto++;
      continue;
    }
    if (alreadyFinal.has(response.id)) {
      alreadyScored++;
      continue;
    }
    // Defensive parse: the column is typed, but scoring must not crash on
    // a bad row — count it and move on.
    const parsed = ItemResponseSchema.safeParse(response.response);
    if (!parsed.success) {
      skippedUnscorable++;
      continue;
    }
    const result = scoreResponse(item, parsed.data);
    if (!result) {
      skippedUnscorable++;
      continue;
    }
    inserts.push({
      response_id: response.id,
      method: "auto",
      points: result.points,
      max_points: result.max_points,
      rationale: null,
      scorer: "auto",
      status: "final",
    });
    scored++;
  }

  if (inserts.length > 0) {
    // Review fix (2026-08-14): the check-then-insert above races with a
    // concurrent scoring request — the one-final-per-response partial
    // unique index would 500 the whole batch. Lost races count as
    // already-scored, not scored.
    const inserted = await db
      .insert(scores)
      .values(inserts)
      .onConflictDoNothing()
      .returning({ id: scores.id });
    const lostRaces = inserts.length - inserted.length;
    scored -= lostRaces;
    alreadyScored += lostRaces;
  }

  return {
    scored,
    already_scored: alreadyScored,
    skipped_not_auto: skippedNotAuto,
    skipped_unscorable: skippedUnscorable,
    total_responses: responseRows.length,
  };
}
