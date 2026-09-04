/**
 * The canonical UUID shape check for route params and other untrusted ids.
 *
 * Every dynamic route validates its `[id]` before it reaches a query: Postgres
 * raises 22P02 on a malformed uuid, which would surface as an unhandled 500
 * rather than the 400 the caller deserves. This regex was copy-pasted into 26
 * files; they all agreed, but 26 chances to disagree is 25 too many for a
 * validation boundary.
 *
 * Deliberately looser than RFC 4122 — it does not check the version or variant
 * nibbles, because the ids being validated are whatever `gen_random_uuid()`
 * produced, not a spec-conformance test. Case-insensitive to match Postgres,
 * which accepts and normalizes either case.
 */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
