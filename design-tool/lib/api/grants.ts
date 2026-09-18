// Grant storage and resolution (docs/access-model-design.md, D-2), access
// slice 2.
//
// `lib/api/access.ts` is the only enforcement point; this module is what it asks
// when the caller is neither the owner nor an admin. Two shapes, deliberately:
//
//   loadActiveGrants(db, email)  → one query, the caller's whole live grant set
//   grantedLevel(grants, row)    → PURE, per row
//
// A list of fifty assessments resolves with one query and fifty pure calls
// rather than fifty queries (`lib/api/visibleAssessments.ts` depends on that),
// and `effectiveLevel` is the single-row convenience over the same pair.
//
// SCOPE RESOLUTION
//   assessment — by the assessment's own id. The co-teacher case (D-4 (b)).
//   teacher    — by the assessment's OWNER's email. Nothing on the assessment
//                row used to hold one; `assessments.owner_email` (migration
//                0038) is the denormalised copy that makes this arm possible,
//                and an assessment whose owner_email is still NULL resolves NO
//                teacher-scope grant. Stated as a deviation in the note.
//   school     — STORED, NEVER RESOLVED. D-7 deferred principals out of this
//                release; a `school` row confers nothing today, and slice 6
//                turns it on without a migration. There is a test for exactly
//                that, because "stored but inert" is the kind of half-feature
//                that silently becomes live.
//
// TIME AND REVOCATION
//   A grant counts only while `revoked_at is null`, `starts_at <= now` and
//   (`ends_at is null` or `ends_at > now`). Evaluated in SQL so a long-running
//   process cannot hold a stale answer, and `ends_at` is exclusive so a grant
//   that ended at 16:00 is gone at 16:00.
import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { getDb } from "@/db/client";
import {
  access_grants,
  type AccessGrantRow,
  type AccessGrantScope,
} from "@/db/schema";
import { normalizeEmail } from "@/lib/roster/queries";
import { isAdmin } from "@/lib/auth/admin";
import { roleForEmail } from "@/lib/auth/roles";
import type { SessionPayload } from "@/lib/auth/session";
import {
  isAccessLevel,
  maxLevel,
  type AccessLevel,
  type AccessVia,
} from "@/lib/api/accessLevels";

type Db = ReturnType<typeof getDb>;

/** The caller's live grants, indexed by the two scopes that resolve. */
export interface ActiveGrants {
  /** assessment uuid (lowercased) → highest level granted on it. */
  readonly byAssessment: ReadonlyMap<string, AccessLevel>;
  /** granting teacher's email → highest level granted over their assessments. */
  readonly byTeacherEmail: ReadonlyMap<string, AccessLevel>;
  /** True when there is nothing to resolve — lets callers skip the arms. */
  readonly empty: boolean;
}

export const NO_GRANTS: ActiveGrants = {
  byAssessment: new Map(),
  byTeacherEmail: new Map(),
  empty: true,
};

/** Only these two arms are consulted; `school` is deliberately absent (D-7). */
const RESOLVED_SCOPES: readonly AccessGrantScope[] = ["assessment", "teacher"];

/**
 * Every live grant held by `email`, folded into the two lookup maps.
 *
 * One query per request, not per row. The `where` carries the whole liveness
 * rule so an expired, future-dated or revoked row never reaches application
 * code — a filter written in TypeScript would have to be repeated by every
 * future caller, and one of them would get it wrong.
 */
export async function loadActiveGrants(
  db: Db,
  email: string | null | undefined,
): Promise<ActiveGrants> {
  const grantee = normalizeEmail(email);
  if (!grantee) return NO_GRANTS;

  const rows = await db
    .select({
      scope_kind: access_grants.scope_kind,
      scope_id: access_grants.scope_id,
      level: access_grants.level,
    })
    .from(access_grants)
    .where(
      and(
        eq(access_grants.grantee_email, grantee),
        isNull(access_grants.revoked_at),
        lte(access_grants.starts_at, sql`now()`),
        or(isNull(access_grants.ends_at), gt(access_grants.ends_at, sql`now()`)),
      ),
    );

  const byAssessment = new Map<string, AccessLevel>();
  const byTeacherEmail = new Map<string, AccessLevel>();
  for (const row of rows) {
    if (!isAccessLevel(row.level)) continue; // CHECK-constrained; belt and braces
    if (!RESOLVED_SCOPES.includes(row.scope_kind as AccessGrantScope)) continue;
    const target =
      row.scope_kind === "assessment" ? byAssessment : byTeacherEmail;
    const key =
      row.scope_kind === "assessment"
        ? row.scope_id.toLowerCase()
        : (normalizeEmail(row.scope_id) ?? row.scope_id.toLowerCase());
    const next = maxLevel(target.get(key) ?? null, row.level);
    if (next) target.set(key, next);
  }
  return {
    byAssessment,
    byTeacherEmail,
    empty: byAssessment.size === 0 && byTeacherEmail.size === 0,
  };
}

