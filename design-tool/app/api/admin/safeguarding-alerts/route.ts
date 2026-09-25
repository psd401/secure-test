import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { notFoundResponse } from "@/lib/api/access";
import { isAdmin } from "@/lib/auth/admin";
import { listDistrictAlerts } from "@/lib/safeguarding/alertQueries";
import { parseOpenOnly } from "@/lib/safeguarding/alertView";

// Safeguarding alerts slice 2 (docs/safeguarding-alerts-design.md, D-7): every
// alert in the district, newest first, for the system admin — with the
// assessment's title and owner beside each. `?open=1` = unacknowledged only.
//
// NOT-FOUND FOR A NON-ADMIN, like `/api/grants` and `/api/admin/impersonate`
// (D-3). An impersonated admin is not an admin (`isAdmin` is false while
// `actor_sub` is set), so act-as narrows this away too.
export async function GET(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  if (!isAdmin(auth.session)) return notFoundResponse();

  const openOnly = parseOpenOnly(new URL(req.url).searchParams.get("open"));
  const alerts = await listDistrictAlerts(getDb(), { openOnly });
  return NextResponse.json({ alerts });
}
