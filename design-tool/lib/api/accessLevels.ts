// The access ladder, on its own so that `lib/api/access.ts` and
// `lib/api/grants.ts` can both have it without importing each other.
//
// access.ts asks grants.ts to resolve a grant, and grants.ts has to compare and
// order levels to pick the highest covering one. Leaving the ladder in access.ts
// would make that a module cycle — legal in ESM, but a cycle whose module-level
// `const` arrays are read during the other module's initialisation is exactly
// the shape that evaluates to `undefined` under one bundler and works under the
// next. Four lines in their own file instead.
//
// access.ts re-exports all of this, so a route still names the level it needs
// through `@/lib/api/access` and nothing outside these two modules has to know
// this file exists.

/**
 * `view` (results and monitor, read-only) < `run` (sittings, monitor actions,
 * hand in, extend) < `edit` (items, settings, publish, scoring) < `own`
 * (share, archive, delete, grant). docs/access-model-design.md, D-2.
 */
export type AccessLevel = "view" | "run" | "edit" | "own";

/**
 * How the level was reached. `"owner"` is the assessment's `owner_sub`;
 * `"admin"` is `ADMIN_EMAILS` (D-1); `"grant"` is a row in `access_grants`
 * (D-2). The distinction is shown to the teacher — "Shared with you as
 * co-teacher" — and is what the sitting-creation branch keys on.
 */
export type AccessVia = "owner" | "grant" | "admin";

export const ACCESS_LEVELS: readonly AccessLevel[] = [
  "view",
  "run",
  "edit",
  "own",
] as const;

export function isAccessLevel(value: unknown): value is AccessLevel {
  return typeof value === "string" && ACCESS_LEVELS.includes(value as AccessLevel);
}

/** Does `have` reach `need` on the ladder? */
export function levelSatisfies(have: AccessLevel, need: AccessLevel): boolean {
  return ACCESS_LEVELS.indexOf(have) >= ACCESS_LEVELS.indexOf(need);
}

/** The higher of two levels; `null` counts as lower than anything. */
export function maxLevel(
  a: AccessLevel | null,
  b: AccessLevel | null,
): AccessLevel | null {
  if (a === null) return b;
  if (b === null) return a;
  return levelSatisfies(a, b) ? a : b;
}
