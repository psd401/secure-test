/**
 * The teacher's time extension, as one operation on one attempt.
 *
 * Shaped like `lib/api/handInAttempt.ts` and for the same reason: two callers
 * (the per-attempt route and the sitting-wide one) have to do the identical
 * thing, and two copies of "what extending means" would drift until one of
 * them stopped writing the `deadline_extended` row and nobody could tell a
 * family why a child was still writing forty minutes after the buzzer.
 *
 * Deliberately NOT included here: the refusals. Whether this attempt may be
 * extended at all — owner, status, an instant that is actually in the future —
 * is the caller's decision, because the two callers answer it differently (one
 * 409s, the other skips the row and carries on). This function is the write.
 *
 * `deadline_override_at` REPLACES the computed deadline rather than adding to
 * it (see the column's comment in db/schema.ts), so re-applying the same
 * instant is a no-op in effect: the row is written again and a second event
 * recorded, but the deadline does not move. That makes the sitting-wide caller
 * safely idempotent — a teacher pressing "extend to 10:45" twice gets 10:45.
 * The same holds for "No time limit" (2026-09-24): pressing it twice leaves
 * the attempt removed.
 *
 * "+N minutes" (working-time clock, D3) is the exception: it ADDS to
 * `extension_seconds`, so pressing it twice adds twice — what the teacher's
 * words say. The dialog disables its button while the request is in flight.
 */

import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  attempt_events,
  attempts,
  type AttemptRow,
  type TestSessionRow,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import { extensionForEndTime, isWorkingTimeLimit, loadTimeLimit } from "@/lib/api/attemptDeadline";

type Db = ReturnType<typeof getDb>;

export interface ExtendResult {
  attempt: AttemptRow;
}

/**
 * What the teacher chose (Remove time limit, 2026-09-24): a new absolute
 * deadline, or no limit at all. The two are exclusive on the row — a deadline
 * clears the removal, a removal clears the override — so the attempt never
 * carries two answers and `deadlineFor` never has to rank them in practice
 * (it does anyway: the removal wins).
 */
export type ExtendTarget = { endsAt: Date } | { noLimit: true } | { addSeconds: number };

/**
 * Working-time clock (docs/working-time-clock-design.md, D3): the most a
 * teacher can add in one press — a school day. A bigger number is a typo.
 */
export const MAX_ADD_MINUTES = 600;

/** "+N minutes": a whole number of minutes, 1…MAX_ADD_MINUTES. */
export const AddMinutes = z.number().int().min(1).max(MAX_ADD_MINUTES);

/**
 * The two routes' shared body fields: `ends_at` XOR `no_limit: true`. The
 * sitting route extends this with `attempt_ids`. `ends_at` is an ABSOLUTE
 * instant — "this student finishes at 10:45" — not a number of extra minutes:
 * the teacher's UI does the arithmetic; the server stores the answer, so
 * nothing has to re-derive it from a limit that may change.
 */
export const extendBodyFields = {
  ends_at: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), {
      message: "ends_at must be a parseable date",
    })
    .optional(),
  no_limit: z.literal(true).optional(),
  /** Working-time clock (D3): minutes added to this student's limit. */
  add_minutes: AddMinutes.optional(),
};

interface ExtendBody {
  ends_at?: string;
  no_limit?: true;
  add_minutes?: number;
}

/** Exactly one of `ends_at`, `no_limit`, `add_minutes`; anything else is
 * `invalid_body`, not a guess. */
export function hasExactlyOneTarget(body: ExtendBody): boolean {
  const present = [body.ends_at, body.no_limit, body.add_minutes].filter((v) => v !== undefined);
  return present.length === 1;
}

/** The parsed body as an `ExtendTarget`; call after `hasExactlyOneTarget`. */
export function toExtendTarget(body: ExtendBody): ExtendTarget {
  if (body.no_limit) return { noLimit: true };
  if (body.add_minutes !== undefined) return { addSeconds: body.add_minutes * 60 };
  return { endsAt: new Date(Date.parse(body.ends_at!)) };
}

/**
 * Working-time clock (D3): "+N minutes" only means something on a
 * working-time limit — a wall-clock test or an untimed one has no clock to add
 * to, and keeps "until 10:45". The routes refuse the mismatch with
 * `add_minutes_needs_working_time` rather than guessing an end time.
 */
