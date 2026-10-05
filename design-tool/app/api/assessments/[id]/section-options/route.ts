import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { authorizeAssessment } from "@/lib/api/access";
import { coTeacherEmailsFor } from "@/lib/accommodations/coTeacherRecords";
import { sectionsCurrentlyTaughtBy } from "@/lib/roster/queries";
import { sectionLabel } from "@/lib/roster/teacherRoster";
import { assessmentOwner } from "@/lib/scoring/results";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * U-18 slice 4 (13.9): the class periods the Allowed tab's picker offers —
 * the owner's current sections plus their co-teachers' (they give the test
 * to their own periods), and any configured period that has since left the
 * roster ("no longer on a class list", still removable).
 */
export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "edit");
  if (!access.ok) return access.response;

  const { ownerEmail } = await assessmentOwner(db, id);
  const emails = [...(ownerEmail ? [ownerEmail] : []), ...(await coTeacherEmailsFor(db, access.assessment))];
  const byPs = new Map<string, { ps_id: string; label: string; on_roster: boolean }>();
  for (const email of emails) {
    for (const s of await sectionsCurrentlyTaughtBy(db, email)) {
      if (!byPs.has(s.ps_id)) byPs.set(s.ps_id, { ps_id: s.ps_id, label: sectionLabel(s), on_roster: true });
    }
  }
  const configured = Object.keys(access.assessment.section_accommodations ?? {});
  for (const psId of configured) {
    if (!byPs.has(psId)) byPs.set(psId, { ps_id: psId, label: `Section ${psId}`, on_roster: false });
  }
  const sections = [...byPs.values()]
    .map((s) => ({ ...s, configured: configured.includes(s.ps_id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return NextResponse.json({ sections });
}
