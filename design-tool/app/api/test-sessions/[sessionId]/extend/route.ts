import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { attempts, test_sessions } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { extendAttempt } from "@/lib/api/extendAttempt";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ sessionId: string }>;
}

const Body = z.object({
  ends_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "ends_at must be a parseable date",
  }),
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
 * Owner-only, decided by the sitting's own `owner_sub` — the same check and the
 * same 404 as Close and Hand in everyone, so a caller cannot learn that someone
 * else's sitting exists.
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
 */
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { sessionId } = await ctx.params;
  if (!UUID_RE.test(sessionId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const [sitting] = await db
    .select()
    .from(test_sessions)
    .where(
      and(eq(test_sessions.id, sessionId), eq(test_sessions.owner_sub, auth.session.sub)),
    )
    .limit(1);
  if (!sitting) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  let endsAt: Date;
  try {
    endsAt = new Date(Date.parse(Body.parse(await req.json()).ends_at));
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const now = new Date();
  if (endsAt.getTime() <= now.getTime()) {
    return NextResponse.json({ ok: false, error: "ends_at_past" }, { status: 400 });
  }

  const onSitting = await db
    .select()
    .from(attempts)
    .where(eq(attempts.test_session_id, sitting.id))
    .orderBy(asc(attempts.started_at));

  const extended: { attempt_id: string }[] = [];
  let skipped = 0;
  for (const attempt of onSitting) {
    if (attempt.status !== "in_progress") {
      skipped++;
      continue;
    }
    const { attempt: row } = await extendAttempt(db, attempt, auth.session.sub, endsAt, now);
    extended.push({ attempt_id: row.id });
  }

  return NextResponse.json({
    ok: true,
    extended: extended.length,
    skipped,
    attempts: extended,
  });
}
