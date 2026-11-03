import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { competency_assignments, roster_students } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { notFoundResponse } from "@/lib/api/access";
import { JSON_BODY_LIMITS, readJsonBody } from "@/lib/api/jsonBody";
import { authorizeCompetency, canTransition, isOptionOf } from "@/lib/competency/assignments";
import { attemptForStudent, loadCaseStates } from "@/lib/competency/caseState";
import { passBackAttempt } from "@/lib/api/passBackAttempt";
import { attemptIsTimed } from "@/lib/api/attemptDeadline";
import { isUniqueViolation } from "@/lib/db/isUniqueViolation";
import { normalizeEmail } from "@/lib/roster/queries";
import { roleForEmail } from "@/lib/auth/roles";

interface RouteContext {
  params: Promise<{ id: string; assignmentId: string }>;
}

const PatchAssignmentBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("withdraw") }).strict(),
  z.object({ action: z.literal("release") }).strict(),
  // F-1 (hand-run 2026-11-02): one action for D-18's switch.
  z
    .object({
      action: z.literal("switch_option"),
      item_set_id: z.string().regex(UUID_RE),
      proctor_email: z.string().trim().min(3).max(320).optional(),
      ends_at: z.string().datetime().optional(),
    })
    .strict(),
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
 *
 * `switch_option` (F-1, D-18) withdraws this case and assigns the student
 * another option in one transaction — same proctor unless a new one is
 * given — and, when the student's one attempt is already handed in, passes
 * it back through the ordinary pass back (old scores kept as superseded, a
 * `passed_back` event), so the student can start the new option. A counselor
 * may switch their school's students: this is the one pass back they can
 * cause, and only as part of a switch (D-15 stands everywhere else). A timed
 * attempt needs `ends_at`, as the pass-back route does.
 */
class SwitchConflict extends Error {}
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
  // Slice 8: a counselor changes their schools' cases only, and never
  // releases — Release is Assessment's review (D-10).
  if (access.schools) {
    if (parsed.data.action === "release") return notFoundResponse();
    const [student] = await db
      .select({ school_id: roster_students.school_id })
      .from(roster_students)
      .where(eq(roster_students.ps_id, current.student_ps_id))
      .limit(1);
    if (!student?.school_id || !access.schools.includes(student.school_id)) return notFoundResponse();
  }
  if (current.status === "withdrawn") {
    return NextResponse.json({ ok: false, error: "assignment_withdrawn" }, { status: 409 });
  }

  const now = new Date();
  if (parsed.data.action === "switch_option") {
    const body = parsed.data;
    if (body.item_set_id === current.item_set_id || !(await isOptionOf(db, id, body.item_set_id))) {
      return NextResponse.json({ ok: false, error: "unknown_option" }, { status: 400 });
    }
    let proctor = current.proctor_email;
    if (body.proctor_email !== undefined) {
      const next = normalizeEmail(body.proctor_email);
      if (!next || roleForEmail(next, true) !== "staff") {
        return NextResponse.json({ ok: false, error: "proctor_not_staff" }, { status: 400 });
      }
      proctor = next;
    }
    const attempt = await attemptForStudent(db, access.assessment, current.student_ps_id);
    const reopen = attempt?.status === "submitted";
    let endsAt: Date | null = null;
    if (attempt && reopen && attemptIsTimed(attempt, access.assessment)) {
      if (!body.ends_at) {
        return NextResponse.json({ ok: false, error: "ends_at_required" }, { status: 400 });
      }
      endsAt = new Date(Date.parse(body.ends_at));
      if (endsAt <= now) return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
    }
    const switcher = normalizeEmail(auth.session.email);
    if (!switcher) return notFoundResponse();
    try {
      const created = await db.transaction(async (tx) => {
        const [old] = await tx
          .update(competency_assignments)
          .set({ status: "withdrawn", withdrawn_at: now, updated_at: now })
          .where(and(eq(competency_assignments.id, current.id), eq(competency_assignments.status, current.status)))
          .returning();
        if (!old) throw new SwitchConflict();
        const [row] = await tx
          .insert(competency_assignments)
          .values({
            assessment_id: id,
            student_ps_id: current.student_ps_id,
            item_set_id: body.item_set_id,
            proctor_email: proctor,
            assigned_by_sub: auth.session.sub,
            assigned_by_email: switcher,
          })
          .returning();
        if (attempt && reopen) {
          // The pass back's own transaction nests as a savepoint, so a
          // failure there rolls the whole switch back.
          await passBackAttempt(tx as unknown as typeof db, attempt, auth.session.sub, { endsAt, now });
        }
        return row!;
      });
      return NextResponse.json({ assignment: created, reopened: reopen });
    } catch (err) {
      if (err instanceof SwitchConflict) {
        return NextResponse.json({ ok: false, error: "assignment_changed" }, { status: 409 });
      }
      if (isUniqueViolation(err)) {
        return NextResponse.json({ ok: false, error: "already_assigned" }, { status: 409 });
      }
      throw err;
    }
  }
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
