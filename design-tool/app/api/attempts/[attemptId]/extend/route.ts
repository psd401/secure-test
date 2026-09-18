import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAttempt } from "@/lib/api/access";
import { extendAttempt } from "@/lib/api/extendAttempt";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

const Body = z.object({
  /** An ABSOLUTE instant — "this student finishes at 10:45" — not a number of
   * extra minutes. The teacher's UI does the arithmetic; the server stores the
   * answer, so nothing has to re-derive it from a limit that may change. */
  ends_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "ends_at must be a parseable date",
  }),
});

/**
 * Give one student more time.
 *
 * The follow-up the time-limit note
 * (docs/time-limit-and-unfinished-attempts-design.md) named and left unbuilt:
 * "a teacher-side add 10 minutes". Without it the only levers a teacher has
 * when a student needs longer are editing the assessment's limit — which moves
 * every student in every sitting — or forcing a hand-in.
 *
 * Owner-only through the same `authorizeAttempt` the hand-in and delete routes
 * use, with the same statuses (404 unknown, 403 someone else's): deciding how
 * long a child gets is the owner's call, not a shared colleague's, and the two
 * statuses have to match hand-in exactly or a caller can tell the actions apart.
 *
 * Two refusals, mirroring hand-in's shape:
 *   - 400 `ends_at_past` — the instant is not in the future. An extension into
 *     the past is either a typo or an attempt to end someone's test early, and
 *     neither is what this route is for; a teacher who wants a test over
 *     presses Hand in.
 *   - 409 `not_in_progress` — the attempt is submitted. There is nothing left
 *     to give time to, and silently writing an override onto a finished attempt
 *     would leave a deadline in the row that no consumer will ever read.
 *
 * Deliberately NOT refused: an open sitting. Hand-in and Delete guard against
 * acting under a student who may be mid-answer because both destroy something;
 * extending is purely additive — the student keeps writing and simply has
 * longer — so the guard would only stop the case the feature exists for.
 * Neither is a closed or expired sitting refused: extending into tomorrow,
 * after today's period ended, is a thing a teacher does.
 *
 * Idempotent: the override replaces rather than accumulates, so posting the
 * same instant twice leaves the same deadline.
 */
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const access = await authorizeAttempt(db, auth.session, attemptId, "run");
  if (!access.ok) return access.response;
  const attempt = access.attempt;

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

  if (attempt.status !== "in_progress") {
    return NextResponse.json({ ok: false, error: "not_in_progress" }, { status: 409 });
  }

  const { attempt: row } = await extendAttempt(db, attempt, auth.session.sub, endsAt, now);

  return NextResponse.json({
    ok: true,
    attempt_id: row.id,
    deadline_override_at: row.deadline_override_at?.toISOString() ?? null,
  });
}
