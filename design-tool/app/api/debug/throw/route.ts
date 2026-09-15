import { requireStaff } from "@/lib/api/requireSession";

/**
 * Row 67's knob (docs/observability-design.md, batch 3 open item, 2026-09-14):
 * every real route validates its input before anything can throw, so no
 * reachable request on the origin exercised the `onRequestError` path — the
 * `server_error_events` row, the `level:"error"` log line and the error
 * boundary's `ref`. This handler throws on purpose, for a signed-in staff
 * member only: an anonymous request is turned away by `requireStaff` like
 * every other teacher route (the role-enforcement test enumerates it from
 * disk). It reads nothing, writes nothing, and its only effect is the error
 * record the observability slice exists to produce.
 *
 * `/dashboard/debug/throw` is the page-shaped twin (the error boundary).
 */
export const dynamic = "force-dynamic";

export class DebugThrowError extends Error {
  readonly name = "DebugThrowError";
}

export async function GET() {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  throw new DebugThrowError(
    `debug throw requested by staff (row 67) at ${new Date().toISOString()}`,
  );
}
