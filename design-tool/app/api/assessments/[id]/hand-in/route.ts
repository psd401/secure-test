import { NextResponse } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { attempts } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAssessment } from "@/lib/api/access";
import { isPastDeadline, loadDeadline } from "@/lib/api/attemptDeadline";
import { handInAttempt } from "@/lib/api/handInAttempt";
import { sessionOpenResponse, sittingIsOpen } from "@/lib/api/staffAttempt";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const BodySchema = z.object({
  attempt_ids: z.array(z.string().regex(UUID_RE)).min(1).max(1000),
});

/**
 * "Hand in all in progress" from the Results page (roadmap U-14, 2026-10-05).
 *
 * Why not the sitting-wide route: `hand-in-all` selects by
 * `attempts.test_session_id`, which a resume rebinds to the LAST sitting the
 * student joined. A teacher who ran a test over several class periods has
 * in-progress attempts spread across many old sittings, and no single press
 * reached them (an open-beta teacher had 75 on one assessment). The Results
 * page lists every in-progress attempt on the assessment, filtered by section,
 * so the button there hands in exactly the rows the teacher is looking at.
 *
 * The caller sends the attempt ids it shows; the server re-checks every one
 * with the per-attempt route's rules and never trusts the list:
 *   - an id on another assessment, a practice attempt, or one already handed
 *     in is skipped;
 *   - an attempt whose sitting is still open is skipped unless its own
 *     deadline has passed (the per-attempt `session_open` relaxation) — the
 *     student may be mid-answer;
 *   - nothing handed in AND at least one held by an open sitting → 409
 *     `session_open`, the body both other hand-in routes use.
 *
 * Level `run`, the same as the per-attempt and per-sitting hand-ins (an
 * attempt's access is its assessment's). Sequential, one small transaction per
 * attempt through `handInAttempt`, so one failure never costs the rest.
 */
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "run");
  if (!access.ok) return access.response;

  const ids = [...new Set(parsed.data.attempt_ids)];
  const rows = await db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.assessment_id, id),
        eq(attempts.practice, false),
        inArray(attempts.id, ids),
      ),
    )
    .orderBy(asc(attempts.started_at));

  const handed: { attempt_id: string; status: string }[] = [];
  let skipped = ids.length - rows.length;
  let heldByOpenSitting = 0;
  let scored = 0;
  const now = new Date();

  for (const attempt of rows) {
    if (attempt.status !== "in_progress") {
      skipped++;
      continue;
    }
    const deadline = await loadDeadline(db, attempt);
    if (!isPastDeadline(now, deadline) && (await sittingIsOpen(db, attempt))) {
      skipped++;
      heldByOpenSitting++;
      continue;
    }
    const result = await handInAttempt(db, attempt, auth.session.sub, now);
    scored += result.scored;
    handed.push({ attempt_id: result.attempt.id, status: result.attempt.status });
  }

  if (handed.length === 0 && heldByOpenSitting > 0) {
    return sessionOpenResponse();
  }

  return NextResponse.json({
    ok: true,
    handed_in: handed.length,
    skipped,
    held_by_open_session: heldByOpenSitting,
    scored,
    attempts: handed,
  });
}
