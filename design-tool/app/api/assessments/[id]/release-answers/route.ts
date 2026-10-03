import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { authorizeAssessment } from "@/lib/api/access";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Release answers (docs/instant-feedback-design.md, D-4): from now on, a
 * student's own hand-in at the `answers` level shows the key for each missed
 * question. Earlier hand-ins are not revisited (9.1 / 9.4 — no "See my
 * results" in v1).
 *
 * A dedicated POST rather than a PATCH field: the stamp is a server instant,
 * not a value a teacher sends, and keeping it off `UpdateAssessmentBody` means
 * neither the settings PATCH nor the publish-lock exception has to reason
 * about it.
 *
 * `edit` level — a co-teacher who can change the feedback setting can release.
 * Allowed while Published (the usual case: after the last period). Refused
 * with 409 `not_answers_level` unless the setting is `answers`, because a
 * release at any other level would do nothing visible and would silently
 * pre-release the key if the teacher later raised the level. Idempotent: an
 * already-released assessment keeps its original stamp.
 */
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "edit");
  if (!access.ok) return access.response;

  if (access.assessment.student_feedback !== "answers") {
    return NextResponse.json(
      { ok: false, error: "not_answers_level" },
      { status: 409 },
    );
  }
  if (access.assessment.answers_released_at !== null) {
    return NextResponse.json({ assessment: access.assessment, already_released: true });
  }

  const now = new Date();
  // `isNull` keeps a concurrent second press from moving the stamp.
  const [updated] = await db
    .update(assessments)
    .set({ answers_released_at: now, updated_at: now })
    .where(and(eq(assessments.id, id), isNull(assessments.answers_released_at)))
    .returning();
  if (!updated) {
    const [current] = await db.select().from(assessments).where(eq(assessments.id, id));
    return NextResponse.json({ assessment: current, already_released: true });
  }
  return NextResponse.json({ assessment: updated, already_released: false });
}
