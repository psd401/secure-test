import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { access_grants } from "@/db/schema";
import { ACCESS_LEVELS, levelSatisfies, type AccessLevel } from "@/lib/api/accessLevels";
import { normalizeEmail } from "@/lib/roster/queries";

type Db = ReturnType<typeof getDb>;

/**
 * The schools a staff email holds a live `school`-scoped grant on at `min` or
 * above (docs/competency-assessment-design.md, slices 6 and 8). The ONE reader
 * of the school scope: `lib/api/grants.ts` still skips it, so a school grant
 * reaches only what the competency code built on this function allows —
 * released results at `view` (a counselor) and assigning that school's
 * students at `run` (slice 8).
 */
export async function schoolGrantSchools(
  db: Db,
  email: string | null | undefined,
  min: AccessLevel,
): Promise<string[]> {
  const grantee = normalizeEmail(email);
  if (!grantee) return [];
  const now = new Date();
  const rows = await db
    .select({ school: access_grants.scope_id })
    .from(access_grants)
    .where(
      and(
        eq(access_grants.grantee_email, grantee),
        eq(access_grants.scope_kind, "school"),
        inArray(
          access_grants.level,
          ACCESS_LEVELS.filter((l) => levelSatisfies(l, min)),
        ),
        isNull(access_grants.revoked_at),
        lte(access_grants.starts_at, now),
        or(isNull(access_grants.ends_at), gt(access_grants.ends_at, now)),
      ),
    );
  return [...new Set(rows.map((r) => r.school))];
}
