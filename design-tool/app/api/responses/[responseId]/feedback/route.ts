import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { loadResponseChain } from "@/lib/api/reviewActions";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { JSON_BODY_LIMITS, readJsonBody } from "@/lib/api/jsonBody";
import { TeacherFeedbackBody } from "@/lib/teacherFeedback/body";
import { clearResponseFeedback, setResponseFeedback } from "@/lib/teacherFeedback/write";

interface RouteContext {
  params: Promise<{ responseId: string }>;
}

/**
 * Teacher feedback on one question (docs/feedback-release-design.md, D-4 /
 * D-12): one comment per response, edited in place by any edit-level teacher;
 * the last editor is recorded. Not shown to students yet (slice 2).
 *
 * The same door as the score routes: `loadResponseChain` authorizes at `edit`
 * with write intent, answers 404 for a missing response or one the caller
 * cannot reach, and 400 `attempt_not_submitted` while the student is still
 * working.
 *
 * D-14: the refusals never echo the body — no Zod detail, which could quote
 * the text back into whatever logs the response.
 */
export async function PUT(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { responseId } = await ctx.params;
  if (!UUID_RE.test(responseId)) {
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

  const chain = await loadResponseChain(responseId, auth.session);
  if (!chain.ok) {
    return NextResponse.json({ ok: false, error: chain.error }, { status: chain.status });
  }

  const { feedback, unchanged } = await setResponseFeedback(
    getDb(),
    {
      response_id: chain.response.id,
      attempt_id: chain.response.attempt_id,
      item_id: chain.response.item_id,
    },
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
  const { responseId } = await ctx.params;
  if (!UUID_RE.test(responseId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const chain = await loadResponseChain(responseId, auth.session);
  if (!chain.ok) {
    return NextResponse.json({ ok: false, error: chain.error }, { status: chain.status });
  }

  const { deleted } = await clearResponseFeedback(getDb(), {
    response_id: chain.response.id,
    attempt_id: chain.response.attempt_id,
    item_id: chain.response.item_id,
  });
  return NextResponse.json({ ok: true, deleted });
}
