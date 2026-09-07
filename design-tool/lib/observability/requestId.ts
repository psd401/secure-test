/**
 * Batch 3 slice 2: the correlation handle that ties a screen to a row to a
 * log line.
 *
 * Behind the ALB every request already carries `x-amzn-trace-id`; reusing it
 * means our row lines up with the ALB access log for free. Locally, and for
 * anything that reaches the app without going through the load balancer, one
 * is minted. Either way `proxy.ts` puts it on the request (so
 * `onRequestError` can read it back out of the headers) and echoes it on the
 * response as `x-request-id`, which is what the error boundaries show as
 * "ref".
 */

export const REQUEST_ID_HEADER = "x-request-id";
export const TRACE_ID_HEADER = "x-amzn-trace-id";

/** Header values are attacker-controlled: bound the length and the alphabet. */
const SAFE_ID = /^[A-Za-z0-9=_.:-]{1,128}$/;

export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * An id already on the request, or a fresh one. An inbound value that is not
 * id-shaped is discarded rather than trusted — it ends up in a log line and a
 * database column, so it may not carry newlines or arbitrary length.
 */
export function resolveRequestId(headers: Headers): string {
  const existing =
    headers.get(REQUEST_ID_HEADER) ?? headers.get(TRACE_ID_HEADER) ?? null;
  if (existing && SAFE_ID.test(existing)) return existing;
  return newRequestId();
}
