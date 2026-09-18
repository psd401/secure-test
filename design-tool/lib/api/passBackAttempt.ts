/**
 * Pass a handed-in attempt back to the student (docs/pass-back-design.md, D-1).
 *
 * Shaped like `lib/api/extendAttempt.ts` and `lib/api/handInAttempt.ts`: the
 * WRITE lives here, the REFUSALS belong to the caller. Today there is one
 * caller (the per-attempt route), and the split is kept anyway because the
 * sitting-wide shape of every other teacher action on an attempt — hand in,
 * extend — eventually arrived, and a second caller must not fork "what passing
 * back means".
 *
 * One transaction, because the three writes are one fact. A status flip without
 * the score supersession leaves the OLD score sitting on an answer the student
 * is now free to change (`runAutoScoringPass` skips a response that already has
 * a `final`, so the new answer would keep the old number); the supersession
 * without the flip loses the scores for nothing. Neither half is a state a
 * teacher surface could make sense of.
 *
 * `superseded` rather than deleted (D-2): James's "keep the scores as a record".
 * The rows stay, out of the way of every reader that keys on `final`, and the
 * per-student page shows them under "Earlier scores" (slice 2).
 *
 * `proposed` AI rows are deliberately left alone. A proposal on the old answer
 * is still a proposal — the teacher re-runs "Score with AI" if the answer
 * changed — and the one-final-per-response index has no opinion about them.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { attempt_events, attempts, responses, scores, type AttemptRow } from "@/db/schema";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

export interface PassBackOptions {
  /**
   * The attempt's new deadline, or null/undefined for none.
   *
   * Written straight to `deadline_override_at`, which REPLACES the computed
   * deadline (see the column's comment in db/schema.ts) — that is the only
   * reason a passed-back attempt on a timed assessment is writable at all: the
   * old `started_at + time_limit_seconds` is already in the past. Whether an
   * instant is REQUIRED is the caller's call, because only it knows whether
   * the assessment is timed.
   */
  endsAt?: Date | null;
  now?: Date;
}

export interface PassBackResult {
  attempt: AttemptRow;
  /** How many `final` scores became `superseded` — the dialog's "k scores". */
  superseded_scores: number;
}

export async function passBackAttempt(
  db: Db,
  attempt: AttemptRow,
  staffSub: string,
  options: PassBackOptions = {},
): Promise<PassBackResult> {
  const now = options.now ?? new Date();
  const endsAt = options.endsAt ?? null;
  const previouslySubmittedAt = attempt.submitted_at;

  return db.transaction(async (tx) => {
    const responseRows = await tx
      .select({ id: responses.id })
      .from(responses)
      .where(eq(responses.attempt_id, attempt.id));

    let supersededScores = 0;
    if (responseRows.length > 0) {
      // Finals only. `proposed` rows stay proposals and `research` rows belong
      // to the corpus (docs/scoring-corpus-design.md) — neither is the score
      // this student was given, so neither is a record of it.
      const flipped = await tx
        .update(scores)
        .set({ status: "superseded" })
        .where(
          and(
            inArray(
              scores.response_id,
              responseRows.map((r) => r.id),
            ),
            eq(scores.status, "final"),
          ),
        )
        .returning({ id: scores.id });
      supersededScores = flipped.length;
    }

    const [row] = await tx
      .update(attempts)
      .set({
        status: "in_progress",
        // Both cleared: the attempt has not been handed in, and nothing may
        // read a stale "handed in by the teacher at 9:14" off a row that is
        // open again. The instant is preserved on the event's detail instead.
        submitted_at: null,
        submitted_by_sub: null,
        pass_back_count: sql`${attempts.pass_back_count} + 1`,
        // Only when the caller has one: an unlimited assessment must not gain a
        // deadline it never had, and a `null` here would ERASE an extension on
        // a timed one.
        ...(endsAt ? { deadline_override_at: endsAt } : {}),
        updated_at: now,
      })
      .where(eq(attempts.id, attempt.id))
      .returning();

    // The audit trail a family or an administrator may ask about later: who
    // reopened this test, when it had been handed in, how many scores were set
    // aside, and what the student was given instead of the expired deadline.
    await tx.insert(attempt_events).values({
      attempt_id: attempt.id,
      kind: "passed_back",
      at: now,
      detail: {
        by: staffSub,
        previously_submitted_at: previouslySubmittedAt?.toISOString() ?? null,
        superseded_scores: supersededScores,
        ends_at: endsAt?.toISOString() ?? null,
      },
    });

    return { attempt: row!, superseded_scores: supersededScores };
  });
}