/** What a loaded grant set says about one assessment row, and through which scope. */
export interface GrantedAccess {
  readonly level: AccessLevel;
  readonly scope: AccessGrantScope;
}

/**
 * Pure: the highest level `grants` confers on this assessment.
 *
 * When both arms match, the higher level wins; on a tie the `assessment` scope
 * is reported, because it is the more specific statement about this row and the
 * sitting-creation branch (D-5) keys on the distinction.
 */
export function grantedLevel(
  grants: ActiveGrants,
  assessment: { id: string; owner_email: string | null },
): GrantedAccess | null {
  if (grants.empty) return null;
  const direct = grants.byAssessment.get(assessment.id.toLowerCase()) ?? null;
  const ownerEmail = normalizeEmail(assessment.owner_email);
  const viaTeacher = ownerEmail
    ? (grants.byTeacherEmail.get(ownerEmail) ?? null)
    : null;
  if (direct === null && viaTeacher === null) return null;
  if (direct !== null && (viaTeacher === null || levelAtLeast(direct, viaTeacher))) {
    return { level: direct, scope: "assessment" };
  }
  return { level: viaTeacher!, scope: "teacher" };
}

function levelAtLeast(a: AccessLevel, b: AccessLevel): boolean {
  return maxLevel(a, b) === a;
}

/**
 * The level a session has on one assessment: owner → admin → grant → nothing.
 *
 * The whole resolution order in one place, so `authorizeAssessment` and the list
 * queries cannot disagree about it. Returns null when the session has no access
 * at all; the caller turns that into the single 404 (D-3).
 */
export async function effectiveLevel(
  db: Db,
  session: SessionPayload,
  assessment: { id: string; owner_sub: string; owner_email: string | null },
): Promise<{
  level: AccessLevel;
  via: AccessVia;
  scope: AccessGrantScope | null;
} | null> {
  if (assessment.owner_sub === session.sub) {
    return { level: "own", via: "owner", scope: null };
  }
  // D-6: an admin reads everything. Resolved BEFORE grants so an admin who also
  // holds a grant is still reported as an admin — the audit story for an admin
  // action should not depend on an unrelated row.
  if (isAdmin(session)) return { level: "own", via: "admin", scope: null };
  const grants = await loadActiveGrants(db, session.email);
  const granted = grantedLevel(grants, assessment);
  if (!granted) return null;
  return { level: granted.level, via: "grant", scope: granted.scope };
}

// ── The grants API's own reads and writes ───────────────────────────────────

/** Every grant held by an email, live or not, newest first (the admin table). */
export async function listGrantsFor(
  db: Db,
  email: string,
): Promise<AccessGrantRow[]> {
  const grantee = normalizeEmail(email);
  if (!grantee) return [];
  return db
    .select()
    .from(access_grants)
    .where(eq(access_grants.grantee_email, grantee))
    .orderBy(desc(access_grants.created_at));
}

/** The grants ON one scope — what the Share dialog lists for an assessment. */
export async function listGrantsOnScope(
  db: Db,
  scope_kind: AccessGrantScope,
  scope_id: string,
): Promise<AccessGrantRow[]> {
  return db
    .select()
    .from(access_grants)
    .where(
      and(
        eq(access_grants.scope_kind, scope_kind),
        eq(access_grants.scope_id, scope_id),
        isNull(access_grants.revoked_at),
      ),
    )
    .orderBy(desc(access_grants.created_at));
}

export interface CreateGrantInput {
  grantee_email: string;
  scope_kind: AccessGrantScope;
  scope_id: string;
  level: AccessLevel;
  ends_at?: Date | null;
  note?: string | null;
  granted_by_sub: string;
  granted_by_email: string;
}

export type CreateGrantResult =
  | { ok: true; grant: AccessGrantRow }
  | { ok: false; error: "already_granted" };

/**
 * Insert one grant.
 *
 * The duplicate is caught by the partial unique index rather than by a
 * select-then-insert: two teachers pressing Co-teach at once would both see no
 * row and both insert. A 23505 from `access_grants_live_unq` is therefore the
 * expected outcome of a race, not a bug, and becomes 409 `already_granted`.
 */
