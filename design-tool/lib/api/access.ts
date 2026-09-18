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
  type AccessGrantScope,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import { isAdmin } from "@/lib/auth/admin";
import type { SessionPayload } from "@/lib/auth/session";
import { UUID_RE } from "@/lib/uuid";
import { effectiveLevel } from "@/lib/api/grants";
import {
  levelSatisfies,
  type AccessLevel,
  type AccessVia,
} from "@/lib/api/accessLevels";

type Db = ReturnType<typeof getDb>;

/**
 * The access ladder (docs/access-model-design.md, D-2).
 *
 * `view` (results and monitor, read-only) < `run` (sittings, monitor actions,
 * hand in, extend) < `edit` (items, settings, publish, scoring) < `own`
 * (share, archive, delete, grant). Every caller names the level it needs; slice
 * 1 resolved only the owner, and slice 2 widened resolution here — to admins
 * (D-1) and to `access_grants` (D-2) — without a route changing shape.
 *
 * Re-exported from `lib/api/accessLevels.ts`, which exists only to keep this
 * module and `lib/api/grants.ts` out of an import cycle. Routes import from
 * here, as they always have.
 */
export {
  ACCESS_LEVELS,
  levelSatisfies,
  isAccessLevel,
  maxLevel,
} from "@/lib/api/accessLevels";
export type { AccessLevel, AccessVia } from "@/lib/api/accessLevels";

type Denied = { ok: false; response: NextResponse };

/**
 * What every `ok: true` result carries beside its row.
 *
 * `scope` is the grant scope the level came through, or null for an owner or an
 * admin. Sitting creation is the one caller that must know (D-5): a
 * `teacher`-scoped grant means a substitute, and the sitting it creates stays
 * the granting teacher's.
 */
interface Resolved {
  level: AccessLevel;
  via: AccessVia;
  scope: AccessGrantScope | null;
}

export type AssessmentAccess =
  | ({ ok: true; assessment: AssessmentRow } & Resolved)
  | Denied;

export type SittingAccess =
  | ({ ok: true; sitting: TestSessionRow; assessment: AssessmentRow } & Resolved)
  | Denied;

export type AttemptAccess =
  | ({ ok: true; attempt: AttemptRow; assessment: AssessmentRow } & Resolved)
  | Denied;

export type StudentAccess = ({ ok: true; student: StudentRow } & Resolved) | Denied;

export type RubricAccess = ({ ok: true; rubric: RubricRow } & Resolved) | Denied;

export type AssetAccess = ({ ok: true; asset: AssetRow } & Resolved) | Denied;

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
 * Owner → `own`; admin → `own` via `"admin"` (D-1/D-6); else the highest
 * unexpired, unrevoked grant covering the row (D-2), by assessment id or
 * through the owner's email. `lib/api/grants.ts` owns that order so the list
 * queries resolve identically; this function is the single-row door to it.
 */
async function resolveAssessmentLevel(
  db: Db,
  session: SessionPayload,
  assessment: AssessmentRow,
): Promise<Resolved | null> {
  return effectiveLevel(db, session, assessment);
}

/**
 * The per-teacher tables — the accommodations overlay (`students`), the rubric
 * library, uploaded assets. These are NOT per-assessment, so no assessment
 * grant reaches them: a co-teacher edits the shared assessment, not the other
 * teacher's whole rubric shelf. An admin still resolves, because D-6 says an
 * admin reads everything.
 */
function resolveOwnerSubLevel(
  session: SessionPayload,
  ownerSub: string,
): Resolved | null {
  if (ownerSub === session.sub) return { level: "own", via: "owner", scope: null };
  if (isAdmin(session)) return { level: "own", via: "admin", scope: null };
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
  const resolved = await resolveAssessmentLevel(db, session, assessment);
  if (!resolved || !levelSatisfies(resolved.level, need)) return denyNotFound();
  return { ok: true, assessment, ...resolved };
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
  const resolved = await resolveAssessmentLevel(db, session, assessment);
  if (!resolved || !levelSatisfies(resolved.level, need)) return denyNotFound();
  return { ok: true, sitting, assessment, ...resolved };
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
  const resolved = await resolveAssessmentLevel(db, session, assessment);
  if (!resolved || !levelSatisfies(resolved.level, need)) return denyNotFound();
  return { ok: true, attempt, assessment, ...resolved };
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
  return { ok: true, student, ...resolved };
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
  return { ok: true, rubric, ...resolved };
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
  return { ok: true, asset, ...resolved };
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
