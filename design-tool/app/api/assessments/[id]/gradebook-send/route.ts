import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeSend } from "@/lib/gradebook/authorizeSend";
import { GradebookConfigError, getPowerSchoolClient } from "@/lib/gradebook/powerschool";
import { sendToPowerSchool, todayPacific } from "@/lib/gradebook/sendPowerSchool";
import { log } from "@/lib/log";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const Body = z.object({
  // Both targets are named so slice 3 changes a branch, not the contract.
  target: z.enum(["powerschool", "schoology"]),
  section_ps_id: z.string().trim().min(1).max(64),
  category_id: z.string().trim().min(1).max(64),
  // Default: the assessment's title. Cut to 50 characters for PTP.
  name: z.string().trim().min(1).max(200).optional(),
  // 8.1: default = today in Pacific time.
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "invalid date")
    .optional(),
  // 8.2: the category's own default; the only value accepted until Teaching
  // & Learning decides otherwise.
  publish: z.literal("teacher_default").optional(),
});

/**
 * Send to gradebook (docs/gradebook-push-design.md, "The send").
 *
 * One destination, one section (D-1). Authorized twice by `authorizeSend`:
 * `edit` on the assessment, then the sender must currently teach the section
 * — both refusals are 404. Only fully scored attempts are written (D-3);
 * the rest are counted in `held_back`. A re-send reuses the stored
 * assignment, updates changed scores and skips unchanged ones (D-7).
 *
 * Answers `{ ok, sent, updated, skipped_unchanged, held_back: {count,
 * reasons}, failed: [{student_number, reason}], notes, ... }`. Student numbers
 * appear in the response for the teacher; they are never logged.
 */
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const body = parsed.data;

  const db = getDb();
  const access = await authorizeSend(db, auth.session, id, body.section_ps_id);
  if (!access.ok) return access.response;

  if (body.target !== "powerschool") {
    return NextResponse.json({ ok: false, error: "unsupported_target" }, { status: 400 });
  }

  let client;
  try {
    client = getPowerSchoolClient();
  } catch (err) {
    if (err instanceof GradebookConfigError) {
      log.error("gradebook_not_configured", { target: "powerschool" });
      return NextResponse.json({ ok: false, error: "gradebook_not_configured" }, { status: 503 });
    }
    throw err;
  }

  const outcome = await sendToPowerSchool(db, client, {
    assessment: access.assessment,
    section: access.section,
    teacher: access.teacher,
    actor_sub: access.actor_sub,
    category_id: body.category_id,
    name: body.name ?? access.assessment.name,
    due_date: body.due_date ?? todayPacific(),
  });
  if (!outcome.ok) {
    return NextResponse.json(
      { ok: false, error: outcome.error, ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}) },
      { status: outcome.status },
    );
  }
  return NextResponse.json({ ok: true, ...outcome.summary });
}
