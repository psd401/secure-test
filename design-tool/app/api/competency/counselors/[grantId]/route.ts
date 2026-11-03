import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { notFoundResponse } from "@/lib/api/access";
import { isCompetencyAdmin } from "@/lib/auth/admin";
import { revokeCounselorGrant } from "@/lib/competency/counselors";

interface RouteContext {
  params: Promise<{ grantId: string }>;
}

/**
 * Remove a counselor (slice 6). Only a school-scope `view` grant; anything
 * else, or a grant already revoked, is a 404. Assessment staff only.
 */
export async function DELETE(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { grantId } = await ctx.params;
  if (!UUID_RE.test(grantId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  if (!isCompetencyAdmin(auth.session)) return notFoundResponse();
  if (!(await revokeCounselorGrant(getDb(), grantId))) return notFoundResponse();
  return new NextResponse(null, { status: 204 });
}
