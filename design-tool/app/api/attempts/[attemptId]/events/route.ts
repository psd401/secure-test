import { NextResponse } from "next/server";
import { asc, count, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  CLIENT_ATTEMPT_EVENT_KINDS,
  OBSERVABILITY_TEXT_MAX,
  SPEECH_PREFLIGHT_OUTCOMES,
  SPEECH_PREFLIGHT_STEPS,
  attempt_events
} from "@/db/schema";
import { truncate } from "@/lib/log";
import { requireStaff, requireStudentOrPractice } from "@/lib/api/requireSession";
import { loadOwnAttempt } from "@/lib/api/studentAttempt";
import { attemptSittingIsOver } from "@/lib/api/sittingOver";
import { authorizeAttempt } from "@/lib/api/access";
import { UUID_RE } from "@/lib/uuid";

/**
 * SEC-09 (security audit 2026-10-24): the three ceilings on what one student
 * session can put in this table. Before them, every kind but `client_error`
 * and `speech_preflight` stored `detail` verbatim and unbounded, a submitted
 * attempt accepted events for as long as the student stayed on the roster,
 * and nothing capped rows per attempt — while the Monitor poll for the whole
 * room and the per-student page load every row of every attempt.
 */
/** A `detail` bag over this many JSON bytes is replaced, not stored. */
export const MAX_EVENT_DETAIL_BYTES = 4096;
/** Rows one attempt may hold; the client sends a few dozen in a sitting. */
export const MAX_EVENTS_PER_ATTEMPT = 1000;
/**
 * How long after hand-in, or after the sitting ends, the client's teardown
 * events are still taken. Teardown races the submit by seconds; a quarter
 * hour covers a slow Mac without leaving the door open for days.
 */
export const EVENT_GRACE_SECONDS = 15 * 60;

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

const Body = z.object({
  kind: z.enum(CLIENT_ATTEMPT_EVENT_KINDS),
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
  if (kind === "speech_preflight") return speechPreflightDetail(detail);
  if (kind !== "client_error") return capDetail(detail);
  const errorKind = typeof detail?.kind === "string" ? detail.kind.slice(0, 120) : "unknown";
  const message =
    typeof detail?.message === "string"
      ? truncate(detail.message, OBSERVABILITY_TEXT_MAX)
      : "";
  return { kind: errorKind, message };
}

/**
 * SEC-09: the other kinds keep their bag, but not one of any size. Replaced
 * rather than truncated — half a JSON object is worse than none, and the
 * Monitor only ever reads known keys off it.
 */
function capDetail(
  detail: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!detail) return null;
  let encoded: string;
  try {
    encoded = JSON.stringify(detail);
  } catch {
    return null;
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_EVENT_DETAIL_BYTES) {
    return { dropped: "detail_too_large" };
  }
  return detail;
}

/**
 * Speech-to-text failure visibility (docs/speech-tools-design.md §Progress,
 * 2026-10-01): `speech_preflight` keeps `{ outcome, step? }` and nothing else,
 * each from its closed list. An outcome off the list is stored as
 * `unavailable` (the safe reading — the Monitor then shows the note) and an
 * unknown step is dropped; the rest of the bag never reaches a teacher.
 */
function speechPreflightDetail(
  detail: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const outcome = (SPEECH_PREFLIGHT_OUTCOMES as readonly unknown[]).includes(detail?.outcome)
    ? (detail!.outcome as string)
    : "unavailable";
  const step = (SPEECH_PREFLIGHT_STEPS as readonly unknown[]).includes(detail?.step)
    ? (detail!.step as string)
    : null;
  return step && outcome !== "ready" ? { outcome, step } : { outcome };
}

/**
 * Slice 91: the client's event report — quit, emergency exit, focus changes,
 * lockdown lifecycle. Telemetry for the teacher monitor, not answers, which
 * sets it apart from the response routes in two ways:
 *
 *   - a `submitted` attempt still accepts events — for EVENT_GRACE_SECONDS
 *     after the hand-in (SEC-09). The client sends quit-shaped events during
 *     teardown, and teardown races the submit; refusing at once would lose
 *     exactly the events sent while handing in. After the grace, and after
 *     the sitting is over by the same margin, the answer is 409: there is no
 *     test left to report on.
 *   - `at` is server-stamped. The alert logic orders focus_loss against
 *     focus_regained, and a client clock is not trusted with that ordering.
 *
 * The kind enum is strict (unknown → 400): the set is shared with the schema's
 * check constraint, and a drifting client should hear about it rather than
 * have its events quietly land as rows nothing displays. It is the CLIENT
 * subset — `teacher_hand_in` is a record of a staff action and is written by
 * the hand-in route alone.
 */
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStudentOrPractice();
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

  // SEC-09: no test left to report on.
  const now = new Date();
  const graceMs = EVENT_GRACE_SECONDS * 1000;
  if (
    access.attempt.status !== "in_progress" &&
    access.attempt.submitted_at &&
    now.getTime() >= access.attempt.submitted_at.getTime() + graceMs
  ) {
    return NextResponse.json({ ok: false, error: "attempt_closed" }, { status: 409 });
  }
  if (await attemptSittingIsOver(db, access.attempt, now, EVENT_GRACE_SECONDS)) {
    return NextResponse.json({ ok: false, error: "sitting_closed" }, { status: 409 });
  }

  // SEC-09: a ceiling per attempt. 429 rather than a silent drop so a client
  // in a loop hears it; the reporter retries a bounded number of times and
  // then stops.
  const [tally] = await db
    .select({ n: count() })
    .from(attempt_events)
    .where(eq(attempt_events.attempt_id, access.attempt.id));
  if ((tally?.n ?? 0) >= MAX_EVENTS_PER_ATTEMPT) {
    return NextResponse.json({ ok: false, error: "too_many_events" }, { status: 429 });
  }

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
  // The 404-on-everything posture this route already had is the helper's own
  // rule now (access slice 1, D-3); the only thing kept locally is the
  // no-store header on the refusal, which the helper's plain 404 would drop.
  const access = await authorizeAttempt(db, auth.session, attemptId, "view", "read");
  if (!access.ok) return notFound();
  const attempt = access.attempt;

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
