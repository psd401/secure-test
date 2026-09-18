import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessment_student_overrides } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { requireDraftStatus } from "@/lib/api/requireDraft";
import { UUID_RE } from "@/lib/uuid";
import { authorizeAssessment, notFoundResponse } from "@/lib/api/access";

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
  // The parent assessment answers the access question (D-3); the override row
  // is then read scoped to it, which still defends against URL-tampering that
  // names an override belonging to a DIFFERENT assessment.
  const access = await authorizeAssessment(db, auth.session, id, "edit");
  if (!access.ok) return access.response;
  const [override] = await db
    .select({ id: assessment_student_overrides.id })
    .from(assessment_student_overrides)
    .where(
      and(
        eq(assessment_student_overrides.id, overrideId),
        eq(assessment_student_overrides.assessment_id, id),
      ),
    )
    .limit(1);
  if (!override) return notFoundResponse();

  // C11: same publish lock as the POST. Removing a student's override on a
  // published assessment is exactly the mutation the panel's disabled controls
  // are meant to prevent.
  const draftGuard = requireDraftStatus(access.assessment.status);
  if (draftGuard) return draftGuard;

  await db
    .delete(assessment_student_overrides)
    .where(eq(assessment_student_overrides.id, overrideId));
  return new NextResponse(null, { status: 204 });
}
