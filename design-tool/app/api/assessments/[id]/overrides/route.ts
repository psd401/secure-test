import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessment_student_overrides, students } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { requireDraft } from "@/lib/api/requireDraft";
import { UpsertOverrideBody } from "@/lib/api/overrides";
import { UUID_RE } from "@/lib/uuid";
import { authorizeAssessment } from "@/lib/api/access";
import { exceptionTargetFor } from "@/lib/accommodations/coTeacherRecords";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const access = await authorizeAssessment(getDb(), auth.session, id, "edit");
  if (!access.ok) return access.response;
  const db = getDb();
  const rows = await db
    .select({
      id: assessment_student_overrides.id,
      assessment_id: assessment_student_overrides.assessment_id,
      student_id: assessment_student_overrides.student_id,
      student_ssid: students.ssid,
      student_name: students.name,
      tool_id: assessment_student_overrides.tool_id,
      value: assessment_student_overrides.value,
      created_by_sub: assessment_student_overrides.created_by_sub,
      created_at: assessment_student_overrides.created_at,
      updated_at: assessment_student_overrides.updated_at,
    })
    .from(assessment_student_overrides)
    .innerJoin(
      students,
      eq(assessment_student_overrides.student_id, students.id),
    )
    .where(eq(assessment_student_overrides.assessment_id, id))
    .orderBy(asc(students.ssid), asc(assessment_student_overrides.tool_id));
  return NextResponse.json({ overrides: rows });
}

export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  let body;
  try {
    body = UpsertOverrideBody.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const access = await authorizeAssessment(getDb(), auth.session, id, "edit");
  if (!access.ok) return access.response;

  // C11: the overrides panel disables its controls when published, but that is
  // a client-side affordance only — this route had no server guard, so a
  // direct call mutated a published assessment's per-student tools with no
  // 409. Per-student accommodations are part of the published artifact.
  const draftGuard = requireDraft(access.assessment);
  if (draftGuard) return draftGuard;

  // Slice 21 invariant lifted: override.tool_id must be present in the
  // assessment's allowed_accommodations. Otherwise an override could
  // grant a tool the assessment doesn't allow.
  const allowed = (access.assessment.allowed_accommodations ?? []) as string[];
  if (!allowed.includes(body.tool_id)) {
    return NextResponse.json(
      {
        ok: false,
        error: "tool_not_in_allowed_accommodations",
        hint: "Add the tool to the assessment's allowed_accommodations first.",
      },
      { status: 400 },
    );
  }

  const db = getDb();
  // F-1 (docs/coteach-and-section-accommodations-design.md, 13.5): the
  // exception attaches to the ASSESSMENT OWNER's row for the child — the only
  // row delivery and the preview read. A co-teacher (edit) may name the
  // owner's row or their own row for the child, which is mapped to the
  // owner's. Anything else stays a 404 (`student_not_found`, so the client
  // can tell which of the two ids was the problem).
  const target = await exceptionTargetFor(db, access.assessment, auth.session.sub, body.student_id);
  if (!target.ok) {
    return NextResponse.json(
      { ok: false, error: target.error },
      { status: target.error === "student_not_found" ? 404 : 400 },
    );
  }

  const now = new Date();
  // Upsert by composite key — POSTing the same (assessment, student,
  // tool) replaces the prior value rather than 409ing. Simpler client
  // story than a separate PATCH endpoint.
  const [row] = await db
    .insert(assessment_student_overrides)
    .values({
      assessment_id: id,
      student_id: target.studentId,
      tool_id: body.tool_id,
      value: body.value,
      created_by_sub: auth.session.sub,
    })
    .onConflictDoUpdate({
      target: [
        assessment_student_overrides.assessment_id,
        assessment_student_overrides.student_id,
        assessment_student_overrides.tool_id,
      ],
      set: { value: body.value, updated_at: now },
    })
    .returning();
  return NextResponse.json({ override: row }, { status: 201 });
}
