import type { Instrumentation } from "next";
import { recordServerError } from "@/lib/observability/serverError";

/**
 * Batch 3 slice 2 (docs/observability-design.md). Next 16's
 * `onRequestError` hook: it fires once for every error the server captures —
 * a throwing route handler, a server component, a server action — and is the
 * only place all three meet.
 *
 * The work is in `lib/observability/serverError.ts` so it is testable without
 * a Next server; this file stays the thin registration Next looks for at the
 * application root. `register` is deliberately absent: there is no OTel
 * exporter and nothing else to start.
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
  await recordServerError(err, request, context);
};
