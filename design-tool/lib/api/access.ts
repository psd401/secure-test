import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import {
  assessments,
  assets,
  attempts,
  rubrics,
  students,
  test_sessions,
  type AssessmentRow,
  type AssetRow,
  type AttemptRow,
  type RubricRow,
  type StudentRow,
  type TestSessionRow,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import type { SessionPayload } from "@/lib/auth/session";
import { UUID_RE } from "@/lib/uuid";

type Db = ReturnType<typeof getDb>;

/**
 * The access ladder (docs/access-model-design.md, D-2).
 *
 * `view` (results and monitor, read-only) < `run` (sittings, monitor actions,
 * hand in, extend) < `edit` (items, settings, publish, scoring) < `own`
 * (share, archive, delete, grant). Slice 1 only ever resolves `own` — the
 * owner is the only principal with any access at all until the grants table
 * lands in slice 2 — but every caller already names the level it needs, so
 * slice 2 widens resolution without touching a single route.
 */
export type AccessLevel = "view" | "run" | "edit" | "own";

/** How the level was reached. `"grant"` / `"admin"` arrive in slice 2. */
export type AccessVia = "owner";

export const ACCESS_LEVELS: readonly AccessLevel[] = [
  "view",
  "run",
  "edit",
  "own",
] as const;

/** Does `have` reach `need` on the ladder? */
export function levelSatisfies(have: AccessLevel, need: AccessLevel): boolean {
  return ACCESS_LEVELS.indexOf(have) >= ACCESS_LEVELS.indexOf(need);
}

type Denied = { ok: false; response: NextResponse };

export type AssessmentAccess =
  | { ok: true; assessment: AssessmentRow; level: AccessLevel; via: AccessVia }
  | Denied;

export type SittingAccess =
  | {
      ok: true;
      sitting: TestSessionRow;
      assessment: AssessmentRow;
      level: AccessLevel;
      via: AccessVia;
    }
  | Denied;

export type AttemptAccess =
  | {
      ok: true;
      attempt: AttemptRow;
      assessment: AssessmentRow;
      level: AccessLevel;
      via: AccessVia;
    }
  | Denied;

export type StudentAccess =
  | { ok: true; student: StudentRow; level: AccessLevel; via: AccessVia }
  | Denied;

export type RubricAccess =
  | { ok: true; rubric: RubricRow; level: AccessLevel; via: AccessVia }
  | Denied;

export type AssetAccess =
  | { ok: true; asset: AssetRow; level: AccessLevel; via: AccessVia }
  | Denied;

/**
 * The single refusal (D-3).
 *
 * Always 404, never 403: the old select-then-compare routes told a caller
 * guessing uuids which ones existed, and once grants exist the set of rows a
 * principal may see is no longer "mine" — an id that is invisible today may be
 * visible tomorrow, and neither state should be readable from the status code.
 * A route that needs a level it does not have is indistinguishable from a route
 * whose row is not there.
 */
export function notFoundResponse(): NextResponse {
  return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
}

/**
 * A malformed id is a 400, matching what every dynamic route did inline before
 * this helper existed. Postgres raises 22P02 on a bad uuid, so the check has to
 * happen before the query or the caller gets a 500.
 */
export function invalidIdResponse(): NextResponse {
  return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
}

// Each refusal builds its own NextResponse: a response body is consumable
// once, so a shared singleton would come back empty on the second route to
// refuse in the same process.
function denyNotFound(): Denied {
  return { ok: false, response: notFoundResponse() };
}

function denyInvalidId(): Denied {
  return { ok: false, response: invalidIdResponse() };
}

/**
 * Resolve the level a session has on an assessment row.
 *
 * Slice 1: owner → `own`, everyone else → nothing. Slice 2 adds admin and the
 * highest covering grant here, and nothing above this function changes.
 */
function resolveAssessmentLevel(
  session: SessionPayload,
  assessment: AssessmentRow,
): { level: AccessLevel; via: AccessVia } | null {
  if (assessment.owner_sub === session.sub) return { level: "own", via: "owner" };
  return null;
}

function resolveOwnerSubLevel(
  session: SessionPayload,
  ownerSub: string,
): { level: AccessLevel; via: AccessVia } | null {
  if (ownerSub === session.sub) return { level: "own", via: "owner" };
  return null;
}

async function loadAssessment(
  db: Db,
  id: string,
): Promise<AssessmentRow | undefined> {
  const [row] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, id))
    .limit(1);
  return row;
}

/**
 * Authorize a session against one assessment.
 *
 * The id is validated here rather than by each caller so a route cannot forget
 * it; callers that already validated pay one cheap regex.
 */
export async function authorizeAssessment(
  db: Db,
  session: SessionPayload,
  assessmentId: string,
  need: AccessLevel,
): Promise<AssessmentAccess> {
  if (!UUID_RE.test(assessmentId)) return denyInvalidId();
  const assessment = await loadAssessment(db, assessmentId);
  if (!assessment) return denyNotFound();
  const resolved = resolveAssessmentLevel(session, assessment);
  if (!resolved || !levelSatisfies(resolved.level, need)) return denyNotFound();
  return { ok: true, assessment, level: resolved.level, via: resolved.via };
}

/**
 * Authorize a session against one sitting, THROUGH its assessment.
 *
 * `test_sessions.owner_sub` exists and is the teacher who created the sitting,
 * but the access question is about the assessment: once co-teaching exists, a
 * sitting the lead started is one the co-teacher must be able to monitor. So
 * the assessment is the authority, and the sitting's own `owner_sub` becomes
 * provenance rather than permission.
 */
