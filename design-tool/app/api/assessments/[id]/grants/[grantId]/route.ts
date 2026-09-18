// Revoke one co-teacher grant (docs/access-model-design.md, D-2), access
// slice 2.
//
// Soft: `revoked_at` is stamped and the row stays as the record of who could
// see this assessment and when. Revoking is the owner's act, so `own`.
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAssessment, notFoundResponse } from "@/lib/api/access";
import { revokeGrant } from "@/lib/api/grants";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string; grantId: string }>;
}

export async function DELETE(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id, grantId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(grantId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "own");
  if (!access.ok) return access.response;

  // Scoped to THIS assessment inside the update, so an owner cannot revoke a
  // grant on somebody else's assessment by pasting its id here. Nothing
  // revoked is the same 404 as a grant that never existed (D-3).
  const revoked = await revokeGrant(db, grantId, {
    scope_kind: "assessment",
    scope_id: id,
  });
  if (!revoked) return notFoundResponse();
  return NextResponse.json({ ok: true, grant: revoked });
}
