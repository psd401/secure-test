/**
 * Was duplicated per call site, each reading `err.code` off the top-level
 * error only. Drizzle wraps the driver error in `DrizzleQueryError`, which
 * carries no SQLSTATE of its own — the postgres.js error with
 * `code: "23505"` sits on `.cause`. A top-level-only check on a
 * Drizzle-wrapped error reads as "not a unique violation" and rethrows,
 * which turns an expected 409/retry into a 500 (found on the sitting-code
 * collision path in `lib/api/testSessions.ts`, which threw instead of
 * retrying with a new code).
 *
 * Walks a few levels of `.cause` rather than just the object itself, since
 * neither postgres.js nor Drizzle document a maximum wrapping depth and a
 * bounded walk costs nothing on the common one-level case.
 */
export function isUniqueViolation(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur && depth < 5; depth++) {
    if (typeof cur !== "object") break;
    if ((cur as { code?: unknown }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
