import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { competency_assignments, roster_students } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { notFoundResponse } from "@/lib/api/access";
import { JSON_BODY_LIMITS, readJsonBody } from "@/lib/api/jsonBody";
import { authorizeCompetency, competencyOptions, isOptionOf } from "@/lib/competency/assignments";
import { normalizeEmail } from "@/lib/roster/queries";
import { roleForEmail } from "@/lib/auth/roles";
import { studentDisplayName } from "@/lib/roster/teacherRoster";
import { isUniqueViolation } from "@/lib/db/isUniqueViolation";
import { loadCaseStates } from "@/lib/competency/caseState";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const CreateAssignmentBody = z
  .object({
    student_ps_id: z.string().trim().min(1).max(64),
    item_set_id: z.string().regex(UUID_RE),
    proctor_email: z.string().trim().min(3).max(320),
  })
  .strict();

/**
 * The cases on one competency assessment (docs/competency-assessment-design.md,
 * slices 2 and 6): every assignment, withdrawn ones included as the record, newest
 * first, with the options to assign. Assessment staff only (authorizeCompetency).
 */
export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const access = await authorizeCompetency(db, auth.session, id, "read");
  if (!access.ok) return access.response;

  const options = await competencyOptions(db, id);
  const labelOf = new Map(options.map((o) => [o.item_set_id, o.label]));
  const rows = await db
    .select({ a: competency_assignments, s: roster_students })
    .from(competency_assignments)
    .innerJoin(roster_students, eq(roster_students.ps_id, competency_assignments.student_ps_id))
    .where(
      and(
        eq(competency_assignments.assessment_id, id),
        // Slice 8: a counselor sees their schools' students only.
        access.schools ? inArray(roster_students.school_id, access.schools) : undefined,
      ),
    )
    .orderBy(desc(competency_assignments.created_at));

  const states = await loadCaseStates(
    db,
    access.assessment,
    rows.map((r) => r.a),
  );
  // Slice 8: a counselor sees a result only once Assessment has released it
  // (D-10), and has no results page to review from.
  const counselor = access.schools !== null;
  return NextResponse.json({
    options,
    assignments: rows.map(({ a, s }) => ({
      id: a.id,
      student_ps_id: a.student_ps_id,
      student_name: studentDisplayName(s),
      grade: s.grade,
      item_set_id: a.item_set_id,
      option_label: labelOf.get(a.item_set_id) ?? "Option",
      proctor_email: a.proctor_email,
      // Slice 6: `status` is the case as it reads now (handed in and scored
      // come from the attempt and score); `result` is what the final score
      // yields now; `released_result` is what the counselor was shown.
      status: states.get(a.id)?.status ?? a.status,
      result: counselor ? (a.status === "released" ? a.result : null) : (states.get(a.id)?.result ?? null),
      released_result: a.result,
      released_at: a.released_at,
      attempt_id: counselor ? null : (states.get(a.id)?.attempt_id ?? null),
      created_at: a.created_at,
      withdrawn_at: a.withdrawn_at,
    })),
  });
}

/**
 * Assign a student an option and a proctor (D-5). One live assignment per
 * student per assessment: a second is a 409 until the first is withdrawn.
 */
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const access = await authorizeCompetency(db, auth.session, id, "write");
  if (!access.ok) return access.response;

  const bodyRead = await readJsonBody(req, JSON_BODY_LIMITS.default);
  if (!bodyRead.ok) return bodyRead.response;
  let raw: unknown = null;
  try {
    raw = bodyRead.parse();
  } catch {
    // Malformed JSON falls through to the schema's refusal below.
  }
  const parsed = CreateAssignmentBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const body = parsed.data;

  const proctor = normalizeEmail(body.proctor_email);
  if (!proctor || roleForEmail(proctor, true) !== "staff") {
    return NextResponse.json({ ok: false, error: "proctor_not_staff" }, { status: 400 });
  }
  if (!(await isOptionOf(db, id, body.item_set_id))) {
    return NextResponse.json({ ok: false, error: "unknown_option" }, { status: 400 });
  }
  const [student] = await db
    .select({ ps_id: roster_students.ps_id, is_active: roster_students.is_active, school_id: roster_students.school_id })
    .from(roster_students)
    .where(eq(roster_students.ps_id, body.student_ps_id))
    .limit(1);
  // Slice 8: a counselor assigns their schools' students only — anyone else
  // reads as not on the roster, so the refusal says nothing about them.
  if (!student?.is_active || (access.schools && !access.schools.includes(student.school_id ?? ""))) {
    return NextResponse.json({ ok: false, error: "unknown_student" }, { status: 400 });
  }

  const assignerEmail = normalizeEmail(auth.session.email);
  if (!assignerEmail) return notFoundResponse();
  try {
    const [created] = await db
      .insert(competency_assignments)
      .values({
        assessment_id: id,
        student_ps_id: student.ps_id,
        item_set_id: body.item_set_id,
        proctor_email: proctor,
        assigned_by_sub: auth.session.sub,
        assigned_by_email: assignerEmail,
      })
      .returning();
    return NextResponse.json({ assignment: created }, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json({ ok: false, error: "already_assigned" }, { status: 409 });
    }
    throw err;
  }
}
