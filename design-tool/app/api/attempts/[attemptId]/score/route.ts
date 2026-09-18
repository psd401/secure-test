import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { runAutoScoringPass } from "@/lib/scoring/runAutoScoring";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { authorizeAttempt } from "@/lib/api/access";

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

// Slice 37: run the auto engine over one submitted attempt. Only items
// whose effective scoring method is "auto" are touched — ai/human/hybrid
// items are left for slices 38/39. Auto scores are final immediately
// (objective key, nothing to review). Idempotent: a response that already
// has a final score is skipped, never re-scored — changing an answer key
// after scoring is a slice-39 (override) concern, not a silent re-run.
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { attemptId } = await ctx.params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const access = await authorizeAttempt(db, auth.session, attemptId, "edit");
  if (!access.ok) return access.response;
  const attempt = access.attempt;
  if (attempt.status !== "submitted") {
    return NextResponse.json(
      { ok: false, error: "attempt_not_submitted" },
      { status: 400 },
    );
  }

  const summary = await runAutoScoringPass(db, attempt);

  return NextResponse.json({ ok: true, ...summary });
}
