// Access slice 5 (docs/access-model-design.md, D-8): act-as.
//
// The two routes are thin; the decisions live here.
//
// TARGET RESOLUTION IS THE INTERESTING PART. A session JWT needs a `sub` —
// Google's stable subject id — and the app stores no staff directory to look
// one up in (D-1 made admin a config list precisely to avoid a staff table).
// The only places a teacher's sub is recorded beside their address are the
// rows they own: `assessments.owner_sub` / `owner_email` (added by migration
// 0038) and `test_sessions.owner_sub` / `owner_email`. So "act as this
// teacher" means "act as the sub that owns their newest row", and a teacher
// who has never created anything cannot be acted as — there is nothing to act
// on, which is what the `no_account_rows` refusal says out loud rather than
// failing as a blank dashboard.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  assessments,
  impersonation_sessions,
  test_sessions,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import { roleForEmail } from "@/lib/auth/roles";

type Db = ReturnType<typeof getDb>;

/** Lowercased and trimmed, the form both `owner_email` columns are written in. */
export function normalizeStaffEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return value.length > 0 ? value : null;
}

export type ImpersonationRefusal =
  | "invalid_body"
  | "not_staff"
  | "self"
  | "no_account_rows";

/**
 * Is this address one we may act as at all? Staff by the same domain rule
 * every other principal is judged by (`roleForEmail`, verified = true because
 * the address came from our own `owner_email` column, not from a token), and
 * never the caller's own — acting as yourself writes an audit row that says
 * nothing and leaves a banner that cannot be reasoned about.
 */
export function checkImpersonationTarget(
  targetEmail: string | null,
  actorEmail: string | null | undefined,
): { ok: true; email: string } | { ok: false; error: ImpersonationRefusal } {
  if (!targetEmail) return { ok: false, error: "invalid_body" };
  if (roleForEmail(targetEmail, true) !== "staff") {
    return { ok: false, error: "not_staff" };
  }
  if (targetEmail === normalizeStaffEmail(actorEmail)) {
    return { ok: false, error: "self" };
  }
  return { ok: true, email: targetEmail };
}

/**
 * The target's Google `sub`, from their newest assessment, else their newest
 * sitting. Two queries rather than a union: the assessment is the answer
 * almost every time (it is the row an admin is looking at when they click Act
 * as), and the sitting fallback only matters for a teacher who has run
 * somebody else's shared copy and owns no assessment with `owner_email` filled
 * in — the migration-0038 backfill gap the note records.
 */
export async function resolveTargetSub(
  db: Db,
  email: string,
): Promise<string | null> {
  const [fromAssessment] = await db
    .select({ sub: assessments.owner_sub })
    .from(assessments)
    .where(sql`lower(${assessments.owner_email}) = ${email}`)
    .orderBy(desc(assessments.updated_at))
    .limit(1);
  if (fromAssessment?.sub) return fromAssessment.sub;

  const [fromSitting] = await db
    .select({ sub: test_sessions.owner_sub })
    .from(test_sessions)
    .where(sql`lower(${test_sessions.owner_email}) = ${email}`)
    .orderBy(desc(test_sessions.created_at))
    .limit(1);
  return fromSitting?.sub ?? null;
}

/** One audit row per act-as, opened here and closed by `closeImpersonation`. */
export async function startImpersonation(
  db: Db,
  row: {
    actor_sub: string;
    actor_email: string;
    target_sub: string;
    target_email: string;
    request_id: string | null;
  },
): Promise<void> {
  await db.insert(impersonation_sessions).values(row);
}

/**
 * Close the newest still-open row for this (actor, target) pair.
 *
 * Newest-open rather than "all open": an admin who somehow has two rows for
 * the same teacher (a browser restored a tab, a Stop that never reached the
 * server) stops one act-as per Stop, and the stale row stays open as the
 * honest record that it was never stopped. Silent when there is no open row —
 * the cookie is still restored, because refusing to hand an admin their own
 * identity back over a missing audit row would be the worse failure.
 */
export async function closeImpersonation(
  db: Db,
  args: { actor_sub: string; target_sub: string },
): Promise<void> {
  const [newest] = await db
    .select({ id: impersonation_sessions.id })
    .from(impersonation_sessions)
    .where(
      and(
        eq(impersonation_sessions.actor_sub, args.actor_sub),
        eq(impersonation_sessions.target_sub, args.target_sub),
        isNull(impersonation_sessions.stopped_at),
      ),
    )
    .orderBy(desc(impersonation_sessions.started_at))
    .limit(1);
  if (!newest) return;
  await db
    .update(impersonation_sessions)
    // `request_id` is NOT overwritten: the column holds the id of the request
    // that STARTED the act-as, which is the one a log line has to be lined up
    // with. The stop's own id is in its log line.
    .set({ stopped_at: new Date() })
    .where(eq(impersonation_sessions.id, newest.id));
}
