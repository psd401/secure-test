import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { authorizeAssessment } from "@/lib/api/access";
import { buildAccommodationsPreview } from "@/lib/accommodations/preview";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * U-16: "who gets what" on this assessment — see
 * lib/accommodations/preview.ts. Read-only; `edit` level, the same as the
 * overrides list it sits beside (both name students and their supports).
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
  return NextResponse.json(await buildAccommodationsPreview(db, access.assessment));
}
