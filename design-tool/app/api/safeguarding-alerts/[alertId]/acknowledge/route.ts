import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import {
  authorizeAssessment,
  invalidIdResponse,
  notFoundResponse,
} from "@/lib/api/access";
import { acknowledgeAlert, loadAlert } from "@/lib/safeguarding/alertQueries";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ alertId: string }>;
}

// Safeguarding alerts slice 2 (docs/safeguarding-alerts-design.md): the
// teacher's Acknowledge — records who and when, and the badge clears.
//
// Access runs THROUGH the alert's assessment at view level: whoever can read
// the results the alert sits on may acknowledge it (a co-teacher included).
// An alert whose assessment has been deleted (D-6 keeps the alert, the FK goes
// null) has no audience left but the admin list, so it is a 404 here, the
// same refusal as an alert that does not exist or is not the caller's.
//
// A system admin on another teacher's assessment is refused (below) — they
// see alerts on /admin/safeguarding but the teacher acknowledges.
//
// Idempotent: a second call returns the first acknowledgement, 200. It does
// not release a withheld AI score — only Score with AI anyway does (D-4).
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { alertId } = await ctx.params;
  if (!UUID_RE.test(alertId)) return invalidIdResponse();

  const db = getDb();
  const alert = await loadAlert(db, alertId);
  if (!alert || !alert.assessment_id) return notFoundResponse();
  const access = await authorizeAssessment(db, auth.session, alert.assessment_id, "view");
  if (!access.ok) return access.response;
  // A system admin resolves view on every assessment (D-7: they read every
  // alert), but acknowledging would clear the TEACHER's badge, and access-model D-6 keeps
  // admin writes outside the admin surface to Act as. So an admin reaching a
  // foreign alert through `"admin"` is refused like a stranger; on their own
  // assessment they are its owner and acknowledge as one.
  if (access.via === "admin") return notFoundResponse();

  const row = await acknowledgeAlert(db, alertId, auth.session);
  if (!row) return notFoundResponse();
  return NextResponse.json({
    ok: true,
    alert: {
      id: row.id,
      acknowledged_at: row.acknowledged_at?.toISOString() ?? null,
      acknowledged_by_email: row.acknowledged_by_email,
    },
  });
}
