import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { getDb } from "@/db/client";
import { OBSERVABILITY_TEXT_MAX, feedback } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { getNotifyPublisher } from "@/lib/notify/provider";
import { log, truncate } from "@/lib/log";

/**
 * Batch 3 slice 3 (docs/observability-design.md): "Send feedback" from the
 * teacher header.
 *
 * Staff-only — students have no button and tell the teacher instead, so this
 * route is a plain `requireStaff()` route (no STUDENT_ROUTES entry needed;
 * `test/auth-role-enforcement.test.ts` enumerates it from disk).
 *
 * The row is the record; the SNS publish is only the notification (D-2/D-9:
 * one topic, alarms + feedback, James filters by subject). A publish failure
 * is logged and swallowed — a teacher who is already frustrated enough to
 * file feedback must not also get a 500.
 */

const MAX_PATH = 500;
const MAX_USER_AGENT = 500;

const Body = z.object({
  message: z
    .string()
    .trim()
    .min(1)
    .max(2000),
  path: z.string().max(MAX_PATH),
});

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

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

  const store = await headers();
  const userAgent = store.get("user-agent");

  const row = {
    sub: auth.session.sub,
    email: auth.session.email ?? auth.session.sub,
    role: auth.session.role ?? "staff",
    path: parsed.data.path,
    message: truncate(parsed.data.message, OBSERVABILITY_TEXT_MAX),
    user_agent: userAgent ? truncate(userAgent, MAX_USER_AGENT) : null,
    app_commit: process.env.APP_COMMIT ?? null,
  };

  const [inserted] = await getDb().insert(feedback).values(row).returning({ id: feedback.id });

  const subject = `[secure-test] Feedback from ${row.role}`;
  const body = [
    `Who: ${row.email}`,
    `Where: ${row.path}`,
    `When: ${new Date().toISOString()}`,
    "",
    row.message,
    "",
    `Commit: ${row.app_commit ?? "unknown"}`,
  ].join("\n");

  try {
    await getNotifyPublisher().publish(subject, body);
  } catch (err) {
    log.warn("feedback_publish_failed", {
      sub: row.sub,
      feedback_id: inserted?.id,
      message: truncate(err instanceof Error ? err.message : String(err)),
    });
  }

  return NextResponse.json({ ok: true, id: inserted?.id }, { status: 200 });
}
