import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { OBSERVABILITY_TEXT_MAX, client_error_events } from "@/db/schema";
import { requireStudent } from "@/lib/api/requireSession";
import { log, truncate } from "@/lib/log";

/**
 * Batch 3 slice 2 (docs/observability-design.md): the macOS client's error
 * drain.
 *
 * The client writes JSON lines to `errors.log` in its container and posts them
 * after the next signed-in launch. Deliberately NOT attempt-scoped, which is
 * the whole reason it exists next to `/api/attempts/[attemptId]/events`: a
 * failed sign-in, a refused bundle, or a crash captured on the previous run
 * has no attempt to hang off. In-attempt errors keep using the events route
 * with the new `client_error` kind, because those should light the monitor.
 *
 * `sub` comes from the session, never from the body — a client cannot file an
 * error against somebody else. The body carries no answers by contract; the
 * caps below are what stops a runaway client from writing a novel:
 *
 *   - at most 50 entries per request (beyond → 413, so the client can split
 *     rather than assume its file is poison and drop it),
 *   - every message truncated to 2 000 characters,
 *   - `context` dropped entirely when its JSON exceeds 4 KB.
 *
 * A partial batch is not a thing: the insert is one statement, so the client's
 * "truncate the file on 200" rule is safe.
 */

export const MAX_ENTRIES = 50;
export const MAX_CONTEXT_BYTES = 4096;

const Entry = z.object({
  kind: z.string().min(1).max(120),
  message: z.string().min(1),
  context: z.record(z.string(), z.unknown()).optional(),
  occurred_at: z.string().datetime({ offset: true }),
  app_version: z.string().min(1).max(64),
  app_commit: z.string().min(1).max(64),
});

const Body = z.object({
  errors: z.array(Entry).min(1),
});

/** Drops a context bag that is too big rather than storing a truncated one:
 * half a JSON object is worse than none, and it is a diagnostic, not a record. */
function capContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!context) return null;
  let encoded: string;
  try {
    encoded = JSON.stringify(context);
  } catch {
    return null;
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_CONTEXT_BYTES) {
    return { dropped: "context_too_large" };
  }
  return context;
}

export async function POST(req: Request) {
  const auth = await requireStudent();
  if (!auth.ok) return auth.response;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  // The size check precedes parsing so an oversized batch gets the answer that
  // tells the client what to do about it, not a generic 400.
  if (
    typeof raw === "object" &&
    raw !== null &&
    Array.isArray((raw as { errors?: unknown }).errors) &&
    (raw as { errors: unknown[] }).errors.length > MAX_ENTRIES
  ) {
    return NextResponse.json(
      { ok: false, error: "too_many_entries", max: MAX_ENTRIES },
      { status: 413 },
    );
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const rows = parsed.data.errors.map((entry) => ({
    sub: auth.session.sub,
    app_version: entry.app_version,
    app_commit: entry.app_commit,
    kind: entry.kind,
    message: truncate(entry.message, OBSERVABILITY_TEXT_MAX),
    context: capContext(entry.context),
    occurred_at: new Date(entry.occurred_at),
  }));

  await getDb().insert(client_error_events).values(rows);

  // One line per batch, not per entry: the alarm should fire on the server's
  // own errors, and a classroom of clients draining at once must not look like
  // an outage. `sub` and counts only — the messages are in the table.
  log.warn("client_errors_received", {
    sub: auth.session.sub,
    count: rows.length,
    app_version: rows[0]?.app_version,
    app_commit: rows[0]?.app_commit,
  });

  return NextResponse.json({ accepted: rows.length }, { status: 200 });
}
