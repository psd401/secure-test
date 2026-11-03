import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { competency_assignments } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { notFoundResponse } from "@/lib/api/access";
import { JSON_BODY_LIMITS, readJsonBody } from "@/lib/api/jsonBody";
import { authorizeCompetency, canTransition } from "@/lib/competency/assignments";
import { loadCaseStates } from "@/lib/competency/caseState";
import { normalizeEmail } from "@/lib/roster/queries";
import { roleForEmail } from "@/lib/auth/roles";

interface RouteContext {
  params: Promise<{ id: string; assignmentId: string }>;
}

const PatchAssignmentBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("withdraw") }).strict(),
  z.object({ action: z.literal("release") }).strict(),
  z
    .object({
      action: z.literal("change_proctor"),
      proctor_email: z.string().trim().min(3).max(320),
    })
    .strict(),
]);

/**
 * Change one case (docs/competency-assessment-design.md, slice 2):
 * `withdraw` ends it (a switch of option is a withdrawal plus a new
 * assignment, D-18 — the old row stays as the record); `change_proctor`
 * hands the student's sittings to someone else; `release` (slice 6, D-10)
 * is Assessment's review — only a case that reads Scored now, and it stores
 * the result the counselor sees. Handed in and Scored are read, never set
 * here (lib/competency/caseState.ts). A withdrawn case cannot be changed.
 */
export async function PATCH(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id, assignmentId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(assignmentId)) {
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
  const parsed = PatchAssignmentBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const [current] = await db
    .select()
    .from(competency_assignments)
    .where(and(eq(competency_assignments.id, assignmentId), eq(competency_assignments.assessment_id, id)))
    .limit(1);
  if (!current) return notFoundResponse();
  if (current.status === "withdrawn") {
    return NextResponse.json({ ok: false, error: "assignment_withdrawn" }, { status: 409 });
  }

  const now = new Date();
  let set: Partial<typeof competency_assignments.$inferInsert>;
  if (parsed.data.action === "withdraw") {
    if (!canTransition(current.status, "withdrawn")) {
      return NextResponse.json({ ok: false, error: "invalid_transition" }, { status: 409 });
    }
    set = { status: "withdrawn", withdrawn_at: now, updated_at: now };
  } else if (parsed.data.action === "release") {
    const state = (await loadCaseStates(db, access.assessment, [current])).get(current.id);
    if (!state || state.status !== "scored" || !state.result || !canTransition(current.status, "released")) {
      return NextResponse.json({ ok: false, error: "not_releasable" }, { status: 409 });
    }
    const releaser = normalizeEmail(auth.session.email);
    if (!releaser) return notFoundResponse();
    set = { status: "released", result: state.result, released_at: now, released_by_email: releaser, updated_at: now };
  } else {
    const proctor = normalizeEmail(parsed.data.proctor_email);
    if (!proctor || roleForEmail(proctor, true) !== "staff") {
      return NextResponse.json({ ok: false, error: "proctor_not_staff" }, { status: 400 });
    }
    set = { proctor_email: proctor, updated_at: now };
  }

  // The status in the WHERE makes a concurrent withdrawal lose cleanly
  // rather than overwrite: zero rows back means someone got there first.
  const [updated] = await db
    .update(competency_assignments)
    .set(set)
    .where(and(eq(competency_assignments.id, assignmentId), eq(competency_assignments.status, current.status)))
    .returning();
  if (!updated) {
    return NextResponse.json({ ok: false, error: "assignment_changed" }, { status: 409 });
  }
  return NextResponse.json({ assignment: updated });
}