export function targetFitsClock(
  target: ExtendTarget,
  timeLimit: Parameters<typeof isWorkingTimeLimit>[0] | null,
): boolean {
  if (!("addSeconds" in target)) return true;
  return timeLimit !== null && isWorkingTimeLimit(timeLimit);
}

export async function extendAttempt(
  db: Db,
  attempt: AttemptRow,
  staffSub: string,
  target: ExtendTarget,
  now: Date = new Date(),
): Promise<ExtendResult> {
  if ("addSeconds" in target) {
    // Working-time clock (D3): added to what the student already has, in the
    // UPDATE itself so two presses add twice rather than racing. Adding time
    // also puts a removed limit back, as an end time does.
    // One transaction: added time with no audit row is the one outcome the
    // event exists to prevent (#253 review).
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(attempts)
        .set({
          extension_seconds: sql`${attempts.extension_seconds} + ${target.addSeconds}`,
          time_limit_removed: false,
          updated_at: now,
        })
        .where(eq(attempts.id, attempt.id))
        .returning();
      await tx.insert(attempt_events).values({
        attempt_id: attempt.id,
        kind: "deadline_extended",
        at: now,
        detail: { add_seconds: target.addSeconds, by: staffSub },
      });
      return { attempt: row! };
    });
  }
  const noLimit = "noLimit" in target;
  // Working-time clock (docs/working-time-clock-design.md, D3; slice 1
  // compatibility): on a working-time test the end time becomes extra
  // seconds on the limit. The end time is still stored, so the row says what
  // the teacher chose and a switch back to wall clock keeps it.
  const timeLimit = noLimit ? null : await loadTimeLimit(db, attempt);
  const extension =
    !noLimit && timeLimit && isWorkingTimeLimit(timeLimit)
      ? extensionForEndTime(attempt, timeLimit, target.endsAt, now)
      : null;
  const [row] = await db
    .update(attempts)
    .set(
      noLimit
        ? { time_limit_removed: true, deadline_override_at: null, updated_at: now }
        : {
            deadline_override_at: target.endsAt,
            time_limit_removed: false,
            ...(extension !== null ? { extension_seconds: extension } : {}),
            updated_at: now,
          },
    )
    .where(eq(attempts.id, attempt.id))
    .returning();

  // The audit trail: the integrity timeline says the teacher moved this
  // student's deadline, and to when — or removed it (`no_limit`, the same
  // event kind so the CHECK on `attempt_events.kind` needs no change). `by`
  // is the staff sub, matching how `attempts.submitted_by_sub` records the
  // forced hand-in — the timeline renders the words, not the sub, but the
  // row has to be able to answer "who" months later.
  await db.insert(attempt_events).values({
    attempt_id: attempt.id,
    kind: "deadline_extended",
    at: now,
    detail: noLimit
      ? { no_limit: true, by: staffSub }
      : {
          ends_at: target.endsAt.toISOString(),
          by: staffSub,
          ...(extension !== null ? { extension_seconds: extension } : {}),
        },
  });

  return { attempt: row! };
}

/**
 * Later joiners (Remove time limit, 2026-09-24): a student who joins — or
 * resumes through — a sitting whose whole-sitting "No time limit" is on gets
 * it on their attempt too, with the same `deadline_extended` `{ no_limit }`
 * event a teacher press writes. Called by `POST /api/attempts` for both a new
 * and a resumed attempt, AFTER the finding-8.2 rebind.
 *
 * `by` is the sitting's `created_by_sub`, falling back to its `owner_sub` for
 * a sitting made before that column existed: the sitting row does not record
 * who pressed "No time limit", and the person who ran the sitting is the
 * closest honest answer the row has. The event's time is the join, not the
 * press — the press has its own events on the attempts that were in progress
 * at the time.
 *
 * A no-op (returns the attempt as given) unless the sitting is flagged, the
 * attempt is still in progress, and it is not already removed — so a student
 * who rejoins the same flagged sitting does not gain a second event.
 */
export async function applySittingNoLimit(
  db: Db,
  attempt: AttemptRow,
  sitting: Pick<TestSessionRow, "time_limit_removed" | "created_by_sub" | "owner_sub">,
  now: Date = new Date(),
): Promise<AttemptRow> {
  if (
    !sitting.time_limit_removed ||
    attempt.status !== "in_progress" ||
    attempt.time_limit_removed
  ) {
    return attempt;
  }
  const by = sitting.created_by_sub ?? sitting.owner_sub;
  const { attempt: row } = await extendAttempt(db, attempt, by, { noLimit: true }, now);
  return row;
}
