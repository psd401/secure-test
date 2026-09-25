import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { attendanceForSitting } from "@/lib/api/sittingAttendance";
import { UUID_RE } from "@/lib/uuid";
import { authorizeSitting } from "@/lib/api/access";
import { openAlertCountsByAttempt } from "@/lib/safeguarding/alertQueries";

interface RouteContext {
  params: Promise<{ sessionId: string }>;
}

/**
 * Slice 82: who this sitting expects and who has joined or submitted — the
 * metadata half of the teacher monitor (plan Phase 2, "live progress
 * metadata"), served on request rather than pushed. Owner-only, with the
 * same 404-for-not-yours posture as the rest of the sitting routes.
 */
export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const { sessionId } = await ctx.params;
  if (!UUID_RE.test(sessionId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const access = await authorizeSitting(db, auth.session, sessionId, "run");
  if (!access.ok) return access.response;
  const sitting = access.sitting;

  const attendance = await attendanceForSitting(db, sitting);
  // Safeguarding alerts slice 2 (docs/safeguarding-alerts-design.md): each
  // row's OPEN alert count, for the Monitor's "Needs attention" badge.
  // Screening runs after hand-in, so a count appears on a handed-in row at the
  // next poll. Added here rather than in `attendanceForSitting`, whose other
  // callers (the Test sessions tab) have no badge to draw.
  const openAlerts = await openAlertCountsByAttempt(
    db,
    attendance.rows.map((r) => r.attempt_id).filter((v): v is string => !!v),
  );
  return NextResponse.json({
    test_session: {
      id: sitting.id,
      code: sitting.code,
      status: sitting.status,
      expires_at: sitting.expires_at,
      section_ps_id: sitting.section_ps_id,
      student_ps_ids: sitting.student_ps_ids,
    },
    ...attendance,
    rows: attendance.rows.map((r) => ({
      ...r,
      safeguarding_open: r.attempt_id ? (openAlerts.get(r.attempt_id) ?? 0) : 0,
    })),
  });
}
