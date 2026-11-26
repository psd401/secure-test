import { NextResponse } from "next/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { assessments, items } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { authorizeAssessment, notFoundResponse } from "@/lib/api/access";
import { JSON_BODY_LIMITS, readJsonBody } from "@/lib/api/jsonBody";
import { isCompetencyAdmin } from "@/lib/auth/admin";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const CompetencyBody = z
  .object({
    pass_min_points_per_criterion: z.number().min(0).max(100),
  })
  .strict();

/**
 * Make this a competency assessment (docs/competency-assessment-design.md,
 * slice 1): `assigned_scope` becomes "district" and the pass rule is stored.
 * Sending it again changes the rule.
 *
 * A dedicated route rather than a PATCH field, for the reason `assigned_scope`
 * was kept off the authoring API: only Assessment staff (D-14,
 * `COMPETENCY_ADMIN_EMAILS`) may hand an assessment down from the district,
 * and only on an assessment they own — a listed person cannot claim someone
 * else's test, and an owner who is not listed cannot mark their own. A
 * session not on the list gets a 404, as the admin-only grants API does.
 *
 * B1 (docs/point-weighting-design.md, D6): refused with 409
 * `items_have_points` while any question carries a point weight — the pass
 * rule reads rubric criterion points, and the item routes refuse a weight on
 * a competency assessment, so the two must not meet. The check is inside the
 * UPDATE (NOT EXISTS), so it holds at the moment of the write.
 */
export async function PUT(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  if (!isCompetencyAdmin(auth.session)) return notFoundResponse();
  const bodyRead = await readJsonBody(req, JSON_BODY_LIMITS.default);
  if (!bodyRead.ok) return bodyRead.response;
  let raw: unknown = null;
  try {
    raw = bodyRead.parse();
  } catch {
    // Malformed JSON falls through to the schema's refusal below.
  }
  const parsed = CompetencyBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "own", "write");
  if (!access.ok) return access.response;

  const [updated] = await db
    .update(assessments)
    .set({
      assigned_scope: "district",
      competency_pass_min_points: parsed.data.pass_min_points_per_criterion,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(assessments.id, id),
        sql`NOT EXISTS (SELECT 1 FROM ${items} WHERE ${items.assessment_id} = ${id} AND ${items.points} IS NOT NULL)`,
      ),
    )
    .returning();
  if (!updated) {
    // The access check found the assessment, so the only way to update
    // nothing is a question with points.
    const weighted = await db
      .select({ position: items.position })
      .from(items)
      .where(and(eq(items.assessment_id, id), isNotNull(items.points)))
      .orderBy(items.position);
    return NextResponse.json(
      {
        ok: false,
        error: "items_have_points",
        questions: weighted.map((w) => w.position + 1),
        hint: "Clear Points on these questions first: a competency assessment scores on rubric points.",
      },
      { status: 409 },
    );
  }
  return NextResponse.json({ assessment: updated });
}
