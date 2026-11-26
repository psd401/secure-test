import { NextResponse } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { assessments, items } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { authorizeAssessment, notFoundResponse } from "@/lib/api/access";
import { JSON_BODY_LIMITS, readJsonBody } from "@/lib/api/jsonBody";
import { lockAssessmentForPoints } from "@/lib/api/competencyLock";
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
 * a competency assessment, so the two must not meet. Both sides decide under
 * the assessment's row lock (lib/api/competencyLock.ts), so two concurrent
 * requests cannot both succeed.
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

  // B1 D6: decided under the assessment's row lock, the same lock a weighted
  // item save takes (lib/api/competencyLock.ts), so a concurrent save either
  // commits first and is seen here, or waits and then sees this conversion.
  const outcome = await db.transaction(async (tx) => {
    if ((await lockAssessmentForPoints(tx, id)) === null) return { kind: "gone" as const };
    const weighted = await tx
      .select({ position: items.position })
      .from(items)
      .where(and(eq(items.assessment_id, id), isNotNull(items.points)))
      .orderBy(items.position);
    if (weighted.length > 0) {
      return { kind: "weighted" as const, questions: weighted.map((w) => w.position + 1) };
    }
    const [row] = await tx
      .update(assessments)
      .set({
        assigned_scope: "district",
        competency_pass_min_points: parsed.data.pass_min_points_per_criterion,
        updated_at: new Date(),
      })
      .where(eq(assessments.id, id))
      .returning();
    return { kind: "ok" as const, row: row! };
  });
  if (outcome.kind === "gone") return notFoundResponse();
  if (outcome.kind === "weighted") {
    return NextResponse.json(
      {
        ok: false,
        error: "items_have_points",
        questions: outcome.questions,
        hint: "Clear Points on these questions first: a competency assessment scores on rubric points.",
      },
      { status: 409 },
    );
  }
  const updated = outcome.row;
  return NextResponse.json({ assessment: updated });
}
