import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAttempt } from "@/lib/api/access";
import { attemptIsTimed } from "@/lib/api/attemptDeadline";
import { passBackAttempt } from "@/lib/api/passBackAttempt";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

const Body = z.object({
  /**
   * The attempt's new deadline — an ABSOLUTE instant, like the extend route's,
   * because the teacher's dialog does the arithmetic and the server stores the
   * answer. Optional: an unlimited assessment needs none, and ignores one sent
   * anyway.
   */
  ends_at: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), {
      message: "ends_at must be a parseable date",
    })
    .optional(),
});

/**
 * Pass a handed-in attempt back so the student can keep working
 * (docs/pass-back-design.md — roadmap U-7, asked for by the pilot teachers on
 * 2026-09-17).
 *
 * The gap: `submitted` is terminal. The only way out of it was Delete attempt,
 * which throws the work away — so a student who handed in early, handed in the
 * wrong thing, or was told to add a paragraph had no route back to their own
 * answers. This flips the status, keeps every answer, and keeps the scores they
 * were given as a record (`superseded`, D-2) so the next hand-in re-scores the
 * changed answers instead of keeping the old numbers.
 *
 * `edit`, not `run` (D-1): a co-teacher who authors the assessment may reopen a
 * test, a substitute running the sitting may not. Refusal is 404 through
 * `authorizeAttempt`, like every other access decision.
 *
 * The refusals:
 *   - 409 `not_submitted` — the attempt is already in progress. That makes a
 *     second press a refusal rather than a second increment of
 *     `pass_back_count`, which is the idempotency this operation can have: the
 *     work is already back with the student.
 *   - 400 `ends_at_required` — the assessment is timed (or this attempt already
 *     carries an override), so its deadline is by definition in the past the
 *     moment it is passed back and EVERY student write would be refused with
 *     `time_expired`. Reopening without a new deadline would hand back a test
 *     nobody could type in; the dialog defaults the picker to tomorrow 23:59.
 *   - 400 `ends_at_past` — the same guard the extend route has, for the same
 *     reason: a deadline already behind us is a typo, not a decision.
 *
 * Deliberately NOT refused: an open sitting. Unlike Hand in and Delete, this
 * destroys nothing a student could be mid-way through — the attempt is
 * submitted, so nobody is typing — and passing a test back DURING the period it
 * is being sat is the common case ("you skipped page 3, try again").
 */
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const access = await authorizeAttempt(db, auth.session, attemptId, "edit");
  if (!access.ok) return access.response;
  const { attempt, assessment } = access;

  // An empty body is legitimate (an unlimited assessment), so a request with no
  // JSON at all parses as `{}` rather than failing.
  let endsAt: Date | null = null;
  try {
    const raw = await req.text();
    const parsed = Body.parse(raw.trim() === "" ? {} : JSON.parse(raw));
    endsAt = parsed.ends_at ? new Date(Date.parse(parsed.ends_at)) : null;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  if (attempt.status !== "submitted") {
    return NextResponse.json({ ok: false, error: "not_submitted" }, { status: 409 });
  }

  // "Timed" is the same question `deadlineFor` asks — a limit on the assessment
  // OR an override on the attempt — asked directly rather than through it,
  // because what matters here is whether a deadline EXISTS at all, not when it
  // falls. Both halves count: an override on an unlimited assessment is a
  // deadline a teacher granted by hand, and dropping it silently on a pass back
  // would be the same "nobody can type" failure. A REMOVED limit (2026-09-24)
  // is not timed: the pass back asks for no deadline and the attempt keeps its
  // "No time limit" (`passBackAttempt` never touches the flag).
  const timed = attemptIsTimed(attempt, assessment);

  if (timed) {
    if (!endsAt) {
      return NextResponse.json({ ok: false, error: "ends_at_required" }, { status: 400 });
    }
    if (endsAt.getTime() <= Date.now()) {
      return NextResponse.json({ ok: false, error: "ends_at_past" }, { status: 400 });
    }
  } else {
    // An unlimited assessment gains no deadline from this route. A teacher who
    // wants one on an untimed test has `POST …/extend` for exactly that.
    endsAt = null;
  }

  const { attempt: row, superseded_scores } = await passBackAttempt(
    db,
    attempt,
    auth.session.sub,
    { endsAt },
  );

  return NextResponse.json({
    ok: true,
    attempt_id: row.id,
    status: row.status,
    deadline_override_at: row.deadline_override_at?.toISOString() ?? null,
    superseded_scores,
  });
}
