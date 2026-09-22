import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { sessionOpenResponse, sittingIsOpen } from "@/lib/api/staffAttempt";
import { authorizeAttempt } from "@/lib/api/access";
import { deleteAttemptRecord } from "@/lib/api/deleteAttempt";
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
 * erase a student's record. The row delete — cascades plus the
 * `attempt_deletions` audit row — is `deleteAttemptRecord`
 * (lib/api/deleteAttempt.ts), shared with the practice-sitting sweep; the
 * stored upload bytes it hands back are deleted best-effort here, after the
 * commit (an orphaned object is harmless, a half-deleted attempt is not).
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
  // Owner check and the open-sitting guard both live in lib/api/staffAttempt.ts
  // now — the hand-in route (docs/time-limit-and-unfinished-attempts-design.md)
  // applies the identical rules, and they must not be able to drift apart.
  const access = await authorizeAttempt(db, auth.session, attemptId, "run");
  if (!access.ok) return access.response;
  const attempt = access.attempt;

  // Practice again (docs/practice-sitting-design.md, D-6): a practice
  // attempt is the caller's own, so the open-sitting refusal is relaxed —
  // deleting it is how the practice row returns to "Not started yet" while
  // the practice sitting stays open for the next join.
  if (!attempt.practice && (await sittingIsOpen(db, attempt))) return sessionOpenResponse();

  const uploads = await deleteAttemptRecord(db, attempt, auth.session.sub);

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
