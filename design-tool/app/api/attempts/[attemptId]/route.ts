import { NextResponse } from "next/server";
import { count, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  assessments,
  attempt_deletions,
  attempt_events,
  attempts,
  response_uploads,
  responses,
  test_sessions,
} from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { log } from "@/lib/log";
import { getStorageProviderById } from "@/lib/storage/provider";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

/**
 * Delete one student's attempt (roadmap 2026-09, the 2026-09-07 finding):
 * attempts are unique per (assessment, student) and `POST /api/attempts`
 * resumes the existing one — a submitted one included — so without this a
 * student who has handed in can never sit the same assessment again, and a
 * wrong-student join can never be undone. The next join creates a fresh
 * attempt.
 *
 * Owner-only (D-R5): staff the assessment is shared with can score but not
 * erase a student's record. The DB cascades take responses, scores, uploads,
 * events and peek requests with the attempt; the stored upload bytes do not
 * cascade, so their keys are read first and deleted best-effort after the
 * commit (the assets route's pattern — an orphaned object is harmless, a
 * half-deleted attempt is not). The audit row is written in the same
 * transaction, into `attempt_deletions` because `attempt_events` goes with
 * the attempt.
 *
 * An in-progress attempt whose test session is still open is refused with
 * 409 `session_open`: the student may be locked in and mid-answer, and their
 * next save would 404 under them. Close the session first; the monitor's
 * button says so.
 */
export async function DELETE(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const [attempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .limit(1);
  if (!attempt) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const [assessment] = await db
    .select({ owner_sub: assessments.owner_sub })
    .from(assessments)
    .where(eq(assessments.id, attempt.assessment_id))
    .limit(1);
  if (!assessment || assessment.owner_sub !== auth.session.sub) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  if (attempt.status !== "submitted" && attempt.test_session_id) {
    const [sitting] = await db
      .select({ status: test_sessions.status })
      .from(test_sessions)
      .where(eq(test_sessions.id, attempt.test_session_id))
      .limit(1);
    if (sitting?.status === "open") {
      return NextResponse.json({ ok: false, error: "session_open" }, { status: 409 });
    }
  }

  const uploads = await db
    .select({
      storage_provider: response_uploads.storage_provider,
      storage_key: response_uploads.storage_key,
    })
    .from(response_uploads)
    .where(eq(response_uploads.attempt_id, attemptId));

  await db.transaction(async (tx) => {
    const [r] = await tx
      .select({ n: count() })
      .from(responses)
      .where(eq(responses.attempt_id, attemptId));
    const [e] = await tx
      .select({ n: count() })
      .from(attempt_events)
      .where(eq(attempt_events.attempt_id, attemptId));
    await tx.insert(attempt_deletions).values({
      attempt_id: attempt.id,
      assessment_id: attempt.assessment_id,
      student_id: attempt.student_id,
      deleted_by_sub: auth.session.sub,
      attempt_status: attempt.status,
      attempt_started_at: attempt.started_at,
      attempt_submitted_at: attempt.submitted_at,
      response_count: r?.n ?? 0,
      upload_count: uploads.length,
      event_count: e?.n ?? 0,
    });
    await tx.delete(attempts).where(eq(attempts.id, attemptId));
  });

  for (const upload of uploads) {
    try {
      await getStorageProviderById(upload.storage_provider).delete(upload.storage_key);
    } catch (err) {
      log.warn("attempt_delete.storage_delete_failed", {
        attempt_id: attemptId,
        storage_provider: upload.storage_provider,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return new NextResponse(null, { status: 204 });
}
