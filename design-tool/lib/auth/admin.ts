// System admin (docs/access-model-design.md, D-1), access slice 2.
//
// Admin is a CONFIGURATION LIST, not a role and not a table. `role` stays
// derived from the email domain (`lib/auth/roles.ts`) and is the one fact about
// a login the caller cannot choose; adding a third value to it would put a
// privileged principal in the same vocabulary a session JWT carries, and every
// `mapRole` call site would have to learn about it. `ADMIN_EMAILS` instead sits
// beside the provider selectors in the task environment, is one to three
// addresses, and changes by a deploy.
//
// It never widens the ROLE check — an admin is staff and `requireStaff()` is
// unchanged. It widens the OWNERSHIP check only, in `lib/api/access.ts`:
// admin → `own` on every assessment, via `"admin"`. D-6 limits admin WRITES
// outside the admin surface to impersonation (slice 5); this slice only makes
// the reads resolve.

// Parsed once and memoised, because the list is consulted on every authorize*
// call that is not the owner's and re-splitting a string per request is pure
// waste. The memo is keyed on the RAW value rather than being a module-level
// const evaluated at import time: in production the variable never changes, so
// the cache hits every time; in a test the list can be set and re-read without
// the import order deciding the answer.
let cachedRaw: string | null = null;
let cachedList: readonly string[] = [];

function parse(raw: string): readonly string[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

/**
 * The configured admin addresses, lowercased and de-duplicated. Empty when
 * `ADMIN_EMAILS` is unset or blank — the default everywhere (tests, CI, dev) is
 * that nobody is an admin.
 */
export function adminEmails(): readonly string[] {
  const raw = process.env.ADMIN_EMAILS ?? "";
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedList = parse(raw);
  }
  return cachedList;
}

/**
 * Is this session ACTING AS somebody else? (Access slice 5, D-8.)
 *
 * `actor_sub` is written only by `POST /api/admin/impersonate`, into a session
 * whose `sub` / `email` / `role` are the target teacher's. It is the one
 * signal that the principal on this request is not who the rest of the payload
 * says, so it is read in exactly two places: `isAdmin` below, and the header
 * banner.
 */
export function isImpersonating(
  session: { actor_sub?: string } | null | undefined,
): boolean {
  return typeof session?.actor_sub === "string" && session.actor_sub.length > 0;
}

/**
 * Is this session's verified address on the admin list?
 *
 * Compares the SESSION's email, which was written at login from Google's
 * verified `email` claim — not a header, not a body field. A session with no
 * email (a `--token` dev session minted before slice 77) is never an admin.
 *
 * **An impersonated session is never an admin** (slice 5, D-8). Its `email` is
 * the TARGET's, so the list comparison would already fail for any target who
 * is not themselves an admin — but the check is explicit rather than
 * incidental, because it is what makes act-as a strict narrowing: an admin
 * acting as a teacher sees exactly what that teacher sees, cannot reach
 * `/admin` or the grants API, and cannot chain a second impersonation (the
 * impersonate route's own gate is this predicate). Stop first, then act.
 */
export function isAdmin(
  session: { email?: string; actor_sub?: string } | null | undefined,
): boolean {
  if (isImpersonating(session)) return false;
  const email = (session?.email ?? "").trim().toLowerCase();
  if (!email) return false;
  return adminEmails().includes(email);
}
