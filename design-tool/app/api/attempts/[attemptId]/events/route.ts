import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  ATTEMPT_EVENT_KINDS,
  OBSERVABILITY_TEXT_MAX,
  assessments,
  attempt_events,
  attempts,
} from "@/db/schema";
import { truncate } from "@/lib/log";
import { requireStaff, requireStudent } from "@/lib/api/requireSession";
import { loadOwnAttempt } from "@/lib/api/studentAttempt";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

const Body = z.object({
  kind: z.enum(ATTEMPT_EVENT_KINDS),
  detail: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Batch 3 slice 2 (D-4): `client_error` carries `{ kind, message }` and
 * nothing else. The message is truncated to the observability ceiling and the
 * rest of the bag is dropped — `detail` is displayed to a teacher in the
 * monitor, so this is the boundary where a client cannot put a stem, an
 * answer, or a token in front of one.
 */
function normaliseDetail(
  kind: string,
  detail: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (kind !== "client_error") return detail ?? null;
  const errorKind = typeof detail?.kind === "string" ? detail.kind.slice(0, 120) : "unknown";
  const message =
    typeof detail?.message === "string"
      ? truncate(detail.message, OBSERVABILITY_TEXT_MAX)
      : "";
  return { kind: errorKind, message };
}

/**
 * Slice 91: the client's event report — quit, emergency exit, focus changes,
 * lockdown lifecycle. Telemetry for the teacher monitor, not answers, which
 * sets it apart from the response routes in two ways:
 *
 *   - a `submitted` attempt still accepts events. The client sends quit-shaped
 *     events during teardown, and teardown races the submit; refusing here
 *     would lose exactly the events sent while handing in.
 *   - `at` is server-stamped. The alert logic orders focus_loss against
 *     focus_regained, and a client clock is not trusted with that ordering.
 *
 * The kind enum is strict (unknown → 400): the set is shared with the schema's
 * check constraint, and a drifting client should hear about it rather than
 * have its events quietly land as rows nothing displays.
 */
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStudent();
  if (!auth.ok) return auth.response;

  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let body;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const access = await loadOwnAttempt(db, attemptId, auth.session);
  if (!access.ok) return access.response;

  const [event] = await db
    .insert(attempt_events)
    .values({
      attempt_id: access.attempt.id,
      kind: body.kind,
      detail: normaliseDetail(body.kind, body.detail),
    })
    .returning();

  return NextResponse.json(
    { ok: true, event: { id: event!.id, kind: event!.kind, at: event!.at } },
    { status: 201 },
  );
}

/**
 * R1 (docs/reporting-design.md): the teacher's read side of the same rows —
 * the integrity timeline on `/dashboard/[id]/results/[attemptId]`. There was
 * no read route at all before this; the monitor folds the newest event per
 * attempt into the attendance payload and never lists them.
 *
 * D-R5: owner-only. Ownership walks attempt -> assessment, and every failure
 * after the role check — no such attempt, another teacher's attempt — answers
 * 404, the posture the response-upload route (R0.2) settled on: a teacher
 * probing ids must not be able to tell "not yours" from "doesn't exist". A
 * STUDENT session gets 403 from requireStaff, like every other teacher route.
 *
 * FERPA: `private, no-store`. These rows say when a named child left the test
 * window; they belong in no shared cache and on no disk.
 */
export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { attemptId } = await ctx.params;
  const notFound = () =>
    NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    );
  if (!UUID_RE.test(attemptId)) return notFound();

  const db = getDb();
  const [attempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .limit(1);
  if (!attempt) return notFound();

  const [assessment] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, attempt.assessment_id))
    .limit(1);
  if (!assessment || assessment.owner_sub !== auth.session.sub) return notFound();

  const rows = await db
    .select()
    .from(attempt_events)
    .where(eq(attempt_events.attempt_id, attempt.id))
    .orderBy(asc(attempt_events.at));

  return NextResponse.json(
    {
      events: rows.map((r) => ({
        at: r.at.toISOString(),
        kind: r.kind,
        detail: r.detail ?? null,
      })),
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