export async function createGrant(
  db: Db,
  input: CreateGrantInput,
): Promise<CreateGrantResult> {
  const grantee = normalizeEmail(input.grantee_email);
  // The routes validate the address (it must be a STAFF_DOMAINS one) before
  // getting here, so a blank is a programming error, not a caller's mistake.
  if (!grantee) throw new Error("createGrant: grantee_email is required");
  try {
    const [row] = await db
      .insert(access_grants)
      .values({
        grantee_email: grantee,
        scope_kind: input.scope_kind,
        scope_id:
          input.scope_kind === "teacher"
            ? (normalizeEmail(input.scope_id) ?? input.scope_id)
            : input.scope_id,
        level: input.level,
        ends_at: input.ends_at ?? null,
        note: input.note ?? null,
        granted_by_sub: input.granted_by_sub,
        granted_by_email: input.granted_by_email,
      })
      .returning();
    return { ok: true, grant: row! };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: "already_granted" };
    throw err;
  }
}

/**
 * Soft-revoke one grant, by id and within its scope.
 *
 * Scoped as well as keyed so the assessment-level route cannot revoke a grant
 * belonging to a different assessment by id alone. Returns the row when it
 * revoked something, null when there was nothing live to revoke — an already
 * revoked grant is a no-op, not an error, so the button is idempotent.
 */
export async function revokeGrant(
  db: Db,
  grantId: string,
  scope?: { scope_kind: AccessGrantScope; scope_id: string },
): Promise<AccessGrantRow | null> {
  const [row] = await db
    .update(access_grants)
    .set({ revoked_at: new Date() })
    .where(
      and(
        eq(access_grants.id, grantId),
        isNull(access_grants.revoked_at),
        scope ? eq(access_grants.scope_kind, scope.scope_kind) : undefined,
        scope ? eq(access_grants.scope_id, scope.scope_id) : undefined,
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Walks the `cause` chain rather than reading `err.code` off the top.
 *
 * Drizzle wraps a driver error in `DrizzleQueryError`, which carries no
 * SQLSTATE of its own — the postgres.js error with `code: "23505"` is the cause.
 * A top-level-only check reads as "not a unique violation" and rethrows, which
 * turns an expected 409 into a 500.
 */
function isUniqueViolation(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur && depth < 5; depth++) {
    if (typeof cur !== "object") break;
    if ((cur as { code?: unknown }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

// ── Request validation shared by the two grant surfaces ─────────────────────

/**
 * The grantee and level rules, in one place because the assessment-scoped route
 * (a teacher granting on their own assessment) and the admin route (any scope)
 * must agree about them:
 *
 *   - the grantee must be STAFF by the same domain rule that decides a login
 *     (`roleForEmail(email, true)`), so a grant cannot be made to a student
 *     address or to somebody outside the district;
 *   - never to yourself — a self-grant is either a no-op (you are the owner) or
 *     an attempt to widen your own access, and both should be refused rather
 *     than stored;
 *   - `own` is ADMIN-ONLY. An `own` grant can share, archive, delete and grant
 *     again, so a teacher handing one out would be handing out the ability to
 *     delete their own assessment and to grant further access on it. A
 *     co-teacher gets `edit`, which is D-4's whole intent.
 */
export type GrantValidationError =
  | "invalid_email"
  | "grantee_not_staff"
  | "self_grant"
  | "level_not_allowed";

export function validateGrantRequest(input: {
  granter: SessionPayload;
  grantee_email: string;
  level: AccessLevel;
}): { ok: true; grantee_email: string } | { ok: false; error: GrantValidationError } {
  const grantee = normalizeEmail(input.grantee_email);
  if (!grantee) return { ok: false, error: "invalid_email" };
  if (roleForEmail(grantee, true) !== "staff") {
    return { ok: false, error: "grantee_not_staff" };
  }
  const granterEmail = normalizeEmail(input.granter.email);
  if (granterEmail && granterEmail === grantee) {
    return { ok: false, error: "self_grant" };
  }
  if (input.level === "own" && !isAdmin(input.granter)) {
    return { ok: false, error: "level_not_allowed" };
  }
  return { ok: true, grantee_email: grantee };
}

/** 400 for a malformed request, 403-free by D-3 — a refused LEVEL is 400 too,
 * because the caller may grant here, just not that much. */
export const GRANT_VALIDATION_STATUS: Record<GrantValidationError, 400> = {
  invalid_email: 400,
  grantee_not_staff: 400,
  self_grant: 400,
  level_not_allowed: 400,
};

export const GrantLevelSchema = z.enum(["view", "run", "edit", "own"]);

export const CreateAssessmentGrantBody = z.object({
  grantee_email: z.string().trim().min(3).max(320),
  level: GrantLevelSchema,
  /** ISO-8601; omit or null for a standing grant. A substitute's grant ends. */
  ends_at: z.string().datetime().nullish(),
  note: z.string().trim().max(500).nullish(),
});

export const CreateScopedGrantBody = CreateAssessmentGrantBody.extend({
  scope_kind: z.enum(["assessment", "teacher", "school"]),
  /** assessment uuid | teacher email | school_id. */
  scope_id: z.string().trim().min(1).max(320),
});
