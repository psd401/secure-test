import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { attempts } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { isPastDeadline, loadDeadline } from "@/lib/api/attemptDeadline";
import { handInAttempt } from "@/lib/api/handInAttempt";
import { sessionOpenResponse } from "@/lib/api/staffAttempt";
import { sittingIsOver } from "@/lib/api/sittingOver";
import { UUID_RE } from "@/lib/uuid";
import { authorizeSitting } from "@/lib/api/access";

interface RouteContext {
  params: Promise<{ sessionId: string }>;
}

/**
 * "Hand in everyone now" — the per-attempt forced hand-in, applied to a whole
 * sitting (James, 2026-09-16).
 *
 * The unit is the SITTING, not the assessment: a teacher's decision that a
 * test is over is a decision about the class in front of them, and an
 * assessment-wide sweep would finalise another period's attempts too. Attempts
 * on the same assessment with no `test_session_id` (the `--token` dev posture,
 * the seeder) are therefore never touched.
 *
 * Owner-only through `authorizeSitting` — the same check and the same 404 as
 * Close, so a caller cannot learn that someone else's sitting exists.
 *
 * The open-sitting rule, per row rather than per request:
 *   - sitting closed or expired → hand in every `in_progress` attempt.
 *   - sitting still open → hand in only the attempts whose OWN deadline has
 *     passed (the per-attempt route's relaxation: the server is refusing their
 *     writes anyway, so there is no answer in flight to freeze), and leave the
 *     rest alone. If nothing qualifies, 409 `session_open` — the same body the
 *     per-attempt route returns, so the teacher's UI needs one error string,
 *     not two.
 *
 * Idempotent by construction: it only ever selects `in_progress` rows, so a
 * second press hands in 0 and reports it as such rather than erroring.
 *
 * Sequential, not parallel, and one attempt's failure is its own: each hand-in
 * is a separate small transaction, so a scoring failure on one student (which
 * `handInAttempt` already swallows) or a row that disappears under us cannot
 * cost the rest of the class their submission.
 */
export async function POST(_req: Request, ctx: RouteContext) {
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

  const now = new Date();
  const stillOpen = !sittingIsOver(sitting, now);

  const onSitting = await db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.test_session_id, sitting.id),
        // Practice (docs/practice-sitting-design.md, D-4): a class sitting's
        // sweep never touches a practice attempt, and a practice sitting's
        // touches only its own. A practice attempt is only ever bound to a
        // practice sitting, so this holds by construction too — checked
        // anyway, on the flag every class reader uses.
        eq(attempts.practice, sitting.kind === "practice"),
      ),
    )
    .orderBy(asc(attempts.started_at));

  const handed: { attempt_id: string; status: string }[] = [];
  let skipped = 0;
  // Of the skipped, the ones that were still working and were held back only
  // because the sitting is open — the 409 below is about those and no others.
  let heldByOpenSitting = 0;
  let scored = 0;

  for (const attempt of onSitting) {
    // Already finished, by the student or by an earlier press of this button.
    if (attempt.status !== "in_progress") {
      skipped++;
      continue;
    }
    if (stillOpen) {
      const deadline = await loadDeadline(db, attempt);
      if (!isPastDeadline(now, deadline)) {
        skipped++;
        heldByOpenSitting++;
        continue;
      }
    }
    const result = await handInAttempt(db, attempt, auth.session.sub, new Date());
    scored += result.scored;
    handed.push({ attempt_id: result.attempt.id, status: result.attempt.status });
  }

  // Nothing qualified AND the sitting is the reason: say so, in the shape the
  // per-attempt route uses. An empty sitting that is already closed is a
  // successful no-op instead — the teacher asked for everyone to be handed in,
  // and everyone is.
  if (handed.length === 0 && heldByOpenSitting > 0) {
    return sessionOpenResponse();
  }

  return NextResponse.json({
    ok: true,
    handed_in: handed.length,
    skipped,
    scored,
    attempts: handed,
  });
}