export async function authorizeSitting(
  db: Db,
  session: SessionPayload,
  sittingId: string,
  need: AccessLevel,
): Promise<SittingAccess> {
  if (!UUID_RE.test(sittingId)) return denyInvalidId();
  const [sitting] = await db
    .select()
    .from(test_sessions)
    .where(eq(test_sessions.id, sittingId))
    .limit(1);
  if (!sitting) return denyNotFound();
  const assessment = await loadAssessment(db, sitting.assessment_id);
  if (!assessment) return denyNotFound();
  const resolved = resolveAssessmentLevel(session, assessment);
  if (!resolved || !levelSatisfies(resolved.level, need)) return denyNotFound();
  return {
    ok: true,
    sitting,
    assessment,
    level: resolved.level,
    via: resolved.via,
  };
}

/** Authorize a session against one attempt, through its assessment. */
export async function authorizeAttempt(
  db: Db,
  session: SessionPayload,
  attemptId: string,
  need: AccessLevel,
): Promise<AttemptAccess> {
  if (!UUID_RE.test(attemptId)) return denyInvalidId();
  const [attempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .limit(1);
  if (!attempt) return denyNotFound();
  const assessment = await loadAssessment(db, attempt.assessment_id);
  if (!assessment) return denyNotFound();
  const resolved = resolveAssessmentLevel(session, assessment);
  if (!resolved || !levelSatisfies(resolved.level, need)) return denyNotFound();
  return {
    ok: true,
    attempt,
    assessment,
    level: resolved.level,
    via: resolved.via,
  };
}

/**
 * Authorize a session against one accommodations-overlay student row.
 *
 * `students` is the per-teacher overlay (`owner_sub`), not the roster — the
 * roster is read by email and has its own visibility rule, untouched here.
 */
export async function authorizeStudent(
  db: Db,
  session: SessionPayload,
  studentId: string,
  need: AccessLevel,
): Promise<StudentAccess> {
  if (!UUID_RE.test(studentId)) return denyInvalidId();
  const [student] = await db
    .select()
    .from(students)
    .where(eq(students.id, studentId))
    .limit(1);
  if (!student) return denyNotFound();
  const resolved = resolveOwnerSubLevel(session, student.owner_sub);
  if (!resolved || !levelSatisfies(resolved.level, need)) return denyNotFound();
  return { ok: true, student, level: resolved.level, via: resolved.via };
}

/** Authorize a session against one rubric (`rubrics.owner_sub`). */
export async function authorizeRubric(
  db: Db,
  session: SessionPayload,
  rubricId: string,
  need: AccessLevel,
): Promise<RubricAccess> {
  if (!UUID_RE.test(rubricId)) return denyInvalidId();
  const [rubric] = await db
    .select()
    .from(rubrics)
    .where(eq(rubrics.id, rubricId))
    .limit(1);
  if (!rubric) return denyNotFound();
  const resolved = resolveOwnerSubLevel(session, rubric.owner_sub);
  if (!resolved || !levelSatisfies(resolved.level, need)) return denyNotFound();
  return { ok: true, rubric, level: resolved.level, via: resolved.via };
}

/** Authorize a session against one asset (`assets.owner_sub`). */
export async function authorizeAsset(
  db: Db,
  session: SessionPayload,
  assetId: string,
  need: AccessLevel,
): Promise<AssetAccess> {
  if (!UUID_RE.test(assetId)) return denyInvalidId();
  const [asset] = await db
    .select()
    .from(assets)
    .where(eq(assets.id, assetId))
    .limit(1);
  if (!asset) return denyNotFound();
  const resolved = resolveOwnerSubLevel(session, asset.owner_sub);
  if (!resolved || !levelSatisfies(resolved.level, need)) return denyNotFound();
  return { ok: true, asset, level: resolved.level, via: resolved.via };
}

/**
 * The dashboard's equivalents: a page has no NextResponse to return, it calls
 * `notFound()`. Rather than teach every page to unwrap a response it will
 * throw away, these answer the row or null.
 */
export async function pageAssessment(
  db: Db,
  session: SessionPayload,
  assessmentId: string,
  need: AccessLevel,
): Promise<AssessmentRow | null> {
  const access = await authorizeAssessment(db, session, assessmentId, need);
  return access.ok ? access.assessment : null;
}

export async function pageSitting(
  db: Db,
  session: SessionPayload,
  sittingId: string,
  need: AccessLevel,
): Promise<{ sitting: TestSessionRow; assessment: AssessmentRow } | null> {
  const access = await authorizeSitting(db, session, sittingId, need);
  return access.ok
    ? { sitting: access.sitting, assessment: access.assessment }
    : null;
}

export async function pageAttempt(
  db: Db,
  session: SessionPayload,
  attemptId: string,
  need: AccessLevel,
): Promise<{ attempt: AttemptRow; assessment: AssessmentRow } | null> {
  const access = await authorizeAttempt(db, session, attemptId, need);
  return access.ok
    ? { attempt: access.attempt, assessment: access.assessment }
    : null;
}

export async function pageStudent(
  db: Db,
  session: SessionPayload,
  studentId: string,
  need: AccessLevel,
): Promise<StudentRow | null> {
  const access = await authorizeStudent(db, session, studentId, need);
  return access.ok ? access.student : null;
}
