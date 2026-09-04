import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, assessment_student_overrides } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { requireDraftStatus } from "@/lib/api/requireDraft";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string; overrideId: string }>;
}

export async function DELETE(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id, overrideId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(overrideId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  // Join the override → assessment so we can gate on the assessment
  // owner. Also confirm the override actually belongs to this
  // assessment (defends against URL-tampering across assessments).
  const [joined] = await db
    .select({
      override: assessment_student_overrides,
      owner_sub: assessments.owner_sub,
      parent_status: assessments.status,
    })
    .from(assessment_student_overrides)
    .innerJoin(
      assessments,
      eq(assessment_student_overrides.assessment_id, assessments.id),
    )
    .where(
      and(
        eq(assessment_student_overrides.id, overrideId),
        eq(assessment_student_overrides.assessment_id, id),
      ),
    )
    .limit(1);
  if (!joined) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (joined.owner_sub !== auth.session.sub) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // C11: same publish lock as the POST. Removing a student's override on a
  // published assessment is exactly the mutation the panel's disabled controls
  // are meant to prevent.
  const draftGuard = requireDraftStatus(joined.parent_status);
  if (draftGuard) return draftGuard;

  await db
    .delete(assessment_student_overrides)
    .where(eq(assessment_student_overrides.id, overrideId));
  return new NextResponse(null, { status: 204 });
}
