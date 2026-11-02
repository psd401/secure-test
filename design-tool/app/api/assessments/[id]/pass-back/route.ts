import { NextResponse } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { attempts } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAssessment } from "@/lib/api/access";
import { attemptIsTimed } from "@/lib/api/attemptDeadline";
import { passBackAttempt } from "@/lib/api/passBackAttempt";
import { UUID_RE } from "@/lib/uuid";
import { JSON_BODY_LIMITS, readJsonBody } from "@/lib/api/jsonBody";
import { sectionPassBackTargets } from "@/lib/api/passBackSections";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const BodySchema = z.object({
  /** The ids the caller shows (Results, Monitor, a sitting row) … */
  attempt_ids: z.array(z.string().regex(UUID_RE)).min(1).max(1000).optional(),
  /** … or a section, resolved here (the Test sessions list's picker): a
   * Results filter label or `NO_SECTION`. Exactly one of the two. */
  section: z.string().min(1).max(200).optional(),
  /** One new deadline for every TIMED attempt in the list — an absolute
   * instant, like the per-attempt route's. */
  ends_at: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), {
      message: "ends_at must be a parseable date",
    })
    .optional(),
});

/**
 * "Pass back everyone" (docs/bulk-pass-back-and-corrections-design.md, slice
 * 1 — roadmap U-25, an open-beta teacher 2026-11-02): the per-attempt pass
 * back applied to a list of attempts on one assessment.
 *
 * Shaped like Results' "Hand in all in progress" (`../hand-in/route.ts`,
 * U-14), and for the same reason it takes ids rather than a sitting: a resume
 * rebinds an attempt to the LAST sitting joined, so `test_session_id` misses
 * students. Results sends the ids its section filter shows (D-1, by section),
 * Monitor and a Test sessions row a sitting's attendance rows (D-1, by
 * sitting). The Test sessions list's section picker (4.1) has no rows in
 * hand, so it sends `section` instead and the server resolves it with the
 * Results filter's own rule (`lib/api/passBackSections.ts`).
 *
 * The server never trusts the list. Skipped, not refused: an id on another
 * assessment, a practice attempt, or one that is not `submitted` (a second
 * press passes back 0 — the work is already with the students).
 *
 * `edit`, the per-attempt route's level (pass-back D-1): a substitute running
 * the sitting cannot reopen a class's tests.
 *
 * The deadline follows the per-attempt route per row: required (400
 * `ends_at_required`) when ANY selected attempt is timed, refused when past
 * (`ends_at_past`), and written only to the timed attempts — an untimed one
 * gains no deadline. Checked before anything is written, so a refusal changes
 * nothing.
 *
 * Sequential, one transaction per attempt through `passBackAttempt`, so one
 * failure never costs the rest.
 */
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let raw: unknown;
  const bodyRead = await readJsonBody(req, JSON_BODY_LIMITS.default);
  if (!bodyRead.ok) return bodyRead.response;
  try {
    raw = bodyRead.parse();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success || (parsed.data.attempt_ids === undefined) === (parsed.data.section === undefined)) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "edit", "write");
  if (!access.ok) return access.response;
  const { assessment } = access;

  const { section } = parsed.data;
  const ids = [
    ...new Set(
      section !== undefined
        ? ((await sectionPassBackTargets(db, assessment)).find((t) => t.section === section)
            ?.attempt_ids ?? [])
        : parsed.data.attempt_ids!,
    ),
  ];
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

  const toPassBack = rows.filter((a) => a.status === "submitted");
  const skipped = ids.length - toPassBack.length;

  const endsAt = parsed.data.ends_at ? new Date(Date.parse(parsed.data.ends_at)) : null;
  const anyTimed = toPassBack.some((a) => attemptIsTimed(a, assessment));
  if (anyTimed) {
    if (!endsAt) {
      return NextResponse.json({ ok: false, error: "ends_at_required" }, { status: 400 });
    }
    if (endsAt.getTime() <= Date.now()) {
      return NextResponse.json({ ok: false, error: "ends_at_past" }, { status: 400 });
    }
  }

  const passed: { attempt_id: string; status: string }[] = [];
  let supersededScores = 0;
  for (const attempt of toPassBack) {
    const result = await passBackAttempt(db, attempt, auth.session.sub, {
      endsAt: attemptIsTimed(attempt, assessment) ? endsAt : null,
    });
    supersededScores += result.superseded_scores;
    passed.push({ attempt_id: result.attempt.id, status: result.attempt.status });
  }

  return NextResponse.json({
    ok: true,
    passed_back: passed.length,
    skipped,
    superseded_scores: supersededScores,
    attempts: passed,
  });
}

/**
 * The Test sessions list's section picker (4.1): every section with someone
 * handed in, how many, and whether a pass back there needs a new deadline.
 * `edit`, like the POST — the picker is for the teachers who can use it.
 */
export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "edit", "read");
  if (!access.ok) return access.response;

  const targets = await sectionPassBackTargets(db, access.assessment);
  return NextResponse.json({
    ok: true,
    sections: targets.map((t) => ({
      section: t.section,
      handed_in: t.attempt_ids.length,
      timed: t.timed,
    })),
  });
}
