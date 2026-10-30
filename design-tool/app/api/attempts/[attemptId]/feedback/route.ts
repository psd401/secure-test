import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAttempt } from "@/lib/api/access";
import { UUID_RE } from "@/lib/uuid";
import { JSON_BODY_LIMITS, readJsonBody } from "@/lib/api/jsonBody";
import { TeacherFeedbackBody } from "@/lib/teacherFeedback/body";
import { clearAttemptFeedback, setAttemptFeedback } from "@/lib/teacherFeedback/write";

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

/**
 * Overall teacher feedback on an attempt (docs/feedback-release-design.md,
 * D-4 / D-12): one comment per student, edited in place by any edit-level
 * teacher; the last editor is recorded. Not shown to students yet (slice 2).
 *
 * `edit` with write intent through `authorizeAttempt`, refused with the same
 * 404 as the per-question route. Like that route (via `loadResponseChain`), a
 * handed-in attempt only: 400 `attempt_not_submitted` while the student is
 * still working.
 *
 * D-14: the refusals never echo the body.
 */
export async function PUT(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const bodyRead = await readJsonBody(req, JSON_BODY_LIMITS.default);
  if (!bodyRead.ok) return bodyRead.response;
  let body: TeacherFeedbackBody;
  try {
    body = TeacherFeedbackBody.parse(bodyRead.parse());
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const access = await authorizeAttempt(db, auth.session, attemptId, "edit", "write");
  if (!access.ok) return access.response;
  if (access.attempt.status !== "submitted") {
    return NextResponse.json({ ok: false, error: "attempt_not_submitted" }, { status: 400 });
  }

  const { feedback, unchanged } = await setAttemptFeedback(
    db,
    access.attempt.id,
    body.text,
    auth.session.sub,
  );
  return NextResponse.json({
    ok: true,
    feedback: {
      text: feedback.text,
      author_sub: feedback.author_sub,
      updated_at: feedback.updated_at,
    },
    ...(unchanged ? { unchanged: true } : {}),
  });
}

/** Clear the comment. Idempotent: nothing to clear is still 200. */
export async function DELETE(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const access = await authorizeAttempt(db, auth.session, attemptId, "edit", "write");
  if (!access.ok) return access.response;
  if (access.attempt.status !== "submitted") {
    return NextResponse.json({ ok: false, error: "attempt_not_submitted" }, { status: 400 });
  }

  const { deleted } = await clearAttemptFeedback(db, access.attempt.id);
  return NextResponse.json({ ok: true, deleted });
}
