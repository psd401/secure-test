import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { ATTEMPT_EVENT_KINDS, attempt_events } from "@/db/schema";
import { requireStudent } from "@/lib/api/requireSession";
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
      detail: body.detail ?? null,
    })
    .returning();

  return NextResponse.json(
    { ok: true, event: { id: event!.id, kind: event!.kind, at: event!.at } },
    { status: 201 },
  );
}
