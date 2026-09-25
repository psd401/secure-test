import type { Instrumentation } from "next";

/**
 * Batch 3 slice 2 (docs/observability-design.md). Next 16's
 * `onRequestError` hook: it fires once for every error the server captures —
 * a throwing route handler, a server component, a server action — and is the
 * only place all three meet.
 *
 * The work is in `lib/observability/serverError.ts` so it is testable without
 * a Next server; this file stays the thin registration Next looks for at the
 * application root. There is no OTel exporter; `register` below starts the
 * one background job the app owns (the safeguarding screening retry).
 *
 * Node runtime only: the recorder hashes the stack with `node:crypto` and
 * writes a Postgres row, neither of which exists in the Edge runtime. Next
 * bundles this file for both runtimes, so the import is deferred behind the
 * `NEXT_RUNTIME` check (the pattern the Next 16 instrumentation doc gives);
 * an Edge-side error still reaches the log line through Next's own logging.
 *
 * `await` matters — the docs are explicit that an un-awaited async task in
 * this hook may not finish before the process moves on, which would lose the
 * row on exactly the errors worth keeping.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { recordServerError } = await import("@/lib/observability/serverError");
  await recordServerError(err, request, context);
};

/**
 * Safeguarding alerts (docs/safeguarding-alerts-design.md, 9.1 = A): the
 * hourly retry of hand-in screening. It lives in the app because the
 * roster-sync Lambda has no route to Bedrock. Node runtime only, same
 * deferred-import rule as above; a no-op when screening is off.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startScreeningRetry } = await import("@/lib/safeguarding/screening/retry");
  startScreeningRetry();
}
