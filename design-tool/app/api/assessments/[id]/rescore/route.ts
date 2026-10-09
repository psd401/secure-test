import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAssessment } from "@/lib/api/access";
import { log } from "@/lib/log";
import { applyRescore, loadRescorePlan, type RescorePlan } from "@/lib/scoring/rescore";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const BodySchema = z.object({ dry_run: z.boolean() });

function counts(plan: RescorePlan) {
  return {
    changed: plan.changed,
    unchanged: plan.unchanged,
    kept: plan.kept,
    newly_scored: plan.newly_scored,
    unscorable: plan.unscorable,
    students_changed: plan.students_changed,
    questions: plan.questions,
  };
}

/**
 * "Rescore with current key" from the Results page
 * (docs/rescore-after-key-change-design.md, E11). Level `edit` — the same as
 * Change score, since this changes final scores.
 *
 * `dry_run: true` returns what a rescore would do and writes nothing (the
 * dialog's counts). `dry_run: false` re-plans inside the transaction and
 * writes; a plan with nothing to change answers 409 `nothing_to_rescore`, so a
 * stale button never reports a rescore that did not happen.
 */
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "edit");
  if (!access.ok) return access.response;

  if (parsed.data.dry_run) {
    const plan = await loadRescorePlan(db, id);
    return NextResponse.json({ ok: true, dry_run: true, ...counts(plan) });
  }

  const result = await applyRescore(db, id, auth.session.sub);
  if (result.plan.changes.length === 0) {
    return NextResponse.json({ ok: false, error: "nothing_to_rescore" }, { status: 409 });
  }
  log.info("assessment_rescored", {
    assessment_id: id,
    changed: result.written,
    kept: result.plan.kept,
    skipped_conflict: result.skipped_conflict,
    questions: result.plan.questions.length,
  });
  return NextResponse.json({
    ok: true,
    dry_run: false,
    ...counts(result.plan),
    written: result.written,
    skipped_conflict: result.skipped_conflict,
    sections_sent_before: result.sections_sent_before,
  });
}
