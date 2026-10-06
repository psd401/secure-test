import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { response_revisions } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAttempt, notFoundResponse } from "@/lib/api/access";
import { sessionOpenResponse, sittingIsOpen } from "@/lib/api/staffAttempt";
import { restoreAnswerVersion } from "@/lib/api/restoreAnswer";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ revisionId: string }>;
}

/**
 * Answer history slice 2 (docs/answer-history-design.md): make an earlier
 * version of a text answer the current one.
 *
 * Edit level on the attempt's assessment (D-4), 404 for everyone else — the
 * revision id says nothing about who may see it. Refused 409 `session_open`
 * while an open sitting holds an in-progress attempt: the student's client
 * would overwrite the restored text with its next autosave. A handed-in
 * attempt can be restored at any time; its old scores for that answer are set
 * aside and the restored answer is left for the teacher to score.
 */
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { revisionId } = await ctx.params;
  if (!UUID_RE.test(revisionId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const [revision] = await db
    .select()
    .from(response_revisions)
    .where(eq(response_revisions.id, revisionId))
    .limit(1);
  if (!revision) return notFoundResponse();

  const access = await authorizeAttempt(db, auth.session, revision.attempt_id, "edit");
  if (!access.ok) return access.response;
  if (await sittingIsOpen(db, access.attempt)) return sessionOpenResponse();

  const result = await restoreAnswerVersion(db, access.attempt, revision);
  return NextResponse.json({
    ok: true,
    unchanged: result.unchanged,
    superseded_scores: result.superseded_scores,
    attempt_status: access.attempt.status,
  });
}
