import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { attempts, test_sessions } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import {
  extendAttempt,
  extendBodyFields,
  hasExactlyOneTarget,
  toExtendTarget,
  type ExtendTarget,
} from "@/lib/api/extendAttempt";
import { UUID_RE } from "@/lib/uuid";
import { authorizeSitting } from "@/lib/api/access";

interface RouteContext {
  params: Promise<{ sessionId: string }>;
}

const Body = z.object({
  ...extendBodyFields,
  /** The Monitor's checked students (2026-09-24). Absent = the whole sitting. */
  attempt_ids: z.array(z.string().regex(UUID_RE)).min(1).optional(),
});

/**
 * Give a whole room more time — the per-attempt extension applied to a sitting.
 *
 * The unit is the SITTING, not the assessment, for the reason "Hand in everyone
 * now" gives: a teacher's decision that this class needs another twenty minutes
 * is a decision about the room in front of them, and an assessment-wide sweep
 * would move another period's deadlines too. Attempts on the same assessment
 * with no `test_session_id` (the `--token` dev posture, the seeder) are
 * therefore never touched.
 *
 * Owner-only through `authorizeSitting` — the same check and the same 404 as
 * Close and Hand in everyone, so a caller cannot learn that someone else's
 * sitting exists.
 *
 * The sitting's state is deliberately NOT a condition. Open, closed or expired,
 * every `in_progress` attempt on it is extended: the case this exists for is
 * precisely "today's period ended and these three students finish tomorrow",
 * and refusing on a closed sitting would refuse exactly that. (A submitted
 * attempt is skipped — there is nothing left to give time to.)
 *
 * Idempotent by construction twice over: only `in_progress` rows are selected,
 * and the override replaces rather than accumulates, so a second press with the
 * same instant leaves every deadline where the first press put it.
 *
 * Sequential, not parallel, and one attempt's failure is its own — the same
 * posture as the sitting-wide hand-in: a row that disappears under us must not
 * cost the rest of the class their extra time.
 *
 * Remove time limit + Monitor checkboxes (2026-09-24). The body is `ends_at`
 * XOR `no_limit: true` (both or neither → `invalid_body`), plus an optional
 * `attempt_ids`:
 *   - WITH `attempt_ids` (the Monitor's "Adjust time for selected"): only
 *     those in-progress attempts that are ON THIS SITTING are touched — an id
 *     from another sitting is skipped, never adjusted, because authorization
 *     was decided on this sitting alone — and the sitting's own flag is left
 *     as it is.
 *   - WITHOUT (the whole session): every in-progress attempt, as before, AND
 *     the sitting's `time_limit_removed` follows the choice — set by
 *     `no_limit` so students who join later have no limit either (the join
 *     path copies it, `applySittingNoLimit`), cleared by `ends_at` so later
 *     joiners go back to the assessment's own limit.
 * `skipped` counts the submitted rows plus any requested id that was not an
 * in-progress attempt on this sitting.
 */
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { sessionId } = await ctx.params;
  if (!UUID_RE.test(sessionId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const access = await authorizeSitting(db, auth.session, sessionId, "run");
  if (!access.ok) return access.response;
  const sitting = access.sitting;

  let target: ExtendTarget;
  let attemptIds: string[] | undefined;
  try {
    const body = Body.parse(await req.json());
    if (!hasExactlyOneTarget(body)) throw new Error("ends_at xor no_limit");
    target = toExtendTarget(body);
    attemptIds = body.attempt_ids;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const now = new Date();
  if ("endsAt" in target && target.endsAt.getTime() <= now.getTime()) {
    return NextResponse.json({ ok: false, error: "ends_at_past" }, { status: 400 });
  }

  const onSitting = await db
    .select()
    .from(attempts)
    .where(eq(attempts.test_session_id, sitting.id))
    .orderBy(asc(attempts.started_at));

  // Selected students: the requested ids narrowed to this sitting's rows. An
  // id that names nothing here (another sitting's attempt, a stale row, a
  // typo) is counted as skipped rather than refused — the rest of the
  // selection still gets its time.
  const requested = attemptIds ? new Set(attemptIds) : null;
  const inScope = requested ? onSitting.filter((a) => requested.has(a.id)) : onSitting;

  const extended: { attempt_id: string }[] = [];
  let skipped = requested ? requested.size - inScope.length : 0;
  for (const attempt of inScope) {
    if (attempt.status !== "in_progress") {
      skipped++;
      continue;
    }
    const { attempt: row } = await extendAttempt(db, attempt, auth.session.sub, target, now);
    extended.push({ attempt_id: row.id });
  }

  // Whole sitting only: the flag later joiners inherit.
  if (!requested) {
    await db
      .update(test_sessions)
      .set({ time_limit_removed: "noLimit" in target, updated_at: now })
      .where(eq(test_sessions.id, sitting.id));
  }

  return NextResponse.json({
    ok: true,
    extended: extended.length,
    skipped,
    attempts: extended,
  });
}
