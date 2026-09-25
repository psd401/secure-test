import { and, desc, eq, isNull } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { safeguarding_alerts, type SafeguardingAlertRow } from "@/db/schema";

// Safeguarding alerts (docs/safeguarding-alerts-design.md): reads and writes
// the AI-scoring routes need for D-4 — a prompt-injection alert withholds the
// AI score until the teacher asks for it anyway.

type Db = ReturnType<typeof getDb>;

/**
 * The newest prompt-injection alert on this answer that the teacher has NOT
 * overridden with Score with AI anyway, or null. Acknowledging an alert does
 * not release the AI score — only the explicit force does (D-4).
 */
export async function injectionAlertFor(
  db: Db,
  responseId: string,
): Promise<SafeguardingAlertRow | null> {
  const [row] = await db
    .select()
    .from(safeguarding_alerts)
    .where(
      and(
        eq(safeguarding_alerts.response_id, responseId),
        eq(safeguarding_alerts.kind, "prompt_injection"),
        isNull(safeguarding_alerts.ai_forced_at),
      ),
    )
    .orderBy(desc(safeguarding_alerts.created_at))
    .limit(1);
  return row ?? null;
}

/**
 * Records the teacher's Score with AI anyway — who and when (D-4). Marks
 * EVERY unforced injection alert on the answer, not only the newest: an
 * acknowledged older alert and a rescreen's newer one are the same concern,
 * and one decision to score should release both.
 */
export async function recordAiForced(
  db: Db,
  responseId: string,
  sub: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(safeguarding_alerts)
    .set({ ai_forced_at: now, ai_forced_by_sub: sub })
    .where(
      and(
        eq(safeguarding_alerts.response_id, responseId),
        eq(safeguarding_alerts.kind, "prompt_injection"),
        isNull(safeguarding_alerts.ai_forced_at),
      ),
    );
}
