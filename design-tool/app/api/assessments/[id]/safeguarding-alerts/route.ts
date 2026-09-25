import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAssessment } from "@/lib/api/access";
import { listAssessmentAlerts } from "@/lib/safeguarding/alertQueries";
import { parseOpenOnly } from "@/lib/safeguarding/alertView";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Safeguarding alerts slice 2 (docs/safeguarding-alerts-design.md): the
// assessment's alerts, newest first, with the student named the way the
// results pages name them. View-level — the same audience as the results
// matrix, so a co-teacher who can read the work can read the alert on it.
// `?open=1` = unacknowledged only.
export async function GET(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;

  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "view");
  if (!access.ok) return access.response;

  const openOnly = parseOpenOnly(new URL(req.url).searchParams.get("open"));
  const alerts = await listAssessmentAlerts(db, id, { openOnly });
  return NextResponse.json({ alerts });
}
